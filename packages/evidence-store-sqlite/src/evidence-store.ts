import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  ObservedItemSchema,
  ScanCoverageSchema,
  type ObservedItem,
  type ScanCoverage,
} from "@dvw/core";

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

export interface GenerationInput {
  generationId: string;
  rootId: string;
  startedAt: string;
}

export interface GenerationRecord extends GenerationInput {
  completedAt: string | null;
  state: "Staging" | "Complete" | "Active" | "Failed" | "Superseded";
}

export interface IndexedItemInput extends ObservedItem {
  contentLocator: string | null;
  extractedSnippet: string | null;
  sizeBytes: number | null;
}

export interface IndexedItem extends IndexedItemInput {
  normalizedName: string;
}

export const RELATION_KINDS = [
  "Parent",
  "Shortcut",
  "Entity",
  "Evidence",
  "Proposal",
  "Receipt",
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

export interface RelationInput {
  generationId: string;
  kind: RelationKind;
  sourceItemId: string;
  sourceLocator: string | null;
  targetId: string;
}

export interface RelationRecord extends RelationInput {
  depth: number;
}

export interface TraverseOptions {
  direction: "inbound" | "outbound";
  kinds?: readonly RelationKind[];
  maxDepth: number;
}

export interface ScanIssue {
  code: string;
  detail: string;
  itemId: string | null;
}

export interface FixtureEvidenceScan {
  coverage: ScanCoverage;
  generation: GenerationInput;
  items: readonly IndexedItemInput[];
  relations?: readonly RelationInput[];
}

export interface ActiveEvidenceSnapshot {
  coverage: ScanCoverage;
  generation: Pick<
    GenerationRecord,
    "generationId" | "rootId" | "startedAt" | "state"
  >;
  issues: ScanIssue[];
  items: IndexedItem[];
  relations: RelationInput[];
}

export class EvidenceStoreError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceStoreError";
  }
}

type SqlRow = Record<string, unknown>;

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new EvidenceStoreError(
      "INVALID_INPUT",
      `${field} must not be empty.`,
    );
  }
}

function assertIsoDateTime(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new EvidenceStoreError(
      "INVALID_INPUT",
      `${field} must be an ISO date-time.`,
    );
  }
}

export function normalizeEvidenceName(name: string): string {
  return name
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

function asRow(value: unknown): SqlRow | null {
  return value === undefined ? null : (value as SqlRow);
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new EvidenceStoreError(
      "CORRUPT_DATABASE",
      `Expected ${key} to be text.`,
    );
  }
  return value;
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new EvidenceStoreError(
      "CORRUPT_DATABASE",
      `Expected ${key} to be text or null.`,
    );
  }
  return value;
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new EvidenceStoreError(
      "CORRUPT_DATABASE",
      `Expected ${key} to be a number.`,
    );
  }
  return Number(value);
}

export class EvidenceStore {
  readonly #database: DatabaseSync;
  #fullTextSearchEnabled = false;
  #transactionDepth = 0;

  public constructor(databasePath: string) {
    assertNonEmpty(databasePath, "databasePath");
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON;");
    this.#database.exec("PRAGMA busy_timeout = 5000;");
  }

