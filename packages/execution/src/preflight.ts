import type { ChangePlan } from "@dvw/change-planner";
import type {
  ObservedItem,
  ProposedAction,
  ReadProvider,
  RenameRequest,
  CreateShortcutRequest,
} from "@dvw/core";
import { type ApprovalArtifact, validateApprovalForPlan } from "./approval.js";
import { providerErrorMessage } from "./errors.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const PAGE_SIZE = 100;

export type PreflightIssueCode =
  | "DESTINATION_NOT_FOLDER"
  | "DUPLICATE_SHORTCUT"
  | "INVALID_ACTION"
  | "ITEM_MISSING"
  | "NAME_COLLISION"
  | "PROVIDER_ERROR"
  | "STALE_DESTINATION"
  | "STALE_MODIFIED_TIME"
  | "STALE_NAME"
  | "STALE_PARENTS"
  | "STALE_PERMISSIONS"
  | "STALE_SHORTCUT_TARGET"
  | "STALE_TRASHED_STATE";

export interface PreflightIssue {
  readonly actionId: string | null;
  readonly code: PreflightIssueCode;
  readonly itemId: string | null;
  readonly message: string;
  readonly path: string;
}

export type ExecutionRequest = RenameRequest | CreateShortcutRequest;

export interface OrderedOperation {
  readonly actionId: string;
  readonly disposition: "NoOp" | "Write";
  readonly reason: string;
  readonly reasonCode: string;
  readonly request: ExecutionRequest | null;
  readonly targetId: string;
  readonly type: "CREATE_SHORTCUT" | "RENAME";
}

export interface PreflightResult {
  readonly approvalChecksum: string;
  readonly checkedAt: string;
  readonly issues: readonly PreflightIssue[];
  readonly operations: readonly OrderedOperation[];
  readonly planHash: string;
  readonly status: "Blocked" | "Ready";
}

export interface PreflightApprovedPlanInput {
  readonly approval: ApprovalArtifact;
  readonly checkedAt: string;
  readonly plan: ChangePlan;
  readonly provider: ReadProvider;
}

interface ItemStatePrecondition {
  readonly modifiedTime: string;
  readonly name: string;
  readonly parentIds: readonly string[];
  readonly permissions: {
    readonly canRead: boolean;
    readonly canWrite: boolean;
  };
  readonly shortcutTargetId: string | null;
  readonly trashed: boolean;
}

interface RenameSpec {
  readonly action: ProposedAction & { readonly type: "RENAME" };
  readonly desiredName: string;
  readonly expected: ItemStatePrecondition;
  readonly kind: "RENAME";
}

interface ShortcutSpec {
  readonly action: ProposedAction & { readonly type: "CREATE_SHORTCUT" };
  readonly desiredName: string;
  readonly destinationId: string;
  readonly expectedDestination: ItemStatePrecondition;
  readonly expectedShortcutIds: readonly string[];
  readonly expectedSource: ItemStatePrecondition;
  readonly kind: "CREATE_SHORTCUT";
}

type ActionSpec = RenameSpec | ShortcutSpec;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    uniqueSorted(left).join("\u0000") === uniqueSorted(right).join("\u0000")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function readItemState(value: unknown): ItemStatePrecondition | null {
  if (!isRecord(value) || !isRecord(value.permissions)) return null;
  const parentIds = value.parentIds;
  if (
    typeof value.modifiedTime !== "string" ||
    typeof value.name !== "string" ||
    !Array.isArray(parentIds) ||
    parentIds.some((entry) => typeof entry !== "string") ||
    typeof value.permissions.canRead !== "boolean" ||
    typeof value.permissions.canWrite !== "boolean" ||
    (value.shortcutTargetId !== null &&
      typeof value.shortcutTargetId !== "string") ||
    typeof value.trashed !== "boolean"
  ) {
    return null;
  }
  return {
    modifiedTime: value.modifiedTime,
    name: value.name,
    parentIds: uniqueSorted(parentIds as string[]),
    permissions: {
      canRead: value.permissions.canRead,
      canWrite: value.permissions.canWrite,
    },
    shortcutTargetId: value.shortcutTargetId,
    trashed: value.trashed,
  };
}

