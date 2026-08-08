import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  CreateShortcutRequest,
  MutationResult,
  RenameRequest,
} from "@dvw/core";
import type { ExecutionActionResult } from "./executor.js";
import type { LiveItemState } from "./operations.js";

export type ExecutionRunState =
  "Started" | "Running" | "Completed" | "Partial" | "Failed";

export type ExecutionRunEventType =
  | "RunStarted"
  | "ResumeValidated"
  | "ActionVerified"
  | "ActionFailed"
  | "RunCompleted"
  | "RunFailed";

export type ReceiptVerificationStatus = "Verified" | "Failed";

export interface ExecutionRunRecord {
  readonly approvalChecksum: string;
  readonly attempt: number;
  readonly planHash: string;
  readonly providerId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly state: ExecutionRunState;
}

export interface ExecutionEventDetail {
  readonly acceptedMutationCount?: number;
  readonly failureCode?: string | null;
  readonly mutationCallCount?: number;
  readonly priorVerifiedCount?: number;
  readonly receiptCount?: number;
  readonly resumeCursor?: number;
  readonly verificationStatus?: ReceiptVerificationStatus;
}

export interface ExecutionRunEvent {
  readonly actionId: string | null;
  readonly detail: ExecutionEventDetail;
  readonly eventSequence: number;
  readonly eventType: ExecutionRunEventType;
  readonly occurredAt: string;
  readonly runId: string;
  readonly state: ExecutionRunState;
}

export interface RedactedLiveItemState {
  readonly modifiedTime: string;
  readonly nameSha256: string;
  readonly parentIdSha256: readonly string[];
  readonly permissions: {
    readonly canRead: boolean;
    readonly canWrite: boolean;
  };
  readonly shortcutTargetIdSha256: string | null;
  readonly trashed: boolean;
}

export type RedactedRequestSummary =
  | {
      readonly expectedModifiedTime: string;
      readonly nameSha256: string;
      readonly targetIdSha256: string;
      readonly type: "RENAME";
    }
  | {
      readonly nameSha256: string;
      readonly parentIdSha256: string;
      readonly targetIdSha256: string;
      readonly type: "CREATE_SHORTCUT";
    };

export interface RedactedProviderResponseSummary {
  readonly idSha256: string;
  readonly modifiedTime: string;
  readonly nameSha256: string;
  readonly parentIdSha256: readonly string[];
  readonly shortcutTargetIdSha256: string | null;
}

export interface StoredExecutionReceipt {
  readonly actionId: string;
  readonly actionIndex: number;
  readonly actionType: "CREATE_SHORTCUT" | "RENAME";
  readonly afterSummary: RedactedLiveItemState | null;
  readonly beforeSummary: RedactedLiveItemState | null;
  readonly disposition: ExecutionActionResult["disposition"];
  readonly failureCode: string | null;
  readonly observedItemIdSha256: string | null;
  readonly providerResponseSummary: RedactedProviderResponseSummary | null;
  readonly receiptId: number;
  readonly recordedAt: string;
  readonly requestSummary: RedactedRequestSummary | null;
  readonly runId: string;
  readonly targetIdSha256: string;
  readonly verificationStatus: ReceiptVerificationStatus;
}

export interface ExecutionReceiptDraft {
  readonly actionIndex: number;
  readonly after: LiveItemState | null;
  readonly observedItemId: string | null;
  readonly recordedAt: string;
  readonly result: ExecutionActionResult;
}

export interface LatestActionStatus {
  readonly actionId: string;
  readonly verificationStatus: ReceiptVerificationStatus;
}

export class ExecutionLedgerError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionLedgerError";
  }
}

type SqlRow = Record<string, unknown>;

const terminalStates = new Set<ExecutionRunState>([
  "Completed",
  "Partial",
  "Failed",
]);

const transitions: Readonly<
  Record<ExecutionRunState, ReadonlySet<ExecutionRunState>>
> = {
  Completed: new Set(),
  Failed: new Set(),
  Partial: new Set(),
  Running: new Set(["Running", "Completed", "Partial", "Failed"]),
  Started: new Set(["Running", "Failed"]),
};

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ExecutionLedgerError("INVALID_INPUT", `${field} is required.`);
  }
}

