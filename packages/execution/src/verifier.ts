import type {
  CreateShortcutRequest,
  ObservedItem,
  ProposedAction,
  ReadProvider,
  RenameRequest,
} from "@dvw/core";
import type { ExecutionActionResult } from "./executor.js";
import {
  executionFailure,
  providerExecutionFailure,
  type ExecutionFailure,
} from "./errors.js";
import {
  isExactShortcut,
  listLiveChildren,
  liveItemState,
  readLiveItem,
  type LiveItemState,
} from "./operations.js";

export interface VerifiedActionOutcome {
  readonly after: LiveItemState | null;
  readonly observedItemId: string | null;
  readonly result: ExecutionActionResult;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function sameTextSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return sorted(left).join("\u0000") === sorted(right).join("\u0000");
}

function requestForAction(
  action: ProposedAction,
): CreateShortcutRequest | RenameRequest {
  const desired = asRecord(action.desiredState);
  if (action.type === "RENAME") {
    const preconditions = asRecord(action.preconditions);
    return {
      expectedModifiedTime: preconditions.modifiedTime as string,
      name: desired.name as string,
      targetId: action.targetId,
    };
  }
  return {
    name: desired.name as string,
    parentId: desired.parentId as string,
    targetId: action.targetId,
  };
}

function failureOutcome(
  result: ExecutionActionResult,
  failure: ExecutionFailure,
  before: LiveItemState | null = result.before,
  after: LiveItemState | null = null,
  observedItemId: string | null = null,
): VerifiedActionOutcome {
  return {
    after,
    observedItemId,
    result: {
      ...result,
      before,
      disposition: "Failed",
      failure,
      reason: failure.message,
      verification: "Failed",
    },
  };
}

function readFailure(
  result: ExecutionActionResult,
  itemId: string,
  live: Awaited<ReturnType<typeof readLiveItem>>,
): VerifiedActionOutcome | null {
  if (live.item !== null) return null;
  return failureOutcome(
    result,
    live.error === null
      ? executionFailure(
          "ITEM_MISSING",
          itemId,
          "The live after-state item is missing.",
        )
      : providerExecutionFailure(live.error),
  );
}

function verifiedOutcome(
  result: ExecutionActionResult,
  afterItem: ObservedItem,
  before: LiveItemState | null = result.before,
): VerifiedActionOutcome {
  const after = liveItemState(afterItem);
  return {
    after,
    observedItemId: afterItem.id,
    result: {
      ...result,
      before: before ?? after,
      failure: null,
      verification: "Verified",
    },
  };
}

function renameMatches(
  action: ProposedAction,
  result: ExecutionActionResult,
  live: ObservedItem,
): boolean {
  const desired = asRecord(action.desiredState);
  const expected = asRecord(action.preconditions);
  const expectedPermissions = asRecord(expected.permissions);
  const responseTime = result.providerResponse?.modifiedTime;
  return (
    live.id === action.targetId &&
    live.name === desired.name &&
    sameTextSet(live.parentIds, expected.parentIds as string[]) &&
    live.permissions.canRead === expectedPermissions.canRead &&
    live.permissions.canWrite === expectedPermissions.canWrite &&
    live.shortcutTargetId === expected.shortcutTargetId &&
    live.trashed === expected.trashed &&
    (responseTime === undefined || live.modifiedTime === responseTime)
  );
}

async function verifyRename(
  action: ProposedAction,
  result: ExecutionActionResult,
  provider: ReadProvider,
): Promise<VerifiedActionOutcome> {
  const live = await readLiveItem(provider, action.targetId);
  const failedRead = readFailure(result, action.targetId, live);
  if (failedRead !== null) return failedRead;
  if (live.item === null) throw new TypeError("Validated live item is absent.");
  const state = liveItemState(live.item);
  if (!renameMatches(action, result, live.item)) {
    return failureOutcome(
      result,
      executionFailure(
        "AFTER_STATE_MISMATCH",
        action.targetId,
        "The live rename after-state does not match the approved action.",
      ),
      result.before ?? state,
      state,
      live.item.id,
    );
  }
  return verifiedOutcome(result, live.item);
}

