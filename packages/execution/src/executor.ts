import type { ChangePlan } from "@dvw/change-planner";
import type {
  CreateShortcutRequest,
  MutationProvider,
  MutationResult,
  ObservedItem,
  ProposedAction,
  ReadProvider,
  RenameRequest,
} from "@dvw/core";
import type { ApprovalArtifact } from "./approval.js";
import {
  executionFailure,
  providerExecutionFailure,
  type ExecutionFailure,
} from "./errors.js";
import {
  hasShortcutConflict,
  isExactShortcut,
  isWritableFolder,
  listLiveChildren,
  liveItemState,
  readLiveItem,
  sameLiveItemState,
  type LiveItemState,
} from "./operations.js";
import {
  preflightApprovedPlan,
  type OrderedOperation,
  type PreflightResult,
} from "./preflight.js";

export type ExecutionDisposition = "Failed" | "MutationAccepted" | "NoOp";
export type ExecutionState =
  | "Completed"
  | "Failed"
  | "NoOp"
  | "Partial"
  | "PendingVerification"
  | "Rejected";

export interface ExecutionActionResult {
  readonly actionId: string;
  readonly before: LiveItemState | null;
  readonly disposition: ExecutionDisposition;
  readonly failure: ExecutionFailure | null;
  readonly mutationCalled: boolean;
  readonly providerResponse: MutationResult | null;
  readonly reason: string;
  readonly request: CreateShortcutRequest | RenameRequest | null;
  readonly targetId: string;
  readonly type: "CREATE_SHORTCUT" | "RENAME";
  readonly verification: "Failed" | "Pending" | "Verified";
}

export interface ExecutionResultFinalizerInput {
  readonly action: ProposedAction;
  readonly operation: OrderedOperation;
  readonly result: ExecutionActionResult;
}

export type ExecutionResultFinalizer = (
  input: ExecutionResultFinalizerInput,
) => Promise<ExecutionActionResult>;

export interface ExecuteApprovedPlanResult {
  readonly acceptedMutationCount: number;
  readonly approvalChecksum: string;
  readonly checkedAt: string;
  readonly mutationCallCount: number;
  readonly planHash: string;
  readonly preflight: PreflightResult;
  readonly results: readonly ExecutionActionResult[];
  readonly state: ExecutionState;
  readonly stoppedAtActionId: string | null;
}

export interface ExecuteApprovedPlanInput {
  readonly approval: ApprovalArtifact;
  readonly checkedAt: string;
  readonly finalizeResult?: ExecutionResultFinalizer;
  readonly mutationProvider: MutationProvider;
  readonly plan: ChangePlan;
  readonly readProvider: ReadProvider;
}

