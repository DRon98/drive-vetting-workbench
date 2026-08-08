import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  DecisionRecordSchema,
  DecisionScopeSchema,
  PolicyPackSchema,
  type DecisionRecord,
  type DecisionScope,
  type PolicyPack,
} from "@dvw/core";
import { EvidenceStore } from "@dvw/evidence-store-sqlite";
import type { ReasoningSuggestion } from "@dvw/reasoning";
import { z } from "zod";

const JsonValueSchema = z.json();
const NonEmptyStringSchema = z.string().min(1);
const NonEmptyStringArraySchema = z.array(NonEmptyStringSchema).min(1);

export type DecisionJson = z.infer<typeof JsonValueSchema>;

export interface CreateQuestionInput {
  readonly choices: readonly unknown[];
  readonly evidenceIds: readonly string[];
  readonly issueType: string;
  readonly policyLocators: readonly string[];
  readonly policyVersion: string;
  readonly prompt: string;
  readonly relevantEntityIds: readonly string[];
  readonly scope: DecisionScope;
}

export interface MaterialQuestion {
  readonly choices: readonly DecisionJson[];
  readonly evidenceIds: readonly string[];
  readonly issueType: string;
  readonly material: true;
  readonly policyLocators: readonly string[];
  readonly policyVersion: string;
  readonly prompt: string;
  readonly questionKey: string;
  readonly relevantEntityIds: readonly string[];
  readonly scope: DecisionScope;
}

export interface PolicyQuestionSource {
  readonly choices: readonly unknown[];
  readonly key: string;
  readonly policyLocators: readonly string[];
  readonly prompt: string;
  readonly scope: DecisionScope;
}

export interface ReasoningQuestionSource {
  readonly policyVersion: string;
  readonly suggestion: Pick<
    ReasoningSuggestion,
    "reasonCode" | "unresolvedQuestions"
  >;
}

export interface ReasoningQuestionContext {
  readonly policyLocators: readonly string[];
  readonly relevantEntityIds: readonly string[];
  readonly scope: DecisionScope;
}

export type StoredDecision = DecisionRecord & {
  readonly decisionId: string;
  readonly provenance: "HumanDecision";
};

export interface SaveDecisionInput {
  readonly answer: unknown;
  readonly approver: string;
  readonly createdTime: string;
  readonly evidenceIds: readonly string[];
  readonly question: MaterialQuestion;
  readonly supersedesDecisionId?: string | null;
}

export interface LiveEvidenceConflict {
  readonly evidenceIds: readonly string[];
  readonly reasonCode: string;
}

export type QuestionResolution =
  | {
      readonly decision: null;
      readonly reason: "NO_ACTIVE_DECISION";
      readonly shouldAsk: true;
      readonly status: "UNRESOLVED";
    }
  | {
      readonly decision: StoredDecision;
      readonly reason: "ACTIVE_COMPATIBLE_DECISION";
      readonly shouldAsk: false;
      readonly status: "RESOLVED";
    }
  | {
      readonly conflict: LiveEvidenceConflict | null;
      readonly decision: StoredDecision;
      readonly reason:
        | "ANSWER_NO_LONGER_ALLOWED"
        | "LIVE_EVIDENCE_CONFLICT"
        | "POLICY_VERSION_CHANGED";
      readonly shouldAsk: true;
      readonly status: "NEEDS_REVIEW";
    };

export interface PolicyPrecedentQuery {
  readonly key: string;
  readonly policyVersion: string;
  readonly scope: DecisionScope;
}

export type PolicyPrecedentResolution =
  | {
      readonly precedent: null;
      readonly status: "NOT_FOUND" | "POLICY_VERSION_CHANGED";
    }
  | {
      readonly precedent: {
        readonly decision: string;
        readonly key: string;
        readonly policyVersion: string;
        readonly provenance: "Policy";
        readonly scope: DecisionScope;
      };
      readonly status: "MATCHED";
    };