async function verifyShortcut(
  action: ProposedAction,
  result: ExecutionActionResult,
  provider: ReadProvider,
): Promise<VerifiedActionOutcome> {
  const request = requestForAction(action) as CreateShortcutRequest;
  let before = result.before;
  if (before === null) {
    const source = await readLiveItem(provider, action.targetId);
    if (source.item === null) {
      return failureOutcome(
        result,
        source.error === null
          ? executionFailure(
              "ITEM_MISSING",
              action.targetId,
              "The shortcut source is missing during verification.",
            )
          : providerExecutionFailure(source.error),
      );
    }
    before = liveItemState(source.item);
  }
  let shortcutId: string;
  if (result.disposition === "MutationAccepted") {
    const response = result.providerResponse;
    if (response === null) {
      return failureOutcome(
        result,
        executionFailure(
          "AFTER_STATE_MISMATCH",
          null,
          "Shortcut provider success has no result ID.",
        ),
        before,
      );
    }
    shortcutId = response.id;
  } else {
    const children = await listLiveChildren(provider, request.parentId);
    if (children.items === null) {
      return failureOutcome(
        result,
        providerExecutionFailure(children.error),
        before,
      );
    }
    const exact = children.items.find((item) => isExactShortcut(item, request));
    if (exact === undefined) {
      return failureOutcome(
        result,
        executionFailure(
          "AFTER_STATE_MISMATCH",
          request.parentId,
          "The approved shortcut is not present in the live destination.",
        ),
        before,
      );
    }
    shortcutId = exact.id;
  }
  const live = await readLiveItem(provider, shortcutId);
  const failedRead = readFailure(result, shortcutId, live);
  if (failedRead !== null) {
    return { ...failedRead, result: { ...failedRead.result, before } };
  }
  if (live.item === null) throw new TypeError("Validated shortcut is absent.");
  const after = liveItemState(live.item);
  if (
    !isExactShortcut(live.item, request) ||
    live.item.parentIds.length !== 1 ||
    (result.providerResponse !== null &&
      live.item.modifiedTime !== result.providerResponse.modifiedTime)
  ) {
    return failureOutcome(
      result,
      executionFailure(
        "AFTER_STATE_MISMATCH",
        shortcutId,
        "The live shortcut after-state does not match the approved action.",
      ),
      before,
      after,
      shortcutId,
    );
  }
  return verifiedOutcome(result, live.item, before);
}

export async function verifyExecutionAction(input: {
  readonly action: ProposedAction;
  readonly provider: ReadProvider;
  readonly result: ExecutionActionResult;
}): Promise<VerifiedActionOutcome> {
  const result =
    input.result.request === null
      ? { ...input.result, request: requestForAction(input.action) }
      : input.result;
  if (result.disposition === "Failed") {
    return failureOutcome(
      result,
      result.failure ??
        executionFailure(
          "AFTER_STATE_MISMATCH",
          result.targetId,
          "The action failed before live verification.",
        ),
    );
  }
  return input.action.type === "RENAME"
    ? verifyRename(input.action, result, input.provider)
    : verifyShortcut(input.action, result, input.provider);
}

export function pendingNoOpResult(
  action: ProposedAction,
): ExecutionActionResult {
  const request = requestForAction(action);
  return {
    actionId: action.actionId,
    before: null,
    disposition: "NoOp",
    failure: null,
    mutationCalled: false,
    providerResponse: null,
    reason:
      "Verify the previously recorded approved action against live state.",
    request,
    targetId: action.targetId,
    type: action.type as "CREATE_SHORTCUT" | "RENAME",
    verification: "Pending",
  };
}

export async function verifyPlannedAction(input: {
  readonly action: ProposedAction;
  readonly provider: ReadProvider;
}): Promise<VerifiedActionOutcome> {
  return verifyExecutionAction({
    action: input.action,
    provider: input.provider,
    result: pendingNoOpResult(input.action),
  });
}
