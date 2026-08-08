import { createHash } from "node:crypto";
import {
  CliOutputSchema,
  type CliOutput,
  type CliRunResult,
} from "./contracts.js";

function safeText(value: string, maxLength = 160): string {
  const withoutControls = [...value.normalize("NFC")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159)
        ? " "
        : character;
    })
    .join("");
  const clean = withoutControls.replace(/\s+/gu, " ").trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}…`;
}

function redactedId(value: string): string {
  return `id_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function contextLine(output: Exclude<CliOutput, { command: "error" }>): string {
  if (output.command === "lab") {
    return `Drive Lab ${safeText(output.data.scenario)} · snapshot ${output.data.snapshotHash.slice(0, 12)}`;
  }
  if (output.command === "pilot") {
    return `Pilot ${output.data.operation} · policy ${safeText(output.policyVersion)}`;
  }
  return `Scan ${redactedId(output.scanGeneration)} · policy ${safeText(output.policyVersion)}`;
}

export function renderHuman(output: CliOutput): string {
  if (output.command === "error") {
    return `Command failed (${output.data.code}). ${safeText(output.data.message)}`;
  }
  const lines = [contextLine(output)];
  if (output.command === "pilot") {
    if (output.data.operation === "preflight") {
      lines.push(
        `Preflight ${output.data.result.status.toLowerCase()} for ${output.data.result.requestedGate}.`,
        "Provider access: 0. Token reads: 0.",
      );
      for (const blocker of output.data.result.blockers) {
        lines.push(`- ${blocker.code}: ${safeText(blocker.message, 240)}`);
      }
      if (output.data.result.nextCorrectiveAction !== null) {
        lines.push(
          `Next action: ${safeText(output.data.result.nextCorrectiveAction, 240)}`,
        );
      }
    } else {
      lines.push(
        `Scorecard ${output.data.artifactSha256.slice(0, 12)} records ${output.data.scorecard.metrics.coverage.percent}% visible coverage.`,
        `${output.data.scorecard.metrics.writeVerification.percent}% of attempted writes were verified; second-run writes: ${output.data.scorecard.metrics.idempotency.secondRunWrites}.`,
        output.data.scorecard.expansion.allowed
          ? "The synthetic rehearsal meets its expansion thresholds."
          : `Stop at ${output.data.scorecard.expansion.blockedAtGate ?? "the safety gate"}.`,
        `Scorecard is create-only at ${safeText(output.data.artifactPath, 240)}.`,
        "The real pilot still needs Buck's OAuth consent and one selected folder.",
      );
    }
  } else if (output.command === "scan") {
    lines.push(
      `Scanned ${output.data.itemCount} items in ${output.data.pageCount} pages.`,
      output.status === "COVERAGE_GAP"
        ? `Review ${output.data.issueCount} coverage gaps.`
        : "Coverage is complete for the selected fixture scope.",
    );
  } else if (output.command === "inventory") {
    lines.push(
      `${output.data.itemCount} items · ${output.data.shortcutCount} shortcuts · ${output.data.deniedItemCount} denied.`,
    );
    for (const item of output.data.items) {
      lines.push(`- ${safeText(item.name)} (${redactedId(item.id)})`);
    }
  } else if (output.command === "plan") {
    lines.push(
      `Plan ${output.data.planHash.slice(0, 12)} has ${output.data.actionCount} actions and ${output.data.blockers.length} blockers.`,
    );
    for (const action of output.data.actions) {
      lines.push(`- ${action.type} ${redactedId(action.targetId)}`);
    }
  } else if (output.command === "questions") {
    lines.push(
      `${output.data.questionCount} material questions need an answer.`,
    );
    for (const question of output.data.questions) {
      lines.push(
        `- ${safeText(question.prompt)} (${redactedId(question.questionKey)})`,
      );
    }
  } else if (output.command === "decide") {
    lines.push(
      `Saved human decision ${redactedId(output.data.decisionId)} for ${redactedId(output.data.questionKey)}.`,
    );
  } else if (output.command === "review") {
    lines.push(
      `Generated offline review ${output.data.planHash.slice(0, 12)} round ${output.data.reviewRound}.`,
      `Artifact ${output.data.artifactSha256.slice(0, 12)} is create-only at ${safeText(output.data.artifactPath, 240)}.`,
    );
  } else if (output.command === "feedback") {
    lines.push(
      `Imported feedback ${output.data.importedChecksum.slice(0, 12)} without approval.`,
      `Plan ${output.data.sourcePlanHash.slice(0, 12)} → ${output.data.nextPlanHash.slice(0, 12)} · review round ${output.data.sourceReviewRound} → ${output.data.nextReviewRound}.`,
      `Regenerated artifact ${output.data.artifactSha256.slice(0, 12)} is create-only at ${safeText(output.data.artifactPath, 240)}.`,
    );
  } else if (output.command === "approve") {
    lines.push(
      `Approved exact plan ${output.data.planHash.slice(0, 12)} as ${safeText(output.data.approver)}.`,
      `Approval ${output.data.approvalChecksum.slice(0, 12)} is create-only at ${safeText(output.data.artifactPath, 240)}.`,
    );
  } else if (output.command === "dry-run") {
    lines.push(
      `Dry-run found ${output.data.operationCount} ordered operations and ${output.data.issueCount} blockers.`,
      "Provider writes: 0.",
    );
    for (const operation of output.data.operations) {
      lines.push(
        `- ${operation.disposition} ${operation.type} ${redactedId(operation.targetId)}: ${safeText(operation.reason, 240)}`,
      );
    }
  } else if (output.command === "apply") {
    lines.push(
      `Apply state: ${output.data.state}. Accepted provider mutations: ${output.data.acceptedMutationCount}.`,
      `Stored ${output.data.receiptCount} append-only receipts after live verification.`,
    );
    for (const result of output.data.results) {
      lines.push(
        `- ${result.disposition} ${result.type} ${redactedId(result.targetId)} · verification ${result.verification}`,
      );
    }
  } else if (output.command === "verify") {
    lines.push(
      `Verified run ${output.data.runId.slice(0, 16)} against live state.`,
      `${output.data.verifiedActionCount} actions verified; ${output.data.failedActionCount} failed.`,
    );
    for (const result of output.data.results) {
      lines.push(
        `- ${result.liveStatus} ${redactedId(result.actionId)} · receipt ${result.receiptStatus ?? "Missing"}`,
      );
    }
  } else if (output.data.operation === "tree") {
    lines.push(`${output.data.entries.length} nodes in the current lab tree.`);
    for (const entry of output.data.entries) {
      const shortcut =
        entry.shortcutTargetId === null
          ? ""
          : ` -> ${redactedId(entry.shortcutTargetId)}`;
      lines.push(
        `${"  ".repeat(entry.depth)}- ${safeText(entry.name)} (${redactedId(entry.id)})${shortcut}`,
      );
    }
  } else if (
    output.data.operation === "diff" ||
    output.data.operation === "edit"
  ) {
    const changedLabel = output.data.entries.length === 1 ? "item" : "items";
    lines.push(
      `${output.data.operation === "edit" ? "Applied one explicit lab edit" : "Compared the lab snapshot"}; ${output.data.entries.length} ${changedLabel} changed.`,
    );
    for (const entry of output.data.entries) {
      lines.push(`- ${entry.kind} ${redactedId(entry.itemId)}`);
    }
  } else if (output.data.operation === "reset") {
    lines.push("Reset restored the exact named scenario snapshot.");
  } else if (output.data.operation === "init") {
    lines.push("Initialized the selected synthetic scenario.");
  } else {
    lines.push("Saved the current deterministic lab snapshot.");
  }
  return lines.join("\n");
}

export function completeResult(
  outputInput: CliOutput,
  exitCode: CliRunResult["exitCode"],
  json: boolean,
): CliRunResult {
  const output = CliOutputSchema.parse(outputInput);
  return {
    exitCode,
    output,
    text: json ? JSON.stringify(output, null, 2) : renderHuman(output),
  };
}