export class DecisionMemoryError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DecisionMemoryError";
  }
}

type SqlRow = Record<string, unknown>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeText(value: string, field: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length === 0) {
    throw new DecisionMemoryError(
      "INVALID_INPUT",
      `${field} must not be empty.`,
    );
  }
  return normalized;
}

function validateDatabasePath(value: string): string {
  if (value.trim().length === 0) {
    throw new DecisionMemoryError(
      "INVALID_INPUT",
      "databasePath must not be empty.",
    );
  }
  return value;
}

function normalizeStrings(
  values: readonly string[],
  field: string,
  minimumLength = 0,
): string[] {
  const normalized = [
    ...new Set(values.map((value) => normalizeText(value, field))),
  ].sort(compareText);
  if (normalized.length < minimumLength) {
    throw new DecisionMemoryError(
      "INVALID_INPUT",
      `${field} must contain at least ${minimumLength} value${minimumLength === 1 ? "" : "s"}.`,
    );
  }
  return normalized;
}

function normalizeJson(
  value: unknown,
  ancestors = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DecisionMemoryError(
        "INVALID_JSON",
        "Decision values must contain finite JSON numbers.",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      ancestors.has(value)
    ) {
      throw new DecisionMemoryError(
        "INVALID_JSON",
        "Decision values must use ordinary acyclic arrays.",
      );
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      throw new DecisionMemoryError(
        "INVALID_JSON",
        "Decision arrays must be dense data arrays.",
      );
    }
    ancestors.add(value);
    try {
      const normalized: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new DecisionMemoryError(
            "INVALID_JSON",
            "Decision arrays must contain data entries only.",
          );
        }
        normalized.push(normalizeJson(descriptor.value, ancestors));
      }
      return normalized;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      ancestors.has(value)
    ) {
      throw new DecisionMemoryError(
        "INVALID_JSON",
        "Decision values must use ordinary acyclic objects.",
      );
    }
    ancestors.add(value);
    try {
      const entries: [string, unknown][] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") {
          throw new DecisionMemoryError(
            "INVALID_JSON",
            "Decision objects cannot contain symbol keys.",
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new DecisionMemoryError(
            "INVALID_JSON",
            "Decision objects must contain data fields only.",
          );
        }
        entries.push([
          key.normalize("NFC"),
          normalizeJson(descriptor.value, ancestors),
        ]);
      }
      entries.sort(([left], [right]) => compareText(left, right));
      if (new Set(entries.map(([key]) => key)).size !== entries.length) {
        throw new DecisionMemoryError(
          "INVALID_JSON",
          "Decision object keys must remain unique after normalization.",
        );
      }
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(value);
    }
  }
  throw new DecisionMemoryError(
    "INVALID_JSON",
    "Decision values must be losslessly JSON-serializable.",
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizedJsonValue(value: unknown): DecisionJson {
  return JsonValueSchema.parse(JSON.parse(canonicalJson(value)) as unknown);
}

function normalizeScope(scope: DecisionScope): DecisionScope {
  const parsed = DecisionScopeSchema.parse(scope);
  return parsed.type === "global"
    ? parsed
    : { id: normalizeText(parsed.id, "scope.id"), type: parsed.type };
}

function scopeKey(scope: DecisionScope): string {
  const normalized = normalizeScope(scope);
  return normalized.type === "global"
    ? "global"
    : `${normalized.type}:${normalized.id}`;
}

function logicalPolicyLocator(locator: string, policyVersion: string): string {
  const normalizedLocator = normalizeText(locator, "policyLocator");
  const normalizedVersion = normalizeText(policyVersion, "policyVersion");
  const versionToken = `:${normalizedVersion}/`;
  return normalizedLocator.includes(versionToken)
    ? normalizedLocator.replace(versionToken, ":{policy-version}/")
    : normalizedLocator;
}

function questionDigest(identity: unknown): string {
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

export function createQuestion(input: CreateQuestionInput): MaterialQuestion {
  const issueType = normalizeText(input.issueType, "issueType");
  const policyVersion = normalizeText(input.policyVersion, "policyVersion");
  const policyLocators = normalizeStrings(
    input.policyLocators,
    "policyLocators",
    1,
  );
  const relevantEntityIds = normalizeStrings(
    input.relevantEntityIds,
    "relevantEntityIds",
  );
  const scope = normalizeScope(input.scope);
  const choices = input.choices.map(normalizedJsonValue);
  const canonicalChoices = choices.map(canonicalJson);
  if (new Set(canonicalChoices).size !== choices.length) {
    throw new DecisionMemoryError(
      "INVALID_INPUT",
      "Question choices must be unique.",
    );
  }
  const evidenceIds = normalizeStrings(input.evidenceIds, "evidenceIds", 1);
  const questionKey = `dq_${questionDigest({
    issueType,
    policyLocations: policyLocators
      .map((locator) => logicalPolicyLocator(locator, policyVersion))
      .sort(compareText),
    relevantEntityIds,
    scope,
  })}`;
  return {
    choices,
    evidenceIds,
    issueType,
    material: true,
    policyLocators,
    policyVersion,
    prompt: normalizeText(input.prompt, "prompt"),
    questionKey,
    relevantEntityIds,
    scope,
  };
}

function normalizeQuestion(question: MaterialQuestion): MaterialQuestion {
  const normalized = createQuestion(question);
  if (question.questionKey !== normalized.questionKey) {
    throw new DecisionMemoryError(
      "INVALID_QUESTION_KEY",
      "The question key does not match its deterministic identity.",
    );
  }
  return normalized;
}

export function createQuestionFromPolicy(input: {
  readonly evidenceIds: readonly string[];
  readonly policyVersion: string;
  readonly question: PolicyQuestionSource;
  readonly relevantEntityIds: readonly string[];
}): MaterialQuestion {
  return createQuestion({
    choices: input.question.choices,
    evidenceIds: input.evidenceIds,
    issueType: input.question.key,
    policyLocators: input.question.policyLocators,
    policyVersion: input.policyVersion,
    prompt: input.question.prompt,
    relevantEntityIds: input.relevantEntityIds,
    scope: input.question.scope,
  });
}

export function createQuestionsFromReasoning(
  source: ReasoningQuestionSource,
  context: ReasoningQuestionContext,
): MaterialQuestion[] {
  return source.suggestion.unresolvedQuestions
    .map((question) =>
      createQuestion({
        choices: [],
        evidenceIds: question.evidenceIds,
        issueType: question.questionKey,
        policyLocators: context.policyLocators,
        policyVersion: source.policyVersion,
        prompt: question.prompt,
        relevantEntityIds: context.relevantEntityIds,
        scope: context.scope,
      }),
    )
    .sort((left, right) => compareText(left.questionKey, right.questionKey));
}

export function selectPolicyPrecedent(
  packInput: PolicyPack,
  query: PolicyPrecedentQuery,
): PolicyPrecedentResolution {
  const pack = PolicyPackSchema.parse(packInput);
  const policyVersion = normalizeText(query.policyVersion, "policyVersion");
  const key = normalizeText(query.key, "key");
  const scope = normalizeScope(query.scope);
  const matched = pack.precedents.find(
    (precedent) =>
      normalizeText(precedent.key, "precedent.key") === key &&
      normalizeText(precedent.scope, "precedent.scope") === scopeKey(scope),
  );
  if (matched === undefined) {
    return { precedent: null, status: "NOT_FOUND" };
  }
  return pack.version === policyVersion
    ? {
        precedent: {
          decision: matched.decision,
          key: matched.key,
          policyVersion: pack.version,
          provenance: "Policy",
          scope,
        },
        status: "MATCHED",
      }
    : { precedent: null, status: "POLICY_VERSION_CHANGED" };
}

function asRow(value: unknown): SqlRow | null {
  return value === undefined ? null : (value as SqlRow);
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new DecisionMemoryError(
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
    throw new DecisionMemoryError(
      "CORRUPT_DATABASE",
      `Expected ${key} to be text or null.`,
    );
  }
  return value;
}

function scopeFromColumns(type: string, id: string | null): DecisionScope {
  return DecisionScopeSchema.parse(
    type === "global" ? { id: null, type } : { id, type },
  );
}

function scopeEqual(left: DecisionScope, right: DecisionScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

function decisionId(record: DecisionRecord): string {
  return `dec_${createHash("sha256")
    .update(canonicalJson(record))
    .digest("hex")}`;
}

function answerAllowed(
  answer: DecisionJson,
  choices: readonly DecisionJson[],
): boolean {
  if (choices.length === 0) return true;
  const identity = canonicalJson(answer);
  return choices.some((choice) => canonicalJson(choice) === identity);
}

export class DecisionMemoryStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    const validatedPath = validateDatabasePath(databasePath);
    const migrator = new EvidenceStore(validatedPath);
    try {
      migrator.migrate();
    } finally {
      migrator.close();
    }
    this.#database = new DatabaseSync(validatedPath);
    this.#database.exec("PRAGMA foreign_keys = ON;");
    this.#database.exec("PRAGMA busy_timeout = 5000;");
  }

  public saveDecision(input: SaveDecisionInput): StoredDecision {
    const question = normalizeQuestion(input.question);
    const answer = normalizedJsonValue(input.answer);
    if (!answerAllowed(answer, question.choices)) {
      throw new DecisionMemoryError(
        "INVALID_ANSWER",
        "The answer is not one of the question's allowed choices.",
      );
    }
    const approver = normalizeText(input.approver, "approver");
    const evidenceIds = normalizeStrings(input.evidenceIds, "evidenceIds", 1);
    if (
      !evidenceIds.some((evidenceId) =>
        question.evidenceIds.includes(evidenceId),
      )
    ) {
      throw new DecisionMemoryError(
        "UNRELATED_EVIDENCE",
        "A decision must cite at least one question evidence ID.",
      );
    }
    const supersedesDecisionId =
      input.supersedesDecisionId === undefined ||
      input.supersedesDecisionId === null
        ? null
        : normalizeText(input.supersedesDecisionId, "supersedesDecisionId");
    const record = DecisionRecordSchema.parse({
      answer,
      approver,
      createdTime: input.createdTime,
      evidenceIds,
      policyVersion: question.policyVersion,
      questionKey: question.questionKey,
      scope: question.scope,
      supersedesDecisionId,
    });
    const stored: StoredDecision = {
      ...record,
      decisionId: decisionId(record),
      provenance: "HumanDecision",
    };

    return this.#withTransaction(() => {
      const active = this.getActiveDecision(question.questionKey);
      if (active !== null && active.decisionId === stored.decisionId) {
        return active;
      }
      if (active === null && supersedesDecisionId !== null) {
        throw new DecisionMemoryError(
          "SUPERSESSION_TARGET_NOT_ACTIVE",
          "A new decision cannot supersede a decision that is not active.",
        );
      }
      if (active !== null && supersedesDecisionId !== active.decisionId) {
        throw new DecisionMemoryError(
          "ACTIVE_DECISION_CONFLICT",
          "A conflicting answer must explicitly supersede the active decision.",
        );
      }
      if (!scopeEqual(stored.scope, question.scope)) {
        throw new DecisionMemoryError(
          "SCOPE_MISMATCH",
          "The decision scope does not match the material question.",
        );
      }
      if (
        active !== null &&
        Date.parse(stored.createdTime) <= Date.parse(active.createdTime)
      ) {
        throw new DecisionMemoryError(
          "INVALID_SUPERSESSION_TIME",
          "A superseding decision must be created after the active decision.",
        );
      }
      if (this.getDecision(stored.decisionId) !== null) {
        throw new DecisionMemoryError(
          "DECISION_ALREADY_SUPERSEDED",
          "The decision already exists in immutable history and is not active.",
        );
      }

      this.#database
        .prepare(
          `INSERT INTO decisions (
             decision_id, question_key, answer_json, approver,
             evidence_ids_json, policy_version, scope_type, scope_id,
             created_time, supersedes_decision_id, provenance
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HumanDecision')`,
        )
        .run(
          stored.decisionId,
          stored.questionKey,
          canonicalJson(stored.answer),
          stored.approver,
          canonicalJson(stored.evidenceIds),
          stored.policyVersion,
          stored.scope.type,
          stored.scope.id,
          stored.createdTime,
          stored.supersedesDecisionId,
        );

      if (active === null) {
        this.#database
          .prepare(
            `INSERT INTO active_decisions (question_key, decision_id)
             VALUES (?, ?)`,
          )
          .run(stored.questionKey, stored.decisionId);
      } else {
        const update = this.#database
          .prepare(
            `UPDATE active_decisions
             SET decision_id = ?
             WHERE question_key = ? AND decision_id = ?`,
          )
          .run(stored.decisionId, stored.questionKey, active.decisionId);
        if (Number(update.changes) !== 1) {
          throw new DecisionMemoryError(
            "ACTIVE_DECISION_CONFLICT",
            "The active decision changed during supersession.",
          );
        }
      }
      return stored;
    });
  }

  public resolveQuestion(
    questionInput: MaterialQuestion,
    options: { readonly liveConflict?: LiveEvidenceConflict } = {},
  ): QuestionResolution {
    const question = normalizeQuestion(questionInput);
    const active = this.getActiveDecision(question.questionKey);
    if (active === null) {
      return {
        decision: null,
        reason: "NO_ACTIVE_DECISION",
        shouldAsk: true,
        status: "UNRESOLVED",
      };
    }
    if (!scopeEqual(active.scope, question.scope)) {
      throw new DecisionMemoryError(
        "CORRUPT_DATABASE",
        "The active decision has an incompatible scope.",
      );
    }
    if (active.policyVersion !== question.policyVersion) {
      return {
        conflict: null,
        decision: active,
        reason: "POLICY_VERSION_CHANGED",
        shouldAsk: true,
        status: "NEEDS_REVIEW",
      };
    }
    if (!answerAllowed(active.answer, question.choices)) {
      return {
        conflict: null,
        decision: active,
        reason: "ANSWER_NO_LONGER_ALLOWED",
        shouldAsk: true,
        status: "NEEDS_REVIEW",
      };
    }
    if (options.liveConflict !== undefined) {
      const conflict: LiveEvidenceConflict = {
        evidenceIds: normalizeStrings(
          options.liveConflict.evidenceIds,
          "liveConflict.evidenceIds",
          1,
        ),
        reasonCode: normalizeText(
          options.liveConflict.reasonCode,
          "liveConflict.reasonCode",
        ),
      };
      return {
        conflict,
        decision: active,
        reason: "LIVE_EVIDENCE_CONFLICT",
        shouldAsk: true,
        status: "NEEDS_REVIEW",
      };
    }
    return {
      decision: active,
      reason: "ACTIVE_COMPATIBLE_DECISION",
      shouldAsk: false,
      status: "RESOLVED",
    };
  }

  public getDecision(decisionIdInput: string): StoredDecision | null {
    const decisionIdValue = normalizeText(decisionIdInput, "decisionId");
    const row = asRow(
      this.#database
        .prepare(
          `SELECT decision_id, question_key, answer_json, approver,
                  evidence_ids_json, policy_version, scope_type, scope_id,
                  created_time, supersedes_decision_id, provenance
           FROM decisions
           WHERE decision_id = ?`,
        )
        .get(decisionIdValue),
    );
    return row === null ? null : this.#decisionFromRow(row);
  }

  public getActiveDecision(questionKeyInput: string): StoredDecision | null {
    const questionKey = normalizeText(questionKeyInput, "questionKey");
    const row = asRow(
      this.#database
        .prepare(
          `SELECT decision.decision_id, decision.question_key,
                  decision.answer_json, decision.approver,
                  decision.evidence_ids_json, decision.policy_version,
                  decision.scope_type, decision.scope_id,
                  decision.created_time, decision.supersedes_decision_id,
                  decision.provenance
           FROM active_decisions AS active
           JOIN decisions AS decision
             ON decision.decision_id = active.decision_id
           WHERE active.question_key = ?`,
        )
        .get(questionKey),
    );
    return row === null ? null : this.#decisionFromRow(row);
  }

  public listDecisionHistory(questionKeyInput: string): StoredDecision[] {
    const questionKey = normalizeText(questionKeyInput, "questionKey");
    const decisions = this.#database
      .prepare(
        `SELECT decision_id, question_key, answer_json, approver,
                evidence_ids_json, policy_version, scope_type, scope_id,
                created_time, supersedes_decision_id, provenance
         FROM decisions
         WHERE question_key = ?
         ORDER BY decision_id`,
      )
      .all(questionKey)
      .map((row) => this.#decisionFromRow(row as SqlRow));
    if (decisions.length === 0) return [];
    const roots = decisions.filter(
      (decision) => decision.supersedesDecisionId === null,
    );
    if (roots.length !== 1) {
      throw new DecisionMemoryError(
        "CORRUPT_DATABASE",
        "Decision history must contain exactly one root.",
      );
    }
    const history: StoredDecision[] = [];
    let current: StoredDecision | undefined = roots[0];
    while (current !== undefined) {
      history.push(current);
      current = decisions.find(
        (decision) =>
          decision.supersedesDecisionId === history.at(-1)?.decisionId,
      );
    }
    if (history.length !== decisions.length) {
      throw new DecisionMemoryError(
        "CORRUPT_DATABASE",
        "Decision history contains a disconnected or cyclic supersession chain.",
      );
    }
    return history;
  }

  public close(): void {
    this.#database.close();
  }

  #decisionFromRow(row: SqlRow): StoredDecision {
    try {
      const scope = scopeFromColumns(
        requiredString(row, "scope_type"),
        nullableString(row, "scope_id"),
      );
      const record = DecisionRecordSchema.parse({
        answer: JSON.parse(requiredString(row, "answer_json")) as unknown,
        approver: requiredString(row, "approver"),
        createdTime: requiredString(row, "created_time"),
        evidenceIds: NonEmptyStringArraySchema.parse(
          JSON.parse(requiredString(row, "evidence_ids_json")) as unknown,
        ),
        policyVersion: requiredString(row, "policy_version"),
        questionKey: requiredString(row, "question_key"),
        scope,
        supersedesDecisionId: nullableString(row, "supersedes_decision_id"),
      });
      if (requiredString(row, "provenance") !== "HumanDecision") {
        throw new Error("Unknown decision provenance.");
      }
      const stored: StoredDecision = {
        ...record,
        decisionId: requiredString(row, "decision_id"),
        provenance: "HumanDecision",
      };
      if (decisionId(record) !== stored.decisionId) {
        throw new Error("Decision identity does not match its record.");
      }
      return stored;
    } catch (error: unknown) {
      if (
        error instanceof DecisionMemoryError &&
        error.code === "CORRUPT_DATABASE"
      ) {
        throw error;
      }
      throw new DecisionMemoryError(
        "CORRUPT_DATABASE",
        "A stored decision failed schema or identity validation.",
      );
    }
  }

  #withTransaction<Result>(operation: () => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      if (typeof result === "object" && result !== null && "then" in result) {
        throw new DecisionMemoryError(
          "ASYNC_TRANSACTION_CALLBACK",
          "Decision transactions must be synchronous.",
        );
      }
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
}
