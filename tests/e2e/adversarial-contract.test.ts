import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REQUIRED_CASE_IDS = [
  "apply-twice",
  "bookkeeping-handoff",
  "clipboard-fallback",
  "communications-path-contradiction",
  "cross-deal-reference",
  "frozen-archive",
  "human-drive-lab-loop",
  "invalid-feedback-checksum",
  "invalid-model-output",
  "keyboard-review",
  "later-api-page",
  "malicious-html",
  "messy-folder-tree",
  "missing-permission",
  "mobile-review",
  "offline-render",
  "partial-failure",
  "print-review",
  "protected-data-room",
  "reduced-motion",
  "resume",
  "same-size-different-content",
  "shortcut-cycle",
  "stale-after-approval",
  "stale-feedback",
  "true-duplicate",
  "unknown-action",
  "wrong-entity-alias",
] as const;

interface AdversarialCase {
  readonly expected: string;
  readonly id: string;
  readonly testRef: string;
}

interface AdversarialMatrix {
  readonly cases: readonly AdversarialCase[];
  readonly fixtureData: "synthetic-only";
  readonly network: "forbidden";
  readonly providerMutations: readonly ["rename", "createShortcut"];
  readonly version: "dvw.adversarial.v1";
}

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("T21 adversarial scenario contract", () => {
  test("names every required synthetic scenario and binds it to executable evidence", () => {
    const matrix = JSON.parse(
      readFileSync(
        new URL("../../fixtures/adversarial/scenarios.json", import.meta.url),
        "utf8",
      ),
    ) as AdversarialMatrix;

    expect(matrix).toMatchObject({
      fixtureData: "synthetic-only",
      network: "forbidden",
      providerMutations: ["rename", "createShortcut"],
      version: "dvw.adversarial.v1",
    });
    expect(matrix.cases.map((entry) => entry.id).sort()).toEqual(
      [...REQUIRED_CASE_IDS].sort(),
    );
    expect(new Set(matrix.cases.map((entry) => entry.id)).size).toBe(
      matrix.cases.length,
    );
    for (const scenario of matrix.cases) {
      expect(scenario.expected.length).toBeGreaterThan(0);
      expect(scenario.testRef).toMatch(/^tests\/(?:browser|e2e)\/.+\.ts$/u);
      expect(statSync(`${workspaceRoot}${scenario.testRef}`).isFile()).toBe(
        true,
      );
    }
  });
});