function assertIsoDateTime(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ExecutionLedgerError(
      "INVALID_INPUT",
      `${field} must be an ISO date-time.`,
    );
  }
}

function asRow(value: unknown): SqlRow | null {
  return value === undefined ? null : (value as SqlRow);
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new ExecutionLedgerError(
      "CORRUPT_DATABASE",
      `Expected ${key} to be text.`,
    );
  }
  return value;
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ExecutionLedgerError(
      "CORRUPT_DATABASE",
      `Expected ${key} to be text or null.`,
    );
  }
  return value;
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new ExecutionLedgerError(
      "CORRUPT_DATABASE",
      `Expected ${key} to be a number.`,
    );
  }
  return Number(value);
}

function parseJson<Value>(text: string): Value {
  return JSON.parse(text) as Value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactedState(
  state: LiveItemState | null,
): RedactedLiveItemState | null {
  if (state === null) return null;
  return {
    modifiedTime: state.modifiedTime,
    nameSha256: sha256(state.name),
    parentIdSha256: state.parentIds.map(sha256).sort(),
    permissions: { ...state.permissions },
    shortcutTargetIdSha256:
      state.shortcutTargetId === null ? null : sha256(state.shortcutTargetId),
    trashed: state.trashed,
  };
}

function redactedRequest(
  request: CreateShortcutRequest | RenameRequest | null,
  type: "CREATE_SHORTCUT" | "RENAME",
): RedactedRequestSummary | null {
  if (request === null) return null;
  if (type === "RENAME") {
    const rename = request as RenameRequest;
    return {
      expectedModifiedTime: rename.expectedModifiedTime,
      nameSha256: sha256(rename.name),
      targetIdSha256: sha256(rename.targetId),
      type,
    };
  }
  const shortcut = request as CreateShortcutRequest;
  return {
    nameSha256: sha256(shortcut.name),
    parentIdSha256: sha256(shortcut.parentId),
    targetIdSha256: sha256(shortcut.targetId),
    type,
  };
}

function redactedProviderResponse(
  response: MutationResult | null,
): RedactedProviderResponseSummary | null {
  if (response === null) return null;
  return {
    idSha256: sha256(response.id),
    modifiedTime: response.modifiedTime,
    nameSha256: sha256(response.name),
    parentIdSha256: response.parentIds.map(sha256).sort(),
    shortcutTargetIdSha256:
      response.shortcutTargetId === null
        ? null
        : sha256(response.shortcutTargetId),
  };
}

function eventStateForType(
  eventType: ExecutionRunEventType,
  state: ExecutionRunState,
): boolean {
  if (eventType === "RunStarted") return state === "Started";
  if (eventType === "ResumeValidated" || eventType === "ActionVerified") {
    return state === "Running";
  }
  if (eventType === "ActionFailed") {
    return state === "Partial" || state === "Failed";
  }
  if (eventType === "RunCompleted") return state === "Completed";
  return state === "Failed";
}

function validateEventDetail(detail: ExecutionEventDetail): void {
  const numericKeys = new Set([
    "acceptedMutationCount",
    "mutationCallCount",
    "priorVerifiedCount",
    "receiptCount",
    "resumeCursor",
  ]);
  const allowedKeys = new Set([
    ...numericKeys,
    "failureCode",
    "verificationStatus",
  ]);
  for (const [key, value] of Object.entries(detail)) {
    if (!allowedKeys.has(key)) {
      throw new ExecutionLedgerError(
        "INVALID_EVENT_DETAIL",
        `Execution event detail key ${key} is not allowed.`,
      );
    }
    if (
      numericKeys.has(key) &&
      (!Number.isSafeInteger(value) || Number(value) < 0)
    ) {
      throw new ExecutionLedgerError(
        "INVALID_EVENT_DETAIL",
        `Execution event detail ${key} must be a non-negative integer.`,
      );
    }
    if (
      key === "failureCode" &&
      value !== null &&
      (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value))
    ) {
      throw new ExecutionLedgerError(
        "INVALID_EVENT_DETAIL",
        "Execution failure codes must use a bounded uppercase identifier.",
      );
    }
    if (
      key === "verificationStatus" &&
      value !== "Verified" &&
      value !== "Failed"
    ) {
      throw new ExecutionLedgerError(
        "INVALID_EVENT_DETAIL",
        "Execution verification status is invalid.",
      );
    }
  }
}