function invalidActionIssue(
  action: ProposedAction,
  message: string,
): PreflightIssue {
  return {
    actionId: action.actionId,
    code: "INVALID_ACTION",
    itemId: action.targetId,
    message,
    path: `plan.actions.${action.actionId}`,
  };
}

function parseActionSpec(
  action: ProposedAction,
):
  | { readonly issue: PreflightIssue; readonly spec: null }
  | { readonly issue: null; readonly spec: ActionSpec } {
  if (action.type === "RENAME") {
    const desiredName = action.desiredState.name;
    const expected = readItemState(action.preconditions);
    if (
      typeof desiredName !== "string" ||
      desiredName.length === 0 ||
      Object.keys(action.desiredState).length !== 1 ||
      expected === null
    ) {
      return {
        issue: invalidActionIssue(
          action,
          "The approved rename action has invalid desired state or preconditions.",
        ),
        spec: null,
      };
    }
    return {
      issue: null,
      spec: {
        action: { ...action, type: "RENAME" },
        desiredName,
        expected,
        kind: "RENAME",
      },
    };
  }
  if (action.type === "CREATE_SHORTCUT") {
    const desiredName = action.desiredState.name;
    const destinationId = action.desiredState.parentId;
    const preconditions = action.preconditions;
    const destination = isRecord(preconditions.destination)
      ? preconditions.destination
      : null;
    const destinationState =
      destination === null
        ? null
        : readItemState(
            Object.fromEntries(
              Object.entries(destination).filter(([key]) => key !== "id"),
            ),
          );
    const expectedSource = readItemState(preconditions.source);
    const expectedShortcutIds = preconditions.existingShortcutIds;
    if (
      typeof desiredName !== "string" ||
      desiredName.length === 0 ||
      typeof destinationId !== "string" ||
      destinationId.length === 0 ||
      Object.keys(action.desiredState).length !== 2 ||
      destination === null ||
      destination.id !== destinationId ||
      destinationState === null ||
      expectedSource === null ||
      !Array.isArray(expectedShortcutIds) ||
      expectedShortcutIds.some((entry) => typeof entry !== "string")
    ) {
      return {
        issue: invalidActionIssue(
          action,
          "The approved shortcut action has invalid desired state or preconditions.",
        ),
        spec: null,
      };
    }
    return {
      issue: null,
      spec: {
        action: { ...action, type: "CREATE_SHORTCUT" },
        desiredName,
        destinationId,
        expectedDestination: destinationState,
        expectedShortcutIds: uniqueSorted(expectedShortcutIds as string[]),
        expectedSource,
        kind: "CREATE_SHORTCUT",
      },
    };
  }
  return {
    issue: invalidActionIssue(
      action,
      `Unsupported effective action type ${action.type}.`,
    ),
    spec: null,
  };
}

function issue(
  code: PreflightIssueCode,
  action: ProposedAction | null,
  itemId: string | null,
  path: string,
  message: string,
): PreflightIssue {
  return {
    actionId: action?.actionId ?? null,
    code,
    itemId,
    message,
    path,
  };
}

function compareItemState(
  action: ProposedAction,
  live: ObservedItem,
  expected: ItemStatePrecondition,
  path: string,
  allowDesiredRename: string | null,
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const isSatisfiedRename =
    allowDesiredRename !== null && live.name === allowDesiredRename;
  if (!isSatisfiedRename && live.modifiedTime !== expected.modifiedTime) {
    issues.push(
      issue(
        "STALE_MODIFIED_TIME",
        action,
        live.id,
        `${path}.modifiedTime`,
        `Item ${live.id} changed after the approved scan.`,
      ),
    );
  }
  if (!isSatisfiedRename && live.name !== expected.name) {
    issues.push(
      issue(
        "STALE_NAME",
        action,
        live.id,
        `${path}.name`,
        `Item ${live.id} no longer has the approved source name.`,
      ),
    );
  }
  if (!equalStrings(live.parentIds, expected.parentIds)) {
    issues.push(
      issue(
        "STALE_PARENTS",
        action,
        live.id,
        `${path}.parentIds`,
        `Item ${live.id} no longer has the approved parents.`,
      ),
    );
  }
  if (
    live.permissions.canRead !== expected.permissions.canRead ||
    live.permissions.canWrite !== expected.permissions.canWrite
  ) {
    issues.push(
      issue(
        "STALE_PERMISSIONS",
        action,
        live.id,
        `${path}.permissions`,
        `Item ${live.id} no longer has the approved permission summary.`,
      ),
    );
  }
  if (live.shortcutTargetId !== expected.shortcutTargetId) {
    issues.push(
      issue(
        "STALE_SHORTCUT_TARGET",
        action,
        live.id,
        `${path}.shortcutTargetId`,
        `Item ${live.id} no longer has the approved shortcut target.`,
      ),
    );
  }
  if (live.trashed !== expected.trashed) {
    issues.push(
      issue(
        "STALE_TRASHED_STATE",
        action,
        live.id,
        `${path}.trashed`,
        `Item ${live.id} no longer has the approved trash state.`,
      ),
    );
  }
  return issues;
}

