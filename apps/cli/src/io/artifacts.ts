import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ChangePlanSchema, type ChangePlan } from "@dvw/change-planner";
import { DecisionScopeSchema, type DecisionScope } from "@dvw/core";
import type { MaterialQuestion } from "@dvw/decision-memory";
import { z } from "zod";
import { CliUsageError } from "./arguments.js";

const NonEmptyStringSchema = z.string().min(1);
const MaterialQuestionSchema = z.strictObject({
  choices: z.array(z.json()),
  evidenceIds: z.array(NonEmptyStringSchema).min(1),
  issueType: NonEmptyStringSchema,
  material: z.literal(true),
  policyLocators: z.array(NonEmptyStringSchema).min(1),
  policyVersion: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema,
  questionKey: NonEmptyStringSchema,
  relevantEntityIds: z.array(NonEmptyStringSchema),
  scope: DecisionScopeSchema,
});

export const QuestionArtifactSchema = z.strictObject({
  policyVersion: NonEmptyStringSchema,
  questions: z.array(MaterialQuestionSchema),
  scanGeneration: NonEmptyStringSchema,
  version: z.literal(1),
});

export type QuestionArtifact = z.infer<typeof QuestionArtifactSchema>;

export const PlanArtifactSchema = z.strictObject({
  plan: ChangePlanSchema,
  version: z.literal(1),
});

const LedgerEventSchema = z.strictObject({
  createdTime: NonEmptyStringSchema,
  file: z.string().regex(/^(plan|questions)-[a-f0-9]{64}\.json$/u),
  kind: z.enum(["plan", "questions"]),
  version: z.literal(1),
});

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

export class CliArtifactStore {
  readonly #ledgerPath: string;
  readonly #root: string;

  public constructor(root: string) {
    if (root.trim().length === 0)
      throw new CliUsageError("Artifact root is empty.");
    this.#root = resolve(root);
    mkdirSync(this.#root, { mode: 0o700, recursive: true });
    this.#ledgerPath = resolve(this.#root, "artifact-ledger.ndjson");
  }

  public saveQuestions(
    input: {
      readonly policyVersion: string;
      readonly questions: readonly MaterialQuestion[];
      readonly scanGeneration: string;
    },
    createdTime: string,
  ): QuestionArtifact {
    const artifact = QuestionArtifactSchema.parse({ ...input, version: 1 });
    this.#save("questions", artifact, createdTime);
    return artifact;
  }

  public savePlan(plan: ChangePlan, createdTime: string): void {
    const artifact = PlanArtifactSchema.parse({ plan, version: 1 });
    this.#save("plan", artifact, createdTime);
  }

  public loadLatestQuestions(): QuestionArtifact {
    const events = this.#readLedger();
    const event = events.findLast((entry) => entry.kind === "questions");
    if (event === undefined) {
      throw new CliUsageError(
        "Build a plan before listing or answering questions.",
      );
    }
    const path = resolve(this.#root, event.file);
    if (!path.startsWith(`${this.#root}/`)) {
      throw new CliUsageError("Artifact ledger contains an invalid path.");
    }
    return QuestionArtifactSchema.parse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  }

  #save(
    kind: "plan" | "questions",
    artifact: unknown,
    createdTime: string,
  ): void {
    const json = stableJson(artifact);
    const digest = createHash("sha256").update(json).digest("hex");
    const file = `${kind}-${digest}.json`;
    const path = resolve(this.#root, file);
    try {
      writeFileSync(path, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (
        errorCode(error) !== "EEXIST" ||
        readFileSync(path, "utf8") !== json
      ) {
        throw error;
      }
    }
    const event = LedgerEventSchema.parse({
      createdTime,
      file,
      kind,
      version: 1,
    });
    appendFileSync(this.#ledgerPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: 0o600,
    });
  }

  #readLedger(): z.infer<typeof LedgerEventSchema>[] {
    let contents: string;
    try {
      contents = readFileSync(this.#ledgerPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => LedgerEventSchema.parse(JSON.parse(line) as unknown));
  }
}

export function scopeLabel(scope: DecisionScope): string {
  return `${scope.type}:${scope.id ?? "global"}`;
}