async function finalizeResult(
  input: ExecuteApprovedPlanInput,
  action: ProposedAction,
  operation: OrderedOperation,
  result: ExecutionActionResult,
): Promise<ExecutionActionResult> {
  return input.finalizeResult === undefined
    ? result
    : input.finalizeResult({ action, operation, result });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function expectedItemState(value: unknown): LiveItemState {
  const record = asRecord(value);
  const permissions = asRecord(record.permissions);
  return {
    modifiedTime: record.modifiedTime as string,
    name: record.name as string,
    parentIds: record.parentIds as string[],
    permissions: {
      canRead: permissions.canRead as boolean,
      canWrite: permissions.canWrite as boolean,
    },
    shortcutTargetId: record.shortcutTargetId as string | null,
    trashed: record.trashed as boolean,
  };
}

function actionFor(
  plan: ChangePlan,
  operation: OrderedOperation,
): ProposedAction {
  const action = plan.effectiveActions.find(
    (candidate) => candidate.actionId === operation.actionId,
  );
  if (action === undefined) {
    throw new TypeError(`Missing approved action ${operation.actionId}.`);
  }
  return action;
}

function failedResult(
  operation: OrderedOperation,
  failure: ExecutionFailure,
  before: ObservedItem | null,
  mutationCalled = false,
): ExecutionActionResult {
  return {
    actionId: operation.actionId,
    before: before === null ? null : liveItemState(before),
    disposition: "Failed",
    failure,
    mutationCalled,
    providerResponse: null,
    reason: failure.message,
    request: operation.request,
    targetId: operation.targetId,
    type: operation.type,
    verification: "Pending",
  };
}

function noOpResult(
  operation: OrderedOperation,
  before: ObservedItem | null,
  reason = operation.reason,
): ExecutionActionResult {
  return {
    actionId: operation.actionId,
    before: before === null ? null : liveItemState(before),
    disposition: "NoOp",
    failure: null,
    mutationCalled: false,
    providerResponse: null,
    reason,
    request: null,
    targetId: operation.targetId,
    type: operation.type,
    verification: "Pending",
  };
}

function acceptedResult(
  operation: OrderedOperation,
  before: ObservedItem,
  response: MutationResult,
): ExecutionActionResult {
  return {
    actionId: operation.actionId,
    before: liveItemState(before),
    disposition: "MutationAccepted",
    failure: null,
    mutationCalled: true,
    providerResponse: response,
    reason: operation.reason,
    request: operation.request,
    targetId: operation.targetId,
    type: operation.type,
    verification: "Pending",
  };
}

function readFailure(
  operation: OrderedOperation,
  result: Awaited<ReturnType<typeof readLiveItem>>,
): ExecutionActionResult | null {
  if (result.item !== null) return null;
  const failure =
    result.error === null
      ? executionFailure(
          "ITEM_MISSING",
          operation.targetId,
          `Approved stable target ${operation.targetId} is missing.`,
        )
      : providerExecutionFailure(result.error);
  return failedResult(operation, failure, null);
}

function expectedProviderResponse(
  operation: OrderedOperation,
  before: ObservedItem,
  response: MutationResult,
): boolean {
  if (operation.request === null) return false;
  if (operation.type === "RENAME") {
    const request = operation.request as RenameRequest;
    return (
      response.id === request.targetId &&
      response.name === request.name &&
      response.modifiedTime.length > 0 &&
      response.parentIds.length === before.parentIds.length &&
      response.parentIds.every((parentId) =>
        before.parentIds.includes(parentId),
      ) &&
      response.shortcutTargetId === before.shortcutTargetId
    );
  }
  const request = operation.request as CreateShortcutRequest;
  return (
    response.id.length > 0 &&
    response.id !== request.targetId &&
    response.modifiedTime.length > 0 &&
    response.name === request.name &&
    response.parentIds.length === 1 &&
    response.parentIds[0] === request.parentId &&
    response.shortcutTargetId === request.targetId
  );
}

async function executeRename(
  operation: OrderedOperation,
  action: ProposedAction,
  input: ExecuteApprovedPlanInput,
): Promise<ExecutionActionResult> {
  const liveResult = await readLiveItem(input.readProvider, operation.targetId);
  const readError = readFailure(operation, liveResult);
  if (readError !== null) return readError;
  const live = liveResult.item;
  if (live === null) throw new TypeError("Validated live item is absent.");
  const request = operation.request as RenameRequest;
  const expected = expectedItemState(action.preconditions);
  if (!sameLiveItemState(live, expected, { allowName: request.name })) {
    return failedResult(
      operation,
      executionFailure(
        "SOURCE_CHANGED",
        live.id,
        `Target ${live.id} changed after whole-plan preflight.`,
      ),
      live,
    );
  }
  if (live.name === request.name) {
    return noOpResult(
      operation,
      live,
      `Target ${live.id} already has the approved name ${request.name}.`,
    );
  }
  const result = await input.mutationProvider.rename(request);
  if (!result.ok) {
    return failedResult(
      operation,
      providerExecutionFailure(result.error),
      live,
      true,
    );
  }
  if (!expectedProviderResponse(operation, live, result.value)) {
    return {
      ...failedResult(
        operation,
        executionFailure(
          "UNEXPECTED_PROVIDER_RESULT",
          result.value.id,
          "Rename returned an unexpected provider result.",
        ),
        live,
        true,
      ),
      providerResponse: result.value,
    };
  }
  return acceptedResult(operation, live, result.value);
}

async function executeShortcut(
  operation: OrderedOperation,
  action: ProposedAction,
  input: ExecuteApprovedPlanInput,
): Promise<ExecutionActionResult> {
  const request = operation.request as CreateShortcutRequest;
  const sourceResult = await readLiveItem(
    input.readProvider,
    operation.targetId,
  );
  const sourceError = readFailure(operation, sourceResult);
  if (sourceError !== null) return sourceError;
  const source = sourceResult.item;
  if (source === null) throw new TypeError("Validated source is absent.");
  const destinationResult = await readLiveItem(
    input.readProvider,
    request.parentId,
  );
  if (destinationResult.item === null) {
    const failure =
      destinationResult.error === null
        ? executionFailure(
            "ITEM_MISSING",
            request.parentId,
            `Approved destination ${request.parentId} is missing.`,
          )
        : providerExecutionFailure(destinationResult.error);
    return failedResult(operation, failure, source);
  }
  const destination = destinationResult.item;
  const preconditions = asRecord(action.preconditions);
  const expectedSource = expectedItemState(preconditions.source);
  const destinationRecord = asRecord(preconditions.destination);
  const expectedDestination = expectedItemState(
    Object.fromEntries(
      Object.entries(destinationRecord).filter(([key]) => key !== "id"),
    ),
  );
  if (!sameLiveItemState(source, expectedSource)) {
    return failedResult(
      operation,
      executionFailure(
        "SOURCE_CHANGED",
        source.id,
        `Shortcut source ${source.id} changed after whole-plan preflight.`,
      ),
      source,
    );
  }
  if (
    !sameLiveItemState(destination, expectedDestination) ||
    !isWritableFolder(destination)
  ) {
    return failedResult(
      operation,
      executionFailure(
        "DESTINATION_CHANGED",
        destination.id,
        `Shortcut destination ${destination.id} changed after whole-plan preflight.`,
      ),
      source,
    );
  }
  const childrenResult = await listLiveChildren(
    input.readProvider,
    request.parentId,
  );
  if (childrenResult.items === null) {
    return failedResult(
      operation,
      providerExecutionFailure(childrenResult.error),
      source,
    );
  }
  const exact = childrenResult.items.find((item) =>
    isExactShortcut(item, request),
  );
  if (exact !== undefined) {
    return noOpResult(
      operation,
      source,
      `Destination ${request.parentId} already contains the approved shortcut to ${request.targetId}.`,
    );
  }
  const conflict = childrenResult.items.find((item) =>
    hasShortcutConflict(item, request),
  );
  if (conflict !== undefined) {
    return failedResult(
      operation,
      executionFailure(
        "DESTINATION_CHANGED",
        conflict.id,
        `Shortcut destination changed after preflight; conflict ${conflict.id} blocks the write.`,
      ),
      source,
    );
  }
  const result = await input.mutationProvider.createShortcut(request);
  if (!result.ok) {
    return failedResult(
      operation,
      providerExecutionFailure(result.error),
      source,
      true,
    );
  }
  if (!expectedProviderResponse(operation, source, result.value)) {
    return {
      ...failedResult(
        operation,
        executionFailure(
          "UNEXPECTED_PROVIDER_RESULT",
          result.value.id,
          "Shortcut creation returned an unexpected provider result.",
        ),
        source,
        true,
      ),
      providerResponse: result.value,
    };
  }
  return acceptedResult(operation, source, result.value);
}

export async function executeApprovedPlan(
  input: ExecuteApprovedPlanInput,
): Promise<ExecuteApprovedPlanResult> {
  const preflight = await preflightApprovedPlan({
    approval: input.approval,
    checkedAt: input.checkedAt,
    plan: input.plan,
    provider: input.readProvider,
  });
  const base = {
    approvalChecksum: input.approval.checksum,
    checkedAt: input.checkedAt,
    planHash: input.plan.planHash,
    preflight,
  } as const;
  if (preflight.status !== "Ready") {
    return {
      ...base,
      acceptedMutationCount: 0,
      mutationCallCount: 0,
      results: [],
      state: "Rejected",
      stoppedAtActionId: null,
    };
  }
  if (preflight.operations.length === 0) {
    return {
      ...base,
      acceptedMutationCount: 0,
      mutationCallCount: 0,
      results: [],
      state: input.finalizeResult === undefined ? "NoOp" : "Completed",
      stoppedAtActionId: null,
    };
  }
  const results: ExecutionActionResult[] = [];
  let acceptedMutationCount = 0;
  let mutationCallCount = 0;
  for (const operation of preflight.operations) {
    const action = actionFor(input.plan, operation);
    if (operation.disposition === "NoOp") {
      const result = await finalizeResult(
        input,
        action,
        operation,
        noOpResult(operation, null),
      );
      results.push(result);
      if (result.disposition === "Failed") {
        return {
          ...base,
          acceptedMutationCount,
          mutationCallCount,
          results,
          state:
            acceptedMutationCount > 0 || result.providerResponse !== null
              ? "Partial"
              : "Failed",
          stoppedAtActionId: operation.actionId,
        };
      }
      continue;
    }
    const rawResult =
      operation.type === "RENAME"
        ? await executeRename(operation, action, input)
        : await executeShortcut(operation, action, input);
    if (rawResult.mutationCalled) mutationCallCount += 1;
    if (rawResult.disposition === "MutationAccepted") {
      acceptedMutationCount += 1;
    }
    const result = await finalizeResult(input, action, operation, rawResult);
    results.push(result);
    if (result.disposition === "Failed") {
      return {
        ...base,
        acceptedMutationCount,
        mutationCallCount,
        results,
        state:
          acceptedMutationCount > 0 || result.providerResponse !== null
            ? "Partial"
            : "Failed",
        stoppedAtActionId: operation.actionId,
      };
    }
  }
  return {
    ...base,
    acceptedMutationCount,
    mutationCallCount,
    results,
    state:
      input.finalizeResult !== undefined
        ? "Completed"
        : acceptedMutationCount === 0
          ? "NoOp"
          : "PendingVerification",
    stoppedAtActionId: null,
  };
}