function normalizeName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function sortIssues(issues: readonly PreflightIssue[]): PreflightIssue[] {
  return [...issues].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.actionId ?? "", right.actionId ?? "") ||
      compareText(left.itemId ?? "", right.itemId ?? "") ||
      compareText(left.path, right.path),
  );
}

async function readItems(
  provider: ReadProvider,
  ids: readonly string[],
  actionsByItemId: ReadonlyMap<string, ProposedAction>,
  issues: PreflightIssue[],
): Promise<Map<string, ObservedItem>> {
  const live = new Map<string, ObservedItem>();
  for (const itemId of uniqueSorted(ids)) {
    const action = actionsByItemId.get(itemId) ?? null;
    const result = await provider.getItem(itemId);
    if (!result.ok) {
      issues.push(
        issue(
          "PROVIDER_ERROR",
          action,
          itemId,
          `provider.getItem.${itemId}`,
          providerErrorMessage(result.error),
        ),
      );
      continue;
    }
    if (result.value === null) {
      issues.push(
        issue(
          "ITEM_MISSING",
          action,
          itemId,
          `provider.getItem.${itemId}`,
          `Approved item ${itemId} is missing.`,
        ),
      );
      continue;
    }
    live.set(itemId, result.value);
  }
  return live;
}

async function listAllChildren(
  provider: ReadProvider,
  parentId: string,
  action: ProposedAction,
  issues: PreflightIssue[],
): Promise<readonly ObservedItem[] | null> {
  const items: ObservedItem[] = [];
  const consumed = new Set<string>();
  let pageToken: string | null = null;
  do {
    const result = await provider.listItems({
      pageSize: PAGE_SIZE,
      pageToken,
      rootId: parentId,
      supportsAllDrives: true,
    });
    if (!result.ok) {
      issues.push(
        issue(
          "PROVIDER_ERROR",
          action,
          parentId,
          `provider.listItems.${parentId}`,
          providerErrorMessage(result.error),
        ),
      );
      return null;
    }
    items.push(...result.value.items);
    const next = result.value.nextPageToken;
    if (next !== null && consumed.has(next)) {
      issues.push(
        issue(
          "PROVIDER_ERROR",
          action,
          parentId,
          `provider.listItems.${parentId}.nextPageToken`,
          `Provider repeated page token ${next}.`,
        ),
      );
      return null;
    }
    if (next !== null) consumed.add(next);
    pageToken = next;
  } while (pageToken !== null);
  return items;
}

function operationForRename(
  spec: RenameSpec,
  live: ObservedItem,
): OrderedOperation {
  if (live.name === spec.desiredName) {
    return {
      actionId: spec.action.actionId,
      disposition: "NoOp",
      reason: `Target ${live.id} already has the approved name ${spec.desiredName}.`,
      reasonCode: spec.action.reasonCode,
      request: null,
      targetId: live.id,
      type: "RENAME",
    };
  }
  return {
    actionId: spec.action.actionId,
    disposition: "Write",
    reason: `Rename ${live.id} to ${spec.desiredName} because ${spec.action.reasonCode}.`,
    reasonCode: spec.action.reasonCode,
    request: {
      expectedModifiedTime: live.modifiedTime,
      name: spec.desiredName,
      targetId: live.id,
    },
    targetId: live.id,
    type: "RENAME",
  };
}