  public static rebuildFromFixture(
    databasePath: string,
    fixture: FixtureEvidenceScan,
  ): EvidenceStore {
    const store = new EvidenceStore(databasePath);
    try {
      store.migrate();
      store.withTransaction(() => {
        store.beginGeneration(fixture.generation);
        for (const item of fixture.items) {
          store.stageItem(item);
        }
        for (const relation of fixture.relations ?? []) {
          store.stageRelation(relation);
        }
        store.recordCoverage(fixture.coverage);
        store.publishGeneration(fixture.generation.generationId);
      });
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  public migrate(): MigrationReport {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `);

    const migrationsDirectory = new URL("./migrations/", import.meta.url);
    const names = readdirSync(migrationsDirectory)
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/u.test(name))
      .sort();
    const appliedNames = new Set(
      this.#database
        .prepare("SELECT name FROM schema_migrations ORDER BY name")
        .all()
        .map((row) => String(row.name)),
    );
    const report: MigrationReport = { applied: [], skipped: [] };

    for (const filename of names) {
      const name = filename.slice(0, -4);
      if (appliedNames.has(name)) {
        report.skipped.push(name);
        continue;
      }

      this.withTransaction(() => {
        this.#database.exec(
          readFileSync(new URL(filename, migrationsDirectory), "utf8"),
        );
        this.#database
          .prepare("INSERT INTO schema_migrations (name) VALUES (?)")
          .run(name);
      });
      report.applied.push(name);
    }

    this.#ensureFullTextIndex();
    return report;
  }

  public withTransaction<Result>(operation: () => Result): Result {
    if (this.#transactionDepth > 0) {
      return operation();
    }

    this.#database.exec("BEGIN IMMEDIATE;");
    this.#transactionDepth += 1;
    try {
      const result = operation();
      if (typeof result === "object" && result !== null && "then" in result) {
        throw new EvidenceStoreError(
          "ASYNC_TRANSACTION_CALLBACK",
          "Transaction callbacks must be synchronous.",
        );
      }
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  public beginGeneration(input: GenerationInput): void {
    assertNonEmpty(input.generationId, "generationId");
    assertNonEmpty(input.rootId, "rootId");
    assertIsoDateTime(input.startedAt, "startedAt");
    this.#database
      .prepare(
        `INSERT INTO scan_generations
          (generation_id, root_id, state, started_at, completed_at)
         VALUES (?, ?, 'Staging', ?, NULL)`,
      )
      .run(input.generationId, input.rootId, input.startedAt);
  }

  public stageItem(input: IndexedItemInput): void {
    const { contentLocator, extractedSnippet, sizeBytes, ...observedInput } =
      input;
    const observed = ObservedItemSchema.parse(observedInput);
    if (sizeBytes !== null) {
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new EvidenceStoreError(
          "INVALID_INPUT",
          "sizeBytes must be a non-negative safe integer or null.",
        );
      }
    }
    if (contentLocator !== null) {
      assertNonEmpty(contentLocator, "contentLocator");
    }

    this.withTransaction(() => {
      this.#assertGenerationIsStaging(observed.scanGeneration);
      this.#database
        .prepare(
          `INSERT INTO items (
            generation_id, item_id, name, normalized_name, mime_type,
            created_time, modified_time, permissions_json,
            shortcut_target_id, trashed, content_fingerprint, size_bytes,
            extracted_snippet, content_locator
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          observed.scanGeneration,
          observed.id,
          observed.name,
          normalizeEvidenceName(observed.name),
          observed.mimeType,
          observed.createdTime,
          observed.modifiedTime,
          JSON.stringify(observed.permissions),
          observed.shortcutTargetId,
          observed.trashed ? 1 : 0,
          observed.contentFingerprint,
          sizeBytes,
          extractedSnippet,
          contentLocator,
        );

      for (const parentId of observed.parentIds) {
        this.#insertRelation({
          generationId: observed.scanGeneration,
          kind: "Parent",
          sourceItemId: observed.id,
          sourceLocator: "observed:parentIds",
          targetId: parentId,
        });
      }
      if (observed.shortcutTargetId !== null) {
        this.#insertRelation({
          generationId: observed.scanGeneration,
          kind: "Shortcut",
          sourceItemId: observed.id,
          sourceLocator: "observed:shortcutTargetId",
          targetId: observed.shortcutTargetId,
        });
      }
      if (this.#fullTextSearchEnabled) {
        this.#database
          .prepare(
            `INSERT INTO items_fts
              (generation_id, item_id, name, snippet)
             VALUES (?, ?, ?, ?)`,
          )
          .run(
            observed.scanGeneration,
            observed.id,
            observed.name,
            extractedSnippet ?? "",
          );
      }
    });
  }

  public stageRelation(input: RelationInput): void {
    this.#assertGenerationIsStaging(input.generationId);
    this.#insertRelation(input);
  }

  public recordCoverage(input: ScanCoverage): void {
    const coverage = ScanCoverageSchema.parse(input);
    const generation = this.getGeneration(coverage.generationId);
    if (generation === null) {
      throw new EvidenceStoreError(
        "UNKNOWN_GENERATION",
        `Generation ${coverage.generationId} does not exist.`,
      );
    }
    if (generation.state !== "Staging") {
      throw new EvidenceStoreError(
        "GENERATION_NOT_STAGING",
        `Generation ${coverage.generationId} is ${generation.state}.`,
      );
    }
    if (generation.rootId !== coverage.rootId) {
      throw new EvidenceStoreError(
        "ROOT_MISMATCH",
        "Coverage root does not match the generation root.",
      );
    }

    this.withTransaction(() => {
      this.#database
        .prepare(
          "INSERT INTO scan_coverage (generation_id, coverage_json) VALUES (?, ?)",
        )
        .run(coverage.generationId, JSON.stringify(coverage));
      for (const issue of coverage.deniedItems) {
        this.#insertIssue(coverage.generationId, {
          code: "DENIED_ITEM",
          detail: issue.reason,
          itemId: issue.itemId,
        });
      }
      for (const issue of coverage.unsupportedTypes) {
        this.#insertIssue(coverage.generationId, {
          code: "UNSUPPORTED_TYPE",
          detail: issue.mimeType,
          itemId: issue.itemId,
        });
      }
      for (const warning of coverage.warnings) {
        this.#insertIssue(coverage.generationId, {
          code: "WARNING",
          detail: warning,
          itemId: null,
        });
      }
    });
  }

  public recordIssue(generationId: string, issue: ScanIssue): void {
    this.#assertGenerationIsStaging(generationId);
    this.withTransaction(() => {
      this.#insertIssue(generationId, issue);
    });
  }

  public publishGeneration(generationId: string): void {
    this.withTransaction(() => {
      this.#assertGenerationIsStaging(generationId);
      const coverage = this.#getCoverage(generationId);
      if (coverage === null || coverage.state !== "Complete") {
        throw new EvidenceStoreError(
          "INCOMPLETE_COVERAGE",
          "A generation needs complete coverage before publication.",
        );
      }
      const countRow = asRow(
        this.#database
          .prepare(
            "SELECT COUNT(*) AS item_count FROM items WHERE generation_id = ?",
          )
          .get(generationId),
      );
      const itemCount =
        countRow === null ? 0 : requiredNumber(countRow, "item_count");
      if (itemCount !== coverage.itemCount) {
        throw new EvidenceStoreError(
          "ITEM_COUNT_MISMATCH",
          `Coverage item count ${coverage.itemCount} does not match ${itemCount} staged items.`,
        );
      }

      this.#database
        .prepare(
          `UPDATE scan_generations
           SET state = 'Complete',
               completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE generation_id = ? AND state = 'Staging'`,
        )
        .run(generationId);
      this.#database.exec(`
        UPDATE scan_generations
        SET state = 'Superseded'
        WHERE state = 'Active';
      `);
      this.#database
        .prepare(
          `UPDATE scan_generations
           SET state = 'Active'
           WHERE generation_id = ? AND state = 'Complete'`,
        )
        .run(generationId);
      this.#database
        .prepare(
          `UPDATE active_generation
           SET generation_id = ?
           WHERE singleton = 1`,
        )
        .run(generationId);
    });
  }

  public failGeneration(generationId: string, issue: ScanIssue): void {
    this.withTransaction(() => {
      this.#assertGenerationIsStaging(generationId);
      this.#insertIssue(generationId, issue);
      this.#database
        .prepare(
          `UPDATE scan_generations
           SET state = 'Failed',
               completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE generation_id = ? AND state = 'Staging'`,
        )
        .run(generationId);
    });
  }

  public activeGenerationId(): string | null {
    const row = asRow(
      this.#database
        .prepare(
          "SELECT generation_id FROM active_generation WHERE singleton = 1",
        )
        .get(),
    );
    return row === null ? null : nullableString(row, "generation_id");
  }

  public getGeneration(generationId: string): GenerationRecord | null {
    const row = asRow(
      this.#database
        .prepare(
          `SELECT generation_id, root_id, state, started_at, completed_at
           FROM scan_generations
           WHERE generation_id = ?`,
        )
        .get(generationId),
    );
    if (row === null) {
      return null;
    }
    const state = requiredString(row, "state");
    if (
      state !== "Staging" &&
      state !== "Complete" &&
      state !== "Active" &&
      state !== "Failed" &&
      state !== "Superseded"
    ) {
      throw new EvidenceStoreError(
        "CORRUPT_DATABASE",
        `Unknown generation state ${state}.`,
      );
    }
    return {
      completedAt: nullableString(row, "completed_at"),
      generationId: requiredString(row, "generation_id"),
      rootId: requiredString(row, "root_id"),
      startedAt: requiredString(row, "started_at"),
      state,
    };
  }

  public getActiveItemById(itemId: string): IndexedItem | null {
    const row = asRow(
      this.#database
        .prepare(
          `SELECT i.*
           FROM active_generation AS active
           JOIN items AS i ON i.generation_id = active.generation_id
           WHERE active.singleton = 1 AND i.item_id = ?`,
        )
        .get(itemId),
    );
    return row === null ? null : this.#itemFromRow(row);
  }

  public findActiveItemsByNormalizedName(name: string): IndexedItem[] {
    return this.#database
      .prepare(
        `SELECT i.*
         FROM active_generation AS active
         JOIN items AS i ON i.generation_id = active.generation_id
         WHERE active.singleton = 1 AND i.normalized_name = ?
         ORDER BY i.item_id`,
      )
      .all(normalizeEvidenceName(name))
      .map((row) => this.#itemFromRow(row as SqlRow));
  }

  public listActiveItems(): IndexedItem[] {
    return this.#database
      .prepare(
        `SELECT i.*
         FROM active_generation AS active
         JOIN items AS i ON i.generation_id = active.generation_id
         WHERE active.singleton = 1
         ORDER BY i.item_id`,
      )
      .all()
      .map((row) => this.#itemFromRow(row as SqlRow));
  }

  public traverseActiveRelations(
    startItemId: string,
    options: TraverseOptions,
  ): RelationRecord[] {
    if (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 1) {
      throw new EvidenceStoreError(
        "INVALID_INPUT",
        "maxDepth must be a positive safe integer.",
      );
    }
    const allowedKinds = new Set(options.kinds ?? RELATION_KINDS);
    const generationId = this.activeGenerationId();
    if (generationId === null) {
      return [];
    }
    const rows = this.#database
      .prepare(
        `SELECT generation_id, source_item_id, target_id, kind, source_locator
         FROM relations
         WHERE generation_id = ?
         ORDER BY source_item_id, kind, target_id, source_locator`,
      )
      .all(generationId)
      .map((row) => this.#relationFromRow(row as SqlRow));
    const results: RelationRecord[] = [];
    const seenEdges = new Set<string>();
    const seenNodes = new Set([startItemId]);
    let frontier = [startItemId];

    for (let depth = 1; depth <= options.maxDepth; depth += 1) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const adjacent = rows.filter((relation) =>
          options.direction === "outbound"
            ? relation.sourceItemId === nodeId
            : relation.targetId === nodeId,
        );
        for (const relation of adjacent) {
          if (!allowedKinds.has(relation.kind)) {
            continue;
          }
          const edgeKey = `${relation.sourceItemId}\u0000${relation.kind}\u0000${relation.targetId}\u0000${relation.sourceLocator ?? ""}`;
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            results.push({ ...relation, depth });
          }
          const nextNode =
            options.direction === "outbound"
              ? relation.targetId
              : relation.sourceItemId;
          if (!seenNodes.has(nextNode)) {
            seenNodes.add(nextNode);
            nextFrontier.push(nextNode);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) {
        break;
      }
    }

    return results.sort(
      (left, right) =>
        left.depth - right.depth ||
        left.kind.localeCompare(right.kind) ||
        left.targetId.localeCompare(right.targetId) ||
        left.sourceItemId.localeCompare(right.sourceItemId),
    );
  }

  public supportsFullTextSearch(): boolean {
    return this.#fullTextSearchEnabled;
  }

  public searchActiveItems(query: string): IndexedItem[] {
    const normalizedQuery = normalizeEvidenceName(query);
    if (normalizedQuery.length === 0) {
      return [];
    }
    if (this.#fullTextSearchEnabled) {
      const matchQuery = normalizedQuery
        .split(" ")
        .map((token) => `"${token.replaceAll('"', '""')}"`)
        .join(" AND ");
      return this.#database
        .prepare(
          `SELECT i.*
           FROM items_fts AS search
           JOIN active_generation AS active
             ON active.generation_id = search.generation_id
           JOIN items AS i
             ON i.generation_id = search.generation_id
            AND i.item_id = search.item_id
           WHERE active.singleton = 1 AND items_fts MATCH ?
           ORDER BY bm25(items_fts), i.item_id`,
        )
        .all(matchQuery)
        .map((row) => this.#itemFromRow(row as SqlRow));
    }

    const escaped = normalizedQuery.replace(
      /[\\%_]/gu,
      (value) => `\\${value}`,
    );
    return this.#database
      .prepare(
        `SELECT i.*
         FROM active_generation AS active
         JOIN items AS i ON i.generation_id = active.generation_id
         WHERE active.singleton = 1
           AND i.normalized_name LIKE ? ESCAPE '\\'
         ORDER BY i.item_id`,
      )
      .all(`%${escaped}%`)
      .map((row) => this.#itemFromRow(row as SqlRow));
  }

  public getActiveCoverage(): ScanCoverage | null {
    const generationId = this.activeGenerationId();
    return generationId === null ? null : this.#getCoverage(generationId);
  }

  public listGenerationIssues(generationId: string): ScanIssue[] {
    return this.#database
      .prepare(
        `SELECT code, detail, item_id
         FROM scan_issues
         WHERE generation_id = ?
         ORDER BY issue_id`,
      )
      .all(generationId)
      .map((value) => {
        const row = value as SqlRow;
        return {
          code: requiredString(row, "code"),
          detail: requiredString(row, "detail"),
          itemId: nullableString(row, "item_id"),
        };
      });
  }

  public exportActiveSnapshot(): ActiveEvidenceSnapshot {
    const generationId = this.activeGenerationId();
    if (generationId === null) {
      throw new EvidenceStoreError(
        "NO_ACTIVE_GENERATION",
        "There is no active generation to export.",
      );
    }
    const generation = this.getGeneration(generationId);
    const coverage = this.#getCoverage(generationId);
    if (generation === null || coverage === null) {
      throw new EvidenceStoreError(
        "CORRUPT_DATABASE",
        "The active generation is incomplete.",
      );
    }
    return {
      coverage,
      generation: {
        generationId: generation.generationId,
        rootId: generation.rootId,
        startedAt: generation.startedAt,
        state: generation.state,
      },
      issues: this.listGenerationIssues(generationId),
      items: this.listActiveItems(),
      relations: this.#database
        .prepare(
          `SELECT generation_id, source_item_id, target_id, kind, source_locator
           FROM relations
           WHERE generation_id = ?
           ORDER BY source_item_id, kind, target_id, source_locator`,
        )
        .all(generationId)
        .map((row) => this.#relationFromRow(row as SqlRow)),
    };
  }

  public close(): void {
    this.#database.close();
  }

  #assertGenerationIsStaging(generationId: string): void {
    const generation = this.getGeneration(generationId);
    if (generation === null) {
      throw new EvidenceStoreError(
        "UNKNOWN_GENERATION",
        `Generation ${generationId} does not exist.`,
      );
    }
    if (generation.state !== "Staging") {
      throw new EvidenceStoreError(
        "GENERATION_NOT_STAGING",
        `Generation ${generationId} is ${generation.state}.`,
      );
    }
  }

  #ensureFullTextIndex(): void {
    try {
      this.#database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
          generation_id UNINDEXED,
          item_id UNINDEXED,
          name,
          snippet,
          tokenize = 'unicode61'
        );
      `);
      this.#fullTextSearchEnabled = true;
    } catch {
      this.#fullTextSearchEnabled = false;
    }
  }

  #getCoverage(generationId: string): ScanCoverage | null {
    const row = asRow(
      this.#database
        .prepare(
          "SELECT coverage_json FROM scan_coverage WHERE generation_id = ?",
        )
        .get(generationId),
    );
    if (row === null) {
      return null;
    }
    return ScanCoverageSchema.parse(
      JSON.parse(requiredString(row, "coverage_json")) as unknown,
    );
  }

  #insertIssue(generationId: string, issue: ScanIssue): void {
    assertNonEmpty(issue.code, "issue.code");
    assertNonEmpty(issue.detail, "issue.detail");
    this.#database
      .prepare(
        `INSERT INTO scan_issues (generation_id, code, item_id, detail)
         VALUES (?, ?, ?, ?)`,
      )
      .run(generationId, issue.code, issue.itemId, issue.detail);
  }

  #insertRelation(input: RelationInput): void {
    assertNonEmpty(input.sourceItemId, "sourceItemId");
    assertNonEmpty(input.targetId, "targetId");
    if (!(RELATION_KINDS as readonly string[]).includes(input.kind)) {
      throw new EvidenceStoreError(
        "INVALID_RELATION_KIND",
        `Unknown relation kind ${String(input.kind)}.`,
      );
    }
    if (input.sourceLocator !== null) {
      assertNonEmpty(input.sourceLocator, "sourceLocator");
    }
    this.#database
      .prepare(
        `INSERT INTO relations (
          generation_id, source_item_id, target_id, kind, source_locator
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.generationId,
        input.sourceItemId,
        input.targetId,
        input.kind,
        input.sourceLocator,
      );
  }

  #itemFromRow(row: SqlRow): IndexedItem {
    const observed = ObservedItemSchema.parse({
      contentFingerprint: nullableString(row, "content_fingerprint"),
      createdTime: requiredString(row, "created_time"),
      id: requiredString(row, "item_id"),
      mimeType: requiredString(row, "mime_type"),
      modifiedTime: requiredString(row, "modified_time"),
      name: requiredString(row, "name"),
      parentIds: this.#parentIds(
        requiredString(row, "generation_id"),
        requiredString(row, "item_id"),
      ),
      permissions: JSON.parse(
        requiredString(row, "permissions_json"),
      ) as unknown,
      scanGeneration: requiredString(row, "generation_id"),
      shortcutTargetId: nullableString(row, "shortcut_target_id"),
      trashed: requiredNumber(row, "trashed") === 1,
    });
    const rawSize = row["size_bytes"];
    return {
      ...observed,
      contentLocator: nullableString(row, "content_locator"),
      extractedSnippet: nullableString(row, "extracted_snippet"),
      normalizedName: requiredString(row, "normalized_name"),
      sizeBytes: rawSize === null ? null : Number(rawSize),
    };
  }

  #parentIds(generationId: string, itemId: string): string[] {
    return this.#database
      .prepare(
        `SELECT target_id
         FROM relations
         WHERE generation_id = ? AND source_item_id = ? AND kind = 'Parent'
         ORDER BY target_id`,
      )
      .all(generationId, itemId)
      .map((row) => requiredString(row as SqlRow, "target_id"));
  }

  #relationFromRow(row: SqlRow): RelationInput {
    const kind = requiredString(row, "kind");
    if (!(RELATION_KINDS as readonly string[]).includes(kind)) {
      throw new EvidenceStoreError(
        "CORRUPT_DATABASE",
        `Unknown relation kind ${kind}.`,
      );
    }
    return {
      generationId: requiredString(row, "generation_id"),
      kind: kind as RelationKind,
      sourceItemId: requiredString(row, "source_item_id"),
      sourceLocator: nullableString(row, "source_locator"),
      targetId: requiredString(row, "target_id"),
    };
  }
}
