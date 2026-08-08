import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewFixture } from "../../apps/review-preview/src/fixture.js";
import {
  createApprovalArtifact,
  parseApprovalArtifact,
  serializeApprovalArtifact,
  validateApprovalForPlan,
} from "@dvw/execution";
import { loadPolicyPack } from "@dvw/policy-engine";
import { describe, expect, test } from "vitest";

function fixturePlan() {
  const root = mkdtempSync(join(tmpdir(), "dvw-security-approval-"));
  return buildReviewFixture({
    artifactRoot: join(root, "artifacts"),
    labRoot: join(root, "lab"),
  }).input.plan;
}

function approval() {
  const plan = fixturePlan();
  const artifact = createApprovalArtifact(plan, {
    approvedAt: "2026-08-08T17:00:00.000Z",
    approver: "Synthetic security operator",
    confirmation: `APPROVE ${plan.planHash}`,
    expiresAt: "2026-08-08T18:00:00.000Z",
  });
  return { artifact, plan };
}

function copyPolicyPack(input: { readonly tamperNaming: boolean }): string {
  const source = join(process.cwd(), "packs", "paisano");
  const destination = mkdtempSync(join(tmpdir(), "dvw-security-policy-"));
  for (const filename of readdirSync(source).sort()) {
    let text = readFileSync(join(source, filename), "utf8");
    if (input.tamperNaming && filename === "naming.json") {
      const value = JSON.parse(text) as { template: string }[];
      const first = value[0];
      if (first === undefined) throw new Error("The policy fixture is empty.");
      first.template = `${first.template} - silently edited`;
      text = `${JSON.stringify(value, null, 2)}\n`;
    }
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    writeFileSync(join(destination, filename), text, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  return destination;
}

describe("approval and policy integrity boundaries", () => {
  test("rejects copied, edited, expired, and plan-mismatched approval artifacts", () => {
    const { artifact, plan } = approval();
    const text = serializeApprovalArtifact(artifact);
    const edited = JSON.parse(text) as Record<string, unknown>;
    edited.approver = "Different operator";
    expect(() => parseApprovalArtifact(JSON.stringify(edited))).toThrow(
      /checksum/u,
    );
    expect(() =>
      validateApprovalForPlan(artifact, plan, {
        now: "2026-08-08T18:00:00.000Z",
      }),
    ).toThrow(/expired/u);

    const action = plan.actions[0];
    if (action === undefined) throw new Error("The plan fixture is empty.");
    const changedPlan = {
      ...plan,
      actions: [
        {
          ...action,
          desiredState: { name: "Different unreviewed name.pdf" },
        },
      ],
    };
    expect(() =>
      validateApprovalForPlan(artifact, changedPlan as never, {
        now: "2026-08-08T17:30:00.000Z",
      }),
    ).toThrow(/canonical|hash|plan/u);
  });

  test("detects a schema-valid edit to a versioned policy section", async () => {
    await expect(
      loadPolicyPack(copyPolicyPack({ tamperNaming: false })),
    ).resolves.toMatchObject({ version: "1.0.0" });
    await expect(
      loadPolicyPack(copyPolicyPack({ tamperNaming: true })),
    ).rejects.toThrow(/integrity/u);
  });
});