function operationForShortcut(
  spec: ShortcutSpec,
  isNoOp: boolean,
): OrderedOperation {
  if (isNoOp) {
    return {
      actionId: spec.action.actionId,
      disposition: "NoOp",
      reason: `Destination ${spec.destinationId} already contains the approved shortcut to ${spec.action.targetId}.`,
      reasonCode: spec.action.reasonCode,
      request: null,
      targetId: spec.action.targetId,
      type: "CREATE_SHORTCUT",
    };
  }
  return {
    actionId: spec.action.actionId,
    disposition: "Write",
    reason: `Create a shortcut for ${spec.action.targetId} in ${spec.destinationId} because ${spec.action.reasonCode}.`,
    reasonCode: spec.action.reasonCode,
    request: {
      name: spec.desiredName,
      parentId: spec.destinationId,
      targetId: spec.action.targetId,
    },
    targetId: spec.action.targetId,
    type: "CREATE_SHORTCUT",
  };
}

export function buildOrderedOperations(
  specs: readonly ActionSpec[],
  liveItems: ReadonlyMap<string, ObservedItem>,
  shortcutNoOps: ReadonlySet<string>,
): OrderedOperation[] {
  return specs.flatMap((spec) => {
    const live = liveItems.get(spec.action.targetId);
    if (live === undefined) return [];
    return spec.kind === "RENAME"
      ? [operationForRename(spec, live)]
      : [operationForShortcut(spec, shortcutNoOps.has(spec.action.actionId))];
  });
}