export class ExecutionLedger {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    assertNonEmpty(databasePath, "databasePath");
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON;");
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    const table = asRow(
      this.#database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_runs'",
        )
        .get(),
    );
    if (table === null) {
      this.#database.close();
      throw new ExecutionLedgerError(
        "MIGRATION_REQUIRED",
        "Execution migration 003_execution must be applied first.",
      );
    }
  }

  public startRun(input: {
    readonly approvalChecksum: string;
    readonly planHash: string;
    readonly providerId: string;
    readonly startedAt: string;
  }): ExecutionRunRecord {
    for (const [field, value] of Object.entries(input)) {
      assertNonEmpty(value, field);
    }
    assertIsoDateTime(input.startedAt, "startedAt");
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const attemptRow = asRow(
        this.#database
          .prepare(
            `SELECT COALESCE(MAX(attempt), 0) AS last_attempt
             FROM execution_runs
             WHERE plan_hash = ? AND approval_checksum = ?`,
          )
          .get(input.planHash, input.approvalChecksum),
      );
      if (attemptRow === null) {
        throw new ExecutionLedgerError(
          "CORRUPT_DATABASE",
          "Execution attempt query returned no row.",
        );
      }
      const attempt = requiredNumber(attemptRow, "last_attempt") + 1;
      const runId = `run_${sha256(
        stableJson({
          approvalChecksum: input.approvalChecksum,
          attempt,
          planHash: input.planHash,
          providerId: input.providerId,
          startedAt: input.startedAt,
        }),
      )}`;
      this.#database
        .prepare(
          `INSERT INTO execution_runs
            (run_id, plan_hash, approval_checksum, provider_id, attempt, started_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          input.planHash,
          input.approvalChecksum,
          input.providerId,
          attempt,
          input.startedAt,
        );
      this.#insertEvent({
        actionId: null,
        detail: {},
        eventType: "RunStarted",
        occurredAt: input.startedAt,
        runId,
        state: "Started",
      });
      this.#database.exec("COMMIT;");
      return {
        approvalChecksum: input.approvalChecksum,
        attempt,
        planHash: input.planHash,
        providerId: input.providerId,
        runId,
        startedAt: input.startedAt,
        state: "Started",
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public appendEvent(input: {
    readonly actionId: string | null;
    readonly detail: ExecutionEventDetail;
    readonly eventType: Exclude<ExecutionRunEventType, "RunStarted">;
    readonly occurredAt: string;
    readonly runId: string;
    readonly state: Exclude<ExecutionRunState, "Started">;
  }): ExecutionRunEvent {
    assertIsoDateTime(input.occurredAt, "occurredAt");
    validateEventDetail(input.detail);
    const current = this.getRun(input.runId);
    if (current === null) {
      throw new ExecutionLedgerError("RUN_NOT_FOUND", "Run was not found.");
    }
    if (
      terminalStates.has(current.state) ||
      !transitions[current.state].has(input.state) ||
      !eventStateForType(input.eventType, input.state)
    ) {
      throw new ExecutionLedgerError(
        "INVALID_TRANSITION",
        `Cannot append ${input.eventType} as ${input.state} after ${current.state}.`,
      );
    }
    return this.#insertEvent(input);
  }

  public appendReceipt(
    runId: string,
    draft: ExecutionReceiptDraft,
  ): StoredExecutionReceipt {
    assertIsoDateTime(draft.recordedAt, "recordedAt");
    const run = this.getRun(runId);
    if (run === null) {
      throw new ExecutionLedgerError("RUN_NOT_FOUND", "Run was not found.");
    }
    if (run.state !== "Running") {
      throw new ExecutionLedgerError(
        "INVALID_TRANSITION",
        `Cannot append a receipt while the run is ${run.state}.`,
      );
    }
    const verificationStatus: ReceiptVerificationStatus =
      draft.result.verification === "Verified" ? "Verified" : "Failed";
    if (draft.result.verification === "Pending") {
      throw new ExecutionLedgerError(
        "UNVERIFIED_RECEIPT",
        "Pending results cannot be stored as receipts.",
      );
    }
    if (verificationStatus === "Verified" && draft.after === null) {
      throw new ExecutionLedgerError(
        "MISSING_AFTER_STATE",
        "Verified receipts require a live after-state.",
      );
    }
    if (verificationStatus === "Verified" && draft.result.before === null) {
      throw new ExecutionLedgerError(
        "MISSING_BEFORE_STATE",
        "Verified receipts require a live before-state.",
      );
    }
    const before = redactedState(draft.result.before);
    const request = redactedRequest(draft.result.request, draft.result.type);
    const providerResponse = redactedProviderResponse(
      draft.result.providerResponse,
    );
    const after = redactedState(draft.after);
    const inserted = this.#database
      .prepare(
        `INSERT INTO execution_receipts (
          run_id, action_id, action_index, action_type, disposition,
          target_id_sha256, observed_item_id_sha256, before_json,
          request_json, provider_response_json, after_json,
          verification_status, failure_code, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING receipt_id`,
      )
      .get(
        runId,
        draft.result.actionId,
        draft.actionIndex,
        draft.result.type,
        draft.result.disposition,
        sha256(draft.result.targetId),
        draft.observedItemId === null ? null : sha256(draft.observedItemId),
        before === null ? null : stableJson(before),
        request === null ? null : stableJson(request),
        providerResponse === null ? null : stableJson(providerResponse),
        after === null ? null : stableJson(after),
        verificationStatus,
        draft.result.failure?.code ?? null,
        draft.recordedAt,
      );
    const row = asRow(inserted);
    if (row === null) {
      throw new ExecutionLedgerError(
        "CORRUPT_DATABASE",
        "Receipt insert returned no row.",
      );
    }
    return {
      actionId: draft.result.actionId,
      actionIndex: draft.actionIndex,
      actionType: draft.result.type,
      afterSummary: after,
      beforeSummary: before,
      disposition: draft.result.disposition,
      failureCode: draft.result.failure?.code ?? null,
      observedItemIdSha256:
        draft.observedItemId === null ? null : sha256(draft.observedItemId),
      providerResponseSummary: providerResponse,
      receiptId: requiredNumber(row, "receipt_id"),
      recordedAt: draft.recordedAt,
      requestSummary: request,
      runId,
      targetIdSha256: sha256(draft.result.targetId),
      verificationStatus,
    };
  }

  public getRun(runId: string): ExecutionRunRecord | null {
    const row = asRow(
      this.#database
        .prepare(
          `SELECT run.run_id, run.plan_hash, run.approval_checksum,
                  run.provider_id, run.attempt, run.started_at, event.state
           FROM execution_runs AS run
           JOIN execution_run_events AS event
             ON event.run_id = run.run_id
           WHERE run.run_id = ?
           ORDER BY event.event_sequence DESC
           LIMIT 1`,
        )
        .get(runId),
    );
    if (row === null) return null;
    return {
      approvalChecksum: requiredString(row, "approval_checksum"),
      attempt: requiredNumber(row, "attempt"),
      planHash: requiredString(row, "plan_hash"),
      providerId: requiredString(row, "provider_id"),
      runId: requiredString(row, "run_id"),
      startedAt: requiredString(row, "started_at"),
      state: requiredString(row, "state") as ExecutionRunState,
    };
  }

  public listRunEvents(runId: string): ExecutionRunEvent[] {
    return this.#database
      .prepare(
        `SELECT run_id, event_sequence, event_type, state, action_id,
                occurred_at, detail_json
         FROM execution_run_events
         WHERE run_id = ?
         ORDER BY event_sequence`,
      )
      .all(runId)
      .map((raw) => {
        const row = raw as SqlRow;
        return {
          actionId: nullableString(row, "action_id"),
          detail: parseJson<ExecutionEventDetail>(
            requiredString(row, "detail_json"),
          ),
          eventSequence: requiredNumber(row, "event_sequence"),
          eventType: requiredString(row, "event_type") as ExecutionRunEventType,
          occurredAt: requiredString(row, "occurred_at"),
          runId: requiredString(row, "run_id"),
          state: requiredString(row, "state") as ExecutionRunState,
        };
      });
  }

  public listReceipts(runId: string): StoredExecutionReceipt[] {
    return this.#database
      .prepare(
        `SELECT receipt_id, run_id, action_id, action_index, action_type,
                disposition, target_id_sha256, observed_item_id_sha256,
                before_json, request_json, provider_response_json, after_json,
                verification_status, failure_code, recorded_at
         FROM execution_receipts
         WHERE run_id = ?
         ORDER BY receipt_id`,
      )
      .all(runId)
      .map((raw) => this.#receiptFromRow(raw as SqlRow));
  }

  public latestActionStatuses(
    planHash: string,
    approvalChecksum: string,
  ): LatestActionStatus[] {
    const latest = new Map<string, ReceiptVerificationStatus>();
    const rows = this.#database
      .prepare(
        `SELECT receipt.action_id, receipt.verification_status
         FROM execution_receipts AS receipt
         JOIN execution_runs AS run ON run.run_id = receipt.run_id
         WHERE run.plan_hash = ? AND run.approval_checksum = ?
         ORDER BY receipt.receipt_id`,
      )
      .all(planHash, approvalChecksum);
    for (const raw of rows) {
      const row = raw as SqlRow;
      latest.set(
        requiredString(row, "action_id"),
        requiredString(row, "verification_status") as ReceiptVerificationStatus,
      );
    }
    return [...latest].map(([actionId, verificationStatus]) => ({
      actionId,
      verificationStatus,
    }));
  }

  public close(): void {
    this.#database.close();
  }

  #insertEvent(input: {
    readonly actionId: string | null;
    readonly detail: ExecutionEventDetail;
    readonly eventType: ExecutionRunEventType;
    readonly occurredAt: string;
    readonly runId: string;
    readonly state: ExecutionRunState;
  }): ExecutionRunEvent {
    const row = asRow(
      this.#database
        .prepare(
          `SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next_sequence
           FROM execution_run_events
           WHERE run_id = ?`,
        )
        .get(input.runId),
    );
    if (row === null) {
      throw new ExecutionLedgerError(
        "CORRUPT_DATABASE",
        "Event sequence query returned no row.",
      );
    }
    const eventSequence = requiredNumber(row, "next_sequence");
    this.#database
      .prepare(
        `INSERT INTO execution_run_events
          (run_id, event_sequence, event_type, state, action_id, occurred_at, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        eventSequence,
        input.eventType,
        input.state,
        input.actionId,
        input.occurredAt,
        stableJson(input.detail),
      );
    return { ...input, eventSequence };
  }

  #receiptFromRow(row: SqlRow): StoredExecutionReceipt {
    const before = nullableString(row, "before_json");
    const request = nullableString(row, "request_json");
    const response = nullableString(row, "provider_response_json");
    const after = nullableString(row, "after_json");
    return {
      actionId: requiredString(row, "action_id"),
      actionIndex: requiredNumber(row, "action_index"),
      actionType: requiredString(
        row,
        "action_type",
      ) as StoredExecutionReceipt["actionType"],
      afterSummary:
        after === null ? null : parseJson<RedactedLiveItemState>(after),
      beforeSummary:
        before === null ? null : parseJson<RedactedLiveItemState>(before),
      disposition: requiredString(
        row,
        "disposition",
      ) as StoredExecutionReceipt["disposition"],
      failureCode: nullableString(row, "failure_code"),
      observedItemIdSha256: nullableString(row, "observed_item_id_sha256"),
      providerResponseSummary:
        response === null
          ? null
          : parseJson<RedactedProviderResponseSummary>(response),
      receiptId: requiredNumber(row, "receipt_id"),
      recordedAt: requiredString(row, "recorded_at"),
      requestSummary:
        request === null ? null : parseJson<RedactedRequestSummary>(request),
      runId: requiredString(row, "run_id"),
      targetIdSha256: requiredString(row, "target_id_sha256"),
      verificationStatus: requiredString(
        row,
        "verification_status",
      ) as ReceiptVerificationStatus,
    };
  }
}
