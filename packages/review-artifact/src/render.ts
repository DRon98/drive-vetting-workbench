import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REVIEW_CONTROLLER } from "./controller.js";
import { REVIEW_STYLES } from "./styles.js";
import {
  REVIEW_TABS,
  ReviewArtifactInputSchema,
  ReviewArtifactManifestSchema,
  type GeneratedReviewArtifact,
  type ReviewArtifactInput,
  type ReviewArtifactManifest,
  type ReviewNode,
} from "./types.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cspHash(value: string): string {
  return createHash("sha256").update(value).digest("base64");
}

function escapeText(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("=", "&#61;")
    .replaceAll(".", "&#46;");
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("=", "\\u003d");
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function domKey(kind: string, value: string): string {
  return `${kind}-${sha256(value).slice(0, 16)}`;
}

function labelForTab(tab: (typeof REVIEW_TABS)[number]): string {
  return {
    overview: "Overview",
    "drive-map": "Drive Map",
    changes: "Proposed Changes",
    questions: "Questions",
    feedback: "Feedback Packet",
    sources: "Receipts and Sources",
  }[tab];
}

function term(input: ReviewArtifactInput, name: string): string {
  const entry = input.glossary.find((candidate) => candidate.term === name);
  if (!entry) return escapeText(name);
  const key = domKey("term", entry.term);
  return `<button class="term" type="button" data-term-key="${key}" aria-expanded="false" aria-controls="glossary-card">${escapeText(entry.term)}</button>`;
}

function renderSectionHead(
  eyebrow: string,
  title: string,
  body: string,
  noteTitle: string,
  note: string,
): string {
  return `<header class="section-head anim">
    <div><span class="pill pill-lime">${escapeText(eyebrow)}</span><h2>${escapeText(title)}</h2><p>${escapeText(body)}</p></div>
    <aside class="sidenote"><strong>${escapeText(noteTitle)}</strong>${escapeText(note)}</aside>
  </header>`;
}

function nodeAction(input: ReviewArtifactInput, node: ReviewNode) {
  return input.plan.actions.find((action) => action.targetId === node.id);
}

function nodeTone(input: ReviewArtifactInput, node: ReviewNode): string {
  if (
    node.protected ||
    !node.canRead ||
    input.plan.blockers.some((blocker) => blocker.targetIds.includes(node.id))
  ) {
    return "is-risk";
  }
  return nodeAction(input, node) ? "is-proposed" : "is-safe";
}

function renderEvidence(node: ReviewNode): string {
  if (node.evidence.length === 0 && node.policies.length === 0) {
    return `<p>No item-level evidence was included. See <code>${escapeText(node.sourceLocator)}</code>.</p>`;
  }
  return `<ul class="evidence-list">${[
    ...node.evidence.map(
      (evidence) =>
        `<li><span class="pill pill-blue">${escapeText(evidence.kind)}</span><strong>${escapeText(evidence.label)}</strong><p>${escapeText(evidence.value)}</p><code>${escapeText(evidence.sourceLocator)}</code></li>`,
    ),
    ...node.policies.map(
      (policy) =>
        `<li><span class="pill pill-lime">Policy</span><strong>${escapeText(policy.reasonCode)}</strong><p>${escapeText(policy.summary)}</p><code>${escapeText(policy.sourceLocator)}</code></li>`,
    ),
  ].join("")}</ul>`;
}

function renderNodeDetail(
  input: ReviewArtifactInput,
  node: ReviewNode,
): string {
  const key = domKey("node", node.id);
  const action = nodeAction(input, node);
  const blocker = input.plan.blockers.find((item) =>
    item.targetIds.includes(node.id),
  );
  const proposed = action
    ? `${action.type}: ${pretty(action.desiredState)}`
    : "No proposed change";
  return `<article class="node-detail" id="${key}-detail" data-node-detail="${key}" hidden>
    <h3>${escapeText(node.name)} <span class="status ${blocker ? "risk" : action ? "warn" : ""}">${blocker ? "Blocked" : action ? "Review" : "Observed"}</span></h3>
    <p>Stable item details and evidence for this visual node.</p>
    <div class="state-pair">
      <div class="state-box current"><small>Current state</small><strong>${escapeText(node.name)}</strong><code>${escapeText(node.mimeType)}</code></div>
      <div class="state-box proposed"><small>Proposed state</small><strong>${escapeText(proposed)}</strong><code>${escapeText(action?.reasonCode ?? node.sourceLocator)}</code></div>
    </div>
    <p><strong>Risk:</strong> ${escapeText(blocker?.message ?? (node.protected ? "This item is protected." : "No blocker is recorded for this item."))}</p>
    ${renderEvidence(node)}
  </article>`;
}

function renderDriveMap(input: ReviewArtifactInput): string {
  const nodes = input.nodes
    .map((node) => {
      const key = domKey("node", node.id);
      const action = nodeAction(input, node);
      return `<li class="tree-node depth-${node.depth} ${nodeTone(input, node)}">
        <button type="button" data-node-key="${key}" data-node-label="${escapeText(node.name)}" aria-controls="${key}-detail" aria-pressed="false">
          <span><span class="node-name">${escapeText(node.name)}</span><span class="node-meta">depth ${node.depth} · ${escapeText(node.mimeType)}</span></span>
          <span class="pill ${action ? "pill-amber" : "pill-mint"}">${escapeText(action?.type ?? "Observed")}</span>
        </button>
      </li>`;
    })
    .join("");
  const details = input.nodes
    .map((node) => renderNodeDetail(input, node))
    .join("");
  const options = input.nodes
    .map(
      (node) =>
        `<option value="${domKey("node", node.id)}">${escapeText(node.name)}</option>`,
    )
    .join("");
  return `${renderSectionHead("Figure 01", "The folder, as found", "Select any item to compare its current state, proposal, policy match, evidence, and risk.", "How to read this", "Blue is observed evidence. Lime is policy. Amber needs review. Mint is safe. Rose is risk.")}
  <figure class="figure-shell anim" aria-labelledby="drive-map-caption">
    <div class="figure-toolbar"><strong>Filesystem focus</strong><label for="node-selector">Show item</label><select id="node-selector" data-node-selector><option value="all">Complete map</option>${options}</select></div>
    <div class="figure-legend pill-row" aria-label="Map legend"><span class="pill pill-blue">Evidence</span><span class="pill pill-lime">Policy</span><span class="pill pill-amber">Review</span><span class="pill pill-mint">Safe</span><span class="pill pill-rose">Risk</span></div>
    <div class="map-layout"><ol class="drive-tree" data-drive-tree>${nodes}</ol><div class="map-details">
      <article class="node-detail is-active" data-node-detail="all"><h3>Complete folder view</h3><p>${input.nodes.length} items are in this minimized review tree. Select an item for its evidence and source locator.</p><div class="pill-row"><span class="pill pill-blue">${input.coverage.itemCount} scanned</span><span class="pill pill-amber">${input.plan.actions.length} actions</span><span class="pill pill-rose">${input.plan.blockers.length} blockers</span></div></article>
      ${details}
    </div></div>
    <figcaption id="drive-map-caption">Figure 01. Review tree derived from ${escapeText(input.sourceSnapshot)}. Source: <code>${escapeText(input.coverage.sourceLocator)}</code>.</figcaption>
  </figure>`;
}

function renderOverview(input: ReviewArtifactInput): string {
  const blockers = input.plan.blockers.length
    ? input.plan.blockers
        .map(
          (blocker) =>
            `<li><strong>${escapeText(blocker.code)}</strong><p>${escapeText(blocker.message)}</p><code>${escapeText(blocker.blockerId)}</code></li>`,
        )
        .join("")
    : "<li><strong>No blockers</strong><p>The plan has no recorded blocker.</p></li>";
  const receipts = input.priorReceipts.length
    ? input.priorReceipts
        .map(
          (receipt) =>
            `<article class="receipt"><h3>${escapeText(receipt.status)} · ${escapeText(receipt.runId)}</h3><p>${escapeText(receipt.summary)}</p><code>${escapeText(receipt.sourceLocator)}</code></article>`,
        )
        .join("")
    : '<article class="receipt"><h3>No prior receipts</h3><p>This review does not rely on a prior write.</p></article>';
  return `${renderSectionHead("Review brief", "What needs your judgment", "This dossier separates observed Drive facts, policy defaults, proposed changes, and human decisions.", "Next human action", input.nextHumanAction)}
  <div class="receipt-grid anim"><article class="receipt"><h3>Approval boundary</h3><p>${input.plan.approvalEligible ? "The plan has no recorded planner blockers, but this page still cannot approve or execute it." : "This plan is not eligible for approval. Resolve every blocker before a new review round."}</p><code>plan:${escapeText(input.plan.planHash)}</code></article><article class="receipt"><h3>Coverage statement</h3><p>${input.coverage.complete ? "The synthetic scan reports complete coverage." : "The scan reports a visible coverage gap. No gap is treated as an empty result."}</p><code>${escapeText(input.coverage.sourceLocator)}</code></article></div>
  <section class="source-ledger anim"><h3>Current blockers</h3><ul class="source-list">${blockers}</ul></section>
  <section class="source-ledger anim"><h3>Prior verification receipts</h3><div class="receipt-grid">${receipts}</div></section>`;
}

function actionDisplayValue(value: unknown): string {
  if (typeof value === "object" && value !== null && "name" in value) {
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" ? name : pretty(value);
  }
  return pretty(value);
}

function renderChanges(input: ReviewArtifactInput): string {
  const explanations = new Map(
    input.plan.explanations.map((item) => [item.actionId, item]),
  );
  const actions = input.plan.actions
    .map((action, index) => {
      const node = input.nodes.find((item) => item.id === action.targetId);
      const actionKey = domKey("action", action.actionId);
      const observedName = action.preconditions.name;
      const current =
        node?.name ??
        (typeof observedName === "string" ? observedName : "Observed target");
      const proposed = actionDisplayValue(action.desiredState);
      const blocker = input.plan.blockers.find((item) =>
        item.actionIds.includes(action.actionId),
      );
      const evidence =
        node?.evidence.filter((item) => action.evidenceIds.includes(item.id)) ??
        [];
      return `<article class="action-review anim" data-action-review="${actionKey}" data-action-id="${escapeText(action.actionId)}" data-action-label="Action ${index + 1}">
      <header class="action-head"><h3>${String(index + 1).padStart(2, "0")} · ${escapeText(action.type)} · ${escapeText(node?.name ?? action.targetId)}</h3><span class="status ${blocker ? "risk" : "warn"}">${blocker ? "Blocked" : action.reviewState}</span></header>
      <div class="action-body"><div class="action-copy"><div class="pill-row"><span class="pill pill-lime">${escapeText(action.reasonCode)}</span><span class="pill pill-blue">confidence ${Math.round(action.confidence * 100)}%</span></div><p>${escapeText(explanations.get(action.actionId)?.summary ?? "Review this typed proposal.")}</p>
        <div class="before-after"><div class="before"><small>Before</small>${escapeText(current)}</div><span class="delta-arrow" aria-hidden="true">→</span><div class="after"><small>After</small>${escapeText(proposed)}</div></div>
        <details><summary>Evidence, policy, and risk</summary><p><strong>Risk:</strong> ${escapeText(blocker?.message ?? "No direct blocker is recorded.")}</p><ul class="evidence-list">${evidence.map((item) => `<li><strong>${escapeText(item.label)}</strong><p>${escapeText(item.value)}</p><code>${escapeText(item.sourceLocator)}</code></li>`).join("") || `<li><strong>Evidence references</strong><p>${escapeText(action.evidenceIds.join(", "))}</p><code>${escapeText(node?.sourceLocator ?? action.targetId)}</code></li>`}</ul></details>
      </div><section class="review-controls"><h4>Your review</h4><p>This local state cannot approve or execute the plan.</p><div class="disposition-row" role="group" aria-label="Disposition for action ${index + 1}">
        ${["Accept", "Reject", "Edit", "Ask"].map((choice) => `<button type="button" data-review-action="${choice}" aria-pressed="false">${choice}</button>`).join("")}
      </div><label>Proposed edit<input data-review-field data-action-edit type="text" value="${escapeText(proposed)}" disabled></label><label>Reason code<input data-review-field data-action-reason-code type="text" value="REVIEWER_NOTE" pattern="[A-Z][A-Z0-9_.-]*"></label><label>Structured reason<textarea data-review-field data-action-reason-detail></textarea></label><label>Action comment<textarea data-review-field data-action-comment></textarea></label></section></div>
    </article>`;
    })
    .join("");
  return `${renderSectionHead("Decision table", "Proposed changes", "Compare the observed state with each proposed outcome. Evidence and blocker details stay attached to the action.", "Safety boundary", "Accept is review feedback only. It is not approval and cannot authorize a Drive write.")}<div class="action-list">${actions || "<p>No actions are in this plan.</p>"}</div>`;
}

function choiceToken(value: unknown): string {
  return safeJson(value);
}

function renderQuestions(input: ReviewArtifactInput): string {
  const questions = input.questions
    .map((question, questionIndex) => {
      const key = domKey("question", question.questionKey);
      const choices = question.choices
        .map((choice) => {
          const checked = safeJson(choice) === safeJson(question.defaultChoice);
          return `<label class="choice"><input type="radio" name="${key}" data-review-field data-question-answer data-choice-value="${escapeText(choiceToken(choice))}" ${checked ? "checked" : ""}><span>${escapeText(typeof choice === "string" ? choice : pretty(choice))}</span></label>`;
        })
        .join("");
      return `<fieldset class="question-card anim" data-question-card="${key}" data-question-key="${escapeText(question.questionKey)}"><legend>${String(questionIndex + 1).padStart(2, "0")} · ${escapeText(question.prompt)}</legend><p><span class="pill pill-amber">${escapeText(question.scope.type)}</span> Evidence: ${escapeText(question.evidenceIds.join(", "))}</p>${choices}<label>Question comment<textarea data-review-field data-question-comment></textarea></label><code>${escapeText(question.policyLocators.join(" · "))}</code></fieldset>`;
    })
    .join("");
  return `${renderSectionHead("Material questions", "Questions that change the plan", "Answer only the questions that affect a proposed outcome. Each answer remains bound to its scope and evidence.", "Question rate", `${input.questions.length} material question${input.questions.length === 1 ? "" : "s"} in this review round.`)}<div class="question-list">${questions || "<p>No unresolved material questions are in this review.</p>"}</div>`;
}

function renderFeedback(input: ReviewArtifactInput): string {
  const history =
    input.importedFeedback !== undefined && input.feedbackSummary !== undefined
      ? `<section class="feedback-history anim"><div><span class="pill pill-blue">Imported packet</span><h3>Round ${input.feedbackSummary.sourceReviewRound} → ${input.feedbackSummary.nextReviewRound}</h3><p>The prior review packet is preserved losslessly below. Its feedback requested this new plan; it did not approve it.</p></div><div class="before-after"><div class="before"><small>Before plan</small><code>${input.feedbackSummary.sourcePlanHash}</code></div><span class="delta-arrow" aria-hidden="true">→</span><div class="after"><small>After plan</small><code>${input.feedbackSummary.nextPlanHash}</code></div></div><p><strong>Imported checksum:</strong> <code>${input.feedbackSummary.importedChecksum}</code></p><details><summary>Complete imported packet</summary><pre data-imported-feedback tabindex="0">${escapeText(pretty(input.importedFeedback))}</pre></details></section>`
      : "";
  return `${renderSectionHead("Return path", "Feedback packet", "Review choices, edits, answers, scope, reviewer, and comments form one checksummed portable packet.", "Trust boundary", "Preview validates every field before import. Feedback can request a replan; it cannot approve or execute one.")}
  ${history}<div class="feedback-layout"><section class="feedback-editor"><h3>Export this round</h3><label>Reviewer<input data-review-field data-reviewer type="text" autocomplete="name" placeholder="Reviewer name"></label><label>Comment for the next review round<textarea data-review-field data-global-comment></textarea></label><div class="packet-actions"><button type="button" data-copy-packet>Copy packet</button><button type="button" data-download-packet>Download packet</button><button type="button" data-paste-packet>Paste packet</button><label class="file-button">Choose packet<input data-import-file type="file" accept="application/json,.json"></label><button type="button" data-preview-import>Preview packet</button><button type="button" data-apply-import disabled>Import packet</button><button type="button" data-clear-draft>Clear local draft</button></div><label>Paste or inspect a packet<textarea data-feedback-import spellcheck="false" placeholder="Paste one dvw.feedback.v1 JSON packet"></textarea></label><div class="import-report" data-import-report aria-live="polite"><h4>Round-trip preview</h4><p>No packet has been validated for import.</p></div><p class="boundary-note feedback-return">This page cannot approve or execute a plan, call a provider, or write to Drive. Import only restores review feedback for this exact plan and round.</p></section><section class="feedback-preview"><h3>Canonical packet preview</h3><pre data-feedback-preview aria-label="Canonical feedback packet preview" tabindex="0"></pre></section></div>`;
}

function renderSources(input: ReviewArtifactInput): string {
  const receipts =
    input.priorReceipts
      .map(
        (receipt) =>
          `<article class="receipt"><h3>${escapeText(receipt.status)}</h3><p>${escapeText(receipt.summary)}</p><code>${escapeText(receipt.sourceLocator)}</code></article>`,
      )
      .join("") ||
    '<article class="receipt"><h3>No receipts included</h3><p>No prior write result is claimed.</p></article>';
  const sources = input.sources
    .map(
      (source, index) =>
        `<li><strong>${String(index + 1).padStart(2, "0")} · ${escapeText(source.label)}</strong>${escapeText(source.claim)}<code>${escapeText(source.locator)}</code></li>`,
    )
    .join("");
  const glossary = input.glossary
    .map((entry) => {
      const key = domKey("term", entry.term);
      return `<li class="glossary-definition" data-glossary-key="${key}"><strong>${escapeText(entry.term)}</strong><p>${escapeText(entry.definition)}</p><code>${escapeText(entry.sourceLocator)}</code></li>`;
    })
    .join("");
  return `${renderSectionHead("Provenance", "Receipts and sources", "Every displayed claim points to the synthetic scan, plan, policy pack, or prior verification receipt that supports it.", "Artifact source", input.sourceSnapshot)}<section><h3>Prior receipts</h3><div class="receipt-grid">${receipts}</div></section><section class="source-ledger"><h3>Source ledger</h3><ol class="source-list">${sources}</ol></section><section class="source-ledger"><h3>Glossary</h3><ul class="glossary-list">${glossary}</ul></section>`;
}

function buildManifest(input: ReviewArtifactInput): ReviewArtifactManifest {
  return ReviewArtifactManifestSchema.parse({
    artifactVersion: input.artifactVersion,
    generatedAt: input.generatedAt,
    includedPanels: REVIEW_TABS,
    minimizedFields: [
      "content bodies",
      "content locators",
      "credentials",
      "OAuth tokens",
    ],
    planHash: input.plan.planHash,
    policyVersion: input.plan.policyVersion,
    reviewRound: input.reviewRound,
    scanGeneration: input.plan.scanGeneration,
    sourceSnapshot: input.sourceSnapshot,
  });
}

export function generateReviewArtifact(
  rawInput: ReviewArtifactInput,
): GeneratedReviewArtifact {
  const input = ReviewArtifactInputSchema.parse(rawInput);
  const manifest = buildManifest(input);
  const tabs = REVIEW_TABS.map(
    (tab, index) =>
      `<button class="tab-button" id="tab-${tab}" type="button" role="tab" data-tab="${tab}" aria-controls="panel-${tab}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${labelForTab(tab)}</button>`,
  ).join("");
  const panels = [
    renderOverview(input),
    renderDriveMap(input),
    renderChanges(input),
    renderQuestions(input),
    renderFeedback(input),
    renderSources(input),
  ]
    .map((content, index) => {
      const tab = REVIEW_TABS[index];
      return `<section class="tab-panel${index === 0 ? " is-active" : ""}" id="panel-${tab}" role="tabpanel" data-panel="${tab}" aria-labelledby="tab-${tab}" ${index === 0 ? "" : "hidden"}>${content}</section>`;
    })
    .join("");
  const csp = `default-src 'none'; style-src 'sha256-${cspHash(REVIEW_STYLES)}'; script-src 'sha256-${cspHash(REVIEW_CONTROLLER)}'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  const coverageStatus = input.coverage.complete ? "Complete" : "Gap visible";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="light"><title>${escapeText(input.title)}</title><style>${REVIEW_STYLES}</style></head>
<body data-artifact-version="${escapeText(input.artifactVersion)}" data-plan-hash="${input.plan.planHash}" data-review-round="${input.reviewRound}"><a class="skip-link" href="#review-main">Skip to review</a>
<header class="masthead"><div class="brand"><span class="brand-mark" aria-hidden="true">DV</span><div><strong>Drive Vetting Workbench</strong><span>Offline review dossier · synthetic fixture</span></div></div><div class="masthead-meta">Plan ${term(input, "plan hash")}<strong>${input.plan.planHash}</strong>Round ${input.reviewRound} · ${escapeText(input.generatedAt)}</div></header>
<section class="hero"><div><span class="pill pill-lime">Buck review · Round ${input.reviewRound}</span><h1>${escapeText(input.title)}</h1><p class="lede">Inspect the current folder, the policy-backed proposal, its evidence, material questions, and prior receipts. This single file runs offline.</p><div class="formula"><span>Observed Drive + policy + human judgment</span><span>→ a reviewable, non-destructive plan</span></div></div><aside class="hero-note"><strong>${escapeText(input.nextHumanAction)}</strong><p>The page collects review state only. It cannot approve, execute, or connect to Drive.</p></aside></section>
<section class="facts" aria-label="Review facts"><div class="fact"><a href="#drive-map" data-tab-jump="drive-map"><small>Scan coverage</small><strong>${escapeText(coverageStatus)}</strong><span>${input.coverage.itemCount} items · ${input.coverage.pageCount} pages · ${input.coverage.deniedItemCount} denied</span></a></div><div class="fact"><small>Typed actions</small><strong>${input.plan.actions.length}</strong><span>${input.plan.effectiveActions.length} currently effective</span></div><div class="fact"><small>Plan blockers</small><strong>${input.plan.blockers.length}</strong><span>${input.plan.approvalEligible ? "Planner eligible" : "Review required"}</span></div><div class="fact"><small>Material questions</small><strong>${input.questions.length}</strong><span>Bound to scope and evidence</span></div></section>
<nav class="tab-shell" aria-label="Review sections"><div class="tabs" role="tablist" aria-label="Review sections">${tabs}</div></nav><main id="review-main">${panels}</main>
<div class="glossary-card" id="glossary-card" data-glossary-card role="dialog" aria-modal="false" aria-labelledby="glossary-term" hidden><button class="glossary-close" type="button" data-glossary-close aria-label="Close definition">×</button><small data-glossary-source></small><strong id="glossary-term" data-glossary-term></strong><p data-glossary-definition></p></div>
<p class="live-region" data-review-live aria-live="polite"></p><footer class="page-footer"><span>Generated locally · ${escapeText(input.sourceSnapshot)}</span><span>No network · no remote assets · no Drive write path</span></footer>
<script type="application/json" id="review-data">${safeJson({ manifest, review: input })}</script><script>${REVIEW_CONTROLLER}</script></body></html>`;
  return Object.freeze({ html, htmlSha256: sha256(html), manifest });
}

export function writeReviewArtifactCreateOnly(
  path: string,
  input: ReviewArtifactInput,
): GeneratedReviewArtifact {
  const artifact = generateReviewArtifact(input);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, artifact.html, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
    const existing = readFileSync(path, "utf8");
    if (existing !== artifact.html) {
      throw new Error(
        `Refusing to replace an existing review artifact with different bytes: ${path}`,
      );
    }
  }
  return artifact;
}
