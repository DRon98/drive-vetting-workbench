import { resolve } from "node:path";
import { buildReviewFixture } from "./fixture.js";

const workspaceRoot = resolve(process.cwd());
const result = buildReviewFixture({
  artifactRoot: resolve(workspaceRoot, "artifacts/local/review"),
  labRoot: resolve(workspaceRoot, "artifacts/local/review-lab"),
});

process.stdout.write(
  `${JSON.stringify(
    {
      artifactPath: result.artifactPath,
      artifactSha256: result.artifactSha256,
      planHash: result.input.plan.planHash,
      reviewRound: result.input.reviewRound,
      scenario: result.scenario,
      snapshotHash: result.snapshotHash,
    },
    null,
    2,
  )}\n`,
);
