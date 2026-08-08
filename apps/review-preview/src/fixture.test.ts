import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DriveLab } from "@dvw/drive-simulator";
import { ReviewArtifactInputSchema } from "@dvw/review-artifact";
import { buildReviewFixture } from "./fixture.js";

function fixturePaths() {
  const root = mkdtempSync(join(tmpdir(), "dvw-review-preview-"));
  return {
    artifactRoot: join(root, "artifacts"),
    labRoot: join(root, "lab"),
  };
}

describe("Drive Lab review fixture", () => {
  test("builds the same typed, create-only artifact from the messy-paisano snapshot", () => {
    const paths = fixturePaths();
    const first = buildReviewFixture(paths);
    const repeated = buildReviewFixture(paths);

    expect(repeated).toEqual(first);
    expect(first.scenario).toBe("messy-paisano");
    expect(first.snapshotHash).toBe(
      "50c918e393abd406632c95403e01c2cf859b86e0e334698c0ec23941fc721b06",
    );
    expect(first.input.nodes).toHaveLength(5);
    expect(first.input.plan.actions).toHaveLength(1);
    expect(first.input.plan.actions[0]).toMatchObject({
      targetId: "messy-invoice-draft",
      type: "RENAME",
    });
    expect(first.artifactPath).toContain(first.input.plan.planHash);
    expect(first.artifactPath).toMatch(
      /review-[a-f0-9]{64}-round-1-[a-f0-9]{64}\.html$/u,
    );
    expect(readFileSync(first.artifactPath, "utf8")).toMatch(
      /^<!doctype html>/u,
    );
    expect(ReviewArtifactInputSchema.parse(first.input)).toEqual(first.input);
    expect(DriveLab.open(paths.labRoot).writeCount).toBe(0);
  });
});