export async function preflightApprovedPlan(
  input: PreflightApprovedPlanInput,
): Promise<PreflightResult> {
  const approval = validateApprovalForPlan(input.approval, input.plan, {
    now: input.checkedAt,
  });
  const issues: PreflightIssue[] = [];
  const parsed = input.plan.effectiveActions.map(parseActionSpec);
  for (const entry of parsed) {
    if (entry.issue !== null) issues.push(entry.issue);
  }
  const specs = parsed.flatMap((entry) =>
    entry.spec === null ? [] : [entry.spec],
  );
  if (issues.length > 0) {
    return {
      approvalChecksum: approval.checksum,
      checkedAt: input.checkedAt,
      issues: sortIssues(issues),
      operations: [],
      planHash: input.plan.planHash,
      status: "Blocked",
    };
  }

  const actionsByItemId = new Map<string, ProposedAction>();
  const ids: string[] = [];
  for (const spec of specs) {
    ids.push(spec.action.targetId);
    actionsByItemId.set(spec.action.targetId, spec.action);
    if (spec.kind === "CREATE_SHORTCUT") {
      ids.push(spec.destinationId, ...spec.expectedShortcutIds);
      actionsByItemId.set(spec.destinationId, spec.action);
      for (const shortcutId of spec.expectedShortcutIds) {
        actionsByItemId.set(shortcutId, spec.action);
      }
    }
  }
  const liveItems = await readItems(
    input.provider,
    ids,
    actionsByItemId,
    issues,
  );
  const childrenByParent = new Map<string, readonly ObservedItem[]>();
  for (const spec of specs) {
    if (spec.kind === "RENAME") {
      const live = liveItems.get(spec.action.targetId);
      if (live === undefined) continue;
      issues.push(
        ...compareItemState(
          spec.action,
          live,
          spec.expected,
          `actions.${spec.action.actionId}.target`,
          spec.desiredName,
        ),
      );
      if (!equalStrings(live.parentIds, spec.expected.parentIds)) continue;
      for (const parentId of uniqueSorted(live.parentIds)) {
        if (!childrenByParent.has(parentId)) {
          const children = await listAllChildren(
            input.provider,
            parentId,
            spec.action,
            issues,
          );
          if (children !== null) childrenByParent.set(parentId, children);
        }
        const collision = childrenByParent
          .get(parentId)
          ?.find(
            (candidate) =>
              candidate.id !== live.id &&
              !candidate.trashed &&
              candidate.parentIds.includes(parentId) &&
              normalizeName(candidate.name) === normalizeName(spec.desiredName),
          );
        if (collision !== undefined) {
          issues.push(
            issue(
              "NAME_COLLISION",
              spec.action,
              collision.id,
              `actions.${spec.action.actionId}.desiredState.name`,
              `Approved name ${spec.desiredName} collides with ${collision.id} in ${parentId}.`,
            ),
          );
        }
      }
      continue;
    }

    const source = liveItems.get(spec.action.targetId);
    const destinationItem = liveItems.get(spec.destinationId);
    if (source !== undefined) {
      issues.push(
        ...compareItemState(
          spec.action,
          source,
          spec.expectedSource,
          `actions.${spec.action.actionId}.source`,
          null,
        ),
      );
    }
    if (destinationItem !== undefined) {
      issues.push(
        ...compareItemState(
          spec.action,
          destinationItem,
          spec.expectedDestination,
          `actions.${spec.action.actionId}.destination`,
          null,
        ).map((entry) => ({ ...entry, code: "STALE_DESTINATION" as const })),
      );
      if (destinationItem.mimeType !== FOLDER_MIME_TYPE) {
        issues.push(
          issue(
            "DESTINATION_NOT_FOLDER",
            spec.action,
            destinationItem.id,
            `actions.${spec.action.actionId}.destination.mimeType`,
            `Shortcut destination ${destinationItem.id} is not a live folder.`,
          ),
        );
      }
    }
    for (const shortcutId of spec.expectedShortcutIds) {
      const shortcut = liveItems.get(shortcutId);
      if (
        shortcut !== undefined &&
        (shortcut.mimeType !== SHORTCUT_MIME_TYPE ||
          shortcut.shortcutTargetId !== spec.action.targetId ||
          shortcut.trashed)
      ) {
        issues.push(
          issue(
            "STALE_SHORTCUT_TARGET",
            spec.action,
            shortcutId,
            `actions.${spec.action.actionId}.existingShortcutIds`,
            `Expected shortcut ${shortcutId} no longer points to ${spec.action.targetId}.`,
          ),
        );
      }
    }
    if (!childrenByParent.has(spec.destinationId)) {
      const children = await listAllChildren(
        input.provider,
        spec.destinationId,
        spec.action,
        issues,
      );
      if (children !== null) {
        childrenByParent.set(spec.destinationId, children);
      }
    }
  }

  const shortcutNoOps = new Set<string>();
  for (const spec of specs) {
    if (spec.kind !== "CREATE_SHORTCUT") continue;
    const scopedItems = childrenByParent.get(spec.destinationId);
    if (scopedItems === undefined) continue;
    const children = scopedItems.filter((candidate) =>
      candidate.parentIds.includes(spec.destinationId),
    );
    const exact = children.find(
      (candidate) =>
        !candidate.trashed &&
        candidate.mimeType === SHORTCUT_MIME_TYPE &&
        candidate.shortcutTargetId === spec.action.targetId &&
        normalizeName(candidate.name) === normalizeName(spec.desiredName),
    );
    if (exact !== undefined) {
      shortcutNoOps.add(spec.action.actionId);
      continue;
    }
    const duplicateShortcut = children.find(
      (candidate) =>
        !candidate.trashed &&
        candidate.mimeType === SHORTCUT_MIME_TYPE &&
        candidate.shortcutTargetId === spec.action.targetId,
    );
    if (duplicateShortcut !== undefined) {
      issues.push(
        issue(
          "DUPLICATE_SHORTCUT",
          spec.action,
          duplicateShortcut.id,
          `actions.${spec.action.actionId}.desiredState`,
          `Destination ${spec.destinationId} already contains a different shortcut to ${spec.action.targetId}.`,
        ),
      );
    }
    const nameCollision = children.find(
      (candidate) =>
        !candidate.trashed &&
        normalizeName(candidate.name) === normalizeName(spec.desiredName),
    );
    if (nameCollision !== undefined) {
      issues.push(
        issue(
          "NAME_COLLISION",
          spec.action,
          nameCollision.id,
          `actions.${spec.action.actionId}.desiredState.name`,
          `Approved shortcut name ${spec.desiredName} collides with ${nameCollision.id} in ${spec.destinationId}.`,
        ),
      );
    }
  }

  const sortedIssues = sortIssues(issues);
  return {
    approvalChecksum: approval.checksum,
    checkedAt: input.checkedAt,
    issues: sortedIssues,
    operations: buildOrderedOperations(specs, liveItems, shortcutNoOps),
    planHash: input.plan.planHash,
    status: sortedIssues.length === 0 ? "Ready" : "Blocked",
  };
}
