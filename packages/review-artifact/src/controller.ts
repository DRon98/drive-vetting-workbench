export const REVIEW_CONTROLLER = String.raw`(() => {
  "use strict";

  const one = (selector, root = document) => root.querySelector(selector);
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const live = one("[data-review-live]");
  const preview = one("[data-feedback-preview]");
  const tree = one("[data-drive-tree]");
  const importText = one("[data-feedback-import]");
  const importReport = one("[data-import-report]");
  const importButton = one("[data-apply-import]");
  const embedded = JSON.parse(one("#review-data").textContent);
  const review = embedded.review;
  const draftKey = "dvw.feedback.draft." + review.plan.planHash;
  let pendingPacket = null;
  let importedMetadata = null;

  function announce(message) {
    if (live) live.textContent = message;
  }

  function activateTab(name, moveFocus) {
    const tabs = all("[role=tab]");
    const selected = tabs.find((tab) => tab.dataset.tab === name) || tabs[0];
    if (!selected) return;
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of all("[role=tabpanel]")) {
      const active = panel.dataset.panel === selected.dataset.tab;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    }
    if (moveFocus) selected.focus();
    announce(selected.textContent.trim() + " tab selected.");
  }

  for (const [index, tab] of all("[role=tab]").entries()) {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab, false));
    tab.addEventListener("keydown", (event) => {
      const tabs = all("[role=tab]");
      let target = index;
      if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") target = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") target = 0;
      else if (event.key === "End") target = tabs.length - 1;
      else return;
      event.preventDefault();
      activateTab(tabs[target].dataset.tab, true);
    });
  }

  function focusNode(key, moveFocus) {
    const buttons = all("[data-node-key]");
    const selected = buttons.find((button) => button.dataset.nodeKey === key);
    if (!selected) return;
    for (const button of buttons) {
      const active = button === selected;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      button.closest(".tree-node")?.classList.toggle("is-active", active);
    }
    for (const detail of all("[data-node-detail]")) {
      const active = detail.dataset.nodeDetail === key;
      detail.hidden = !active;
      detail.classList.toggle("is-active", active);
    }
    if (tree) tree.classList.add("is-filtered");
    const selector = one("[data-node-selector]");
    if (selector) selector.value = key;
    if (moveFocus) selected.focus();
    announce("Focused item: " + (selected.dataset.nodeLabel || selected.textContent.trim()));
  }

  for (const button of all("[data-node-key]")) {
    button.addEventListener("click", () => focusNode(button.dataset.nodeKey, false));
  }
  one("[data-node-selector]")?.addEventListener("change", (event) => {
    const key = event.currentTarget.value;
    if (key === "all") {
      if (tree) tree.classList.remove("is-filtered");
      for (const button of all("[data-node-key]")) {
        button.classList.remove("is-active");
        button.setAttribute("aria-pressed", "false");
        button.closest(".tree-node")?.classList.remove("is-active");
      }
      for (const detail of all("[data-node-detail]")) {
        const active = detail.dataset.nodeDetail === "all";
        detail.hidden = !active;
        detail.classList.toggle("is-active", active);
      }
      announce("Showing the complete Drive map.");
      return;
    }
    focusNode(key, true);
  });

  function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => compareText(left, right))
          .map(([key, entry]) => [key.normalize("NFC"), canonicalValue(entry)]),
      );
    }
    return typeof value === "string" ? value.normalize("NFC") : value;
  }

  function canonicalText(value) {
    return JSON.stringify(canonicalValue(value), null, 2) + "\n";
  }

  async function sha256(value) {
    if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable in this browser.");
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function unsafeTextReason(value) {
    if (/[<>]/u.test(value)) return "Markup is not allowed.";
    if (/javascript\s*:|data\s*:\s*text\/html|vbscript\s*:/iu.test(value)) return "Executable URLs are not allowed.";
    if (/\bon\p{L}+\s*=/iu.test(value)) return "Executable event-handler text is not allowed.";
    for (const character of value) {
      const point = character.codePointAt(0) || 0;
      if ((point < 32 && point !== 9 && point !== 10 && point !== 13) || (point >= 127 && point <= 159)) return "Control characters are not allowed.";
    }
    return null;
  }

  function nestedTextIssues(value, path = []) {
    if (typeof value === "string") {
      const reason = unsafeTextReason(value);
      return reason ? [{ path: path.join(".") || "packet", message: reason }] : [];
    }
    if (Array.isArray(value)) return value.flatMap((entry, index) => nestedTextIssues(entry, [...path, index]));
    if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => nestedTextIssues(entry, [...path, key]));
    return [];
  }

  function feedbackState() {
    const actions = all("[data-action-review]").map((card) => {
      const pressed = one('[data-review-action][aria-pressed="true"]', card);
      const disposition = pressed?.dataset.reviewAction || null;
      return {
        actionId: card.dataset.actionId,
        comment: one("[data-action-comment]", card)?.value || "",
        disposition,
        proposedName: disposition === "Edit" ? one("[data-action-edit]", card)?.value || "" : null,
        reason: {
          code: one("[data-action-reason-code]", card)?.value || "",
          detail: one("[data-action-reason-detail]", card)?.value || "",
        },
      };
    });
    const questions = all("[data-question-card]").map((card) => {
      const rawAnswer = one("[data-question-answer]:checked", card)?.dataset.choiceValue;
      let answer = null;
      if (rawAnswer !== undefined) {
        try { answer = JSON.parse(rawAnswer); } catch { answer = null; }
      }
      const source = review.questions.find((entry) => entry.questionKey === card.dataset.questionKey);
      return {
        answer,
        comment: one("[data-question-comment]", card)?.value || "",
        questionKey: card.dataset.questionKey,
        scope: source?.scope || null,
      };
    });
    return {
      actions,
      globalComment: one("[data-global-comment]")?.value || "",
      questions,
    };
  }

  function localIssues(draft, reviewer) {
    const issues = [];
    const push = (path, message) => issues.push({ path, message });
    if (typeof reviewer !== "string" || reviewer.trim().length === 0) push("reviewer", "Reviewer is required.");
    else if (unsafeTextReason(reviewer)) push("reviewer", unsafeTextReason(reviewer));
    const knownActions = new Map(review.plan.actions.map((entry) => [entry.actionId, entry]));
    for (const [index, action] of draft.actions.entries()) {
      if (!knownActions.has(action.actionId)) push("actions." + index + ".actionId", "Unknown action ID.");
      if (!["Accept", "Reject", "Edit", "Ask"].includes(action.disposition)) push("actions." + index + ".disposition", "Choose Accept, Reject, Edit, or Ask.");
      if (!/^[A-Z][A-Z0-9_.-]*$/u.test(action.reason.code)) push("actions." + index + ".reason.code", "Use an uppercase structured reason code.");
      if (action.disposition === "Edit") {
        if (knownActions.get(action.actionId)?.type !== "RENAME") push("actions." + index + ".proposedName", "Only rename actions can be edited.");
        if (!action.proposedName || action.proposedName === "." || action.proposedName === ".." || /[/\\]/u.test(action.proposedName)) push("actions." + index + ".proposedName", "Use one filename, not a path.");
      } else if (action.proposedName !== null) push("actions." + index + ".proposedName", "Only Edit may carry a proposed name.");
    }
    if (draft.actions.length !== knownActions.size || new Set(draft.actions.map((entry) => entry.actionId)).size !== knownActions.size) push("actions", "Feedback must name every known action exactly once.");
    const knownQuestions = new Map(review.questions.map((entry) => [entry.questionKey, entry]));
    for (const [index, answer] of draft.questions.entries()) {
      const known = knownQuestions.get(answer.questionKey);
      if (!known) push("questions." + index + ".questionKey", "Unknown question key.");
      else {
        if (canonicalText(answer.scope) !== canonicalText(known.scope)) push("questions." + index + ".scope", "Question scope does not match.");
        if (!known.choices.some((choice) => canonicalText(choice) === canonicalText(answer.answer))) push("questions." + index + ".answer", "Answer is not an allowed choice.");
      }
    }
    if (draft.questions.length !== knownQuestions.size || new Set(draft.questions.map((entry) => entry.questionKey)).size !== knownQuestions.size) push("questions", "Feedback must answer every material question exactly once.");
    issues.push(...nestedTextIssues(draft));
    return issues;
  }

  async function buildPacket(metadata) {
    const draft = feedbackState();
    const reviewer = one("[data-reviewer]")?.value || "";
    const issues = localIssues(draft, reviewer);
    if (issues.length) throw Object.assign(new Error("Feedback is incomplete or unsafe."), { issues });
    const payload = {
      ...draft,
      artifactVersion: review.artifactVersion,
      exportedAt: metadata?.exportedAt || new Date().toISOString(),
      packetVersion: "dvw.feedback.v1",
      planHash: review.plan.planHash,
      policyVersion: review.plan.policyVersion,
      reviewer: metadata?.reviewer || reviewer.trim(),
      reviewRound: review.reviewRound,
      scanGeneration: review.plan.scanGeneration,
    };
    return { ...payload, checksum: await sha256(canonicalText(payload)) };
  }

  function packetKeysAre(value, expected) {
    return value && typeof value === "object" && !Array.isArray(value) && canonicalText(Object.keys(value).sort()) === canonicalText([...expected].sort());
  }

  function isJsonValue(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    if (value && typeof value === "object") return Object.values(value).every(isJsonValue);
    return false;
  }

  async function validatePacket(text) {
    const issues = [];
    const push = (path, message) => issues.push({ path, message });
    let malformed = false;
    const invalid = (path, message) => { malformed = true; push(path, message); };
    const fenced = text.trim().match(/^(?:\x60){3}(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n(?:\x60){3}$/iu);
    if (fenced) text = fenced[1];
    if (new TextEncoder().encode(text).length > 1024 * 1024) return { issues: [{ path: "packet", message: "Packet exceeds 1 MiB." }], packet: null };
    let packet;
    try { packet = JSON.parse(text); } catch { return { issues: [{ path: "packet", message: "Packet is not valid JSON." }], packet: null }; }
    const topKeys = ["actions", "artifactVersion", "checksum", "exportedAt", "globalComment", "packetVersion", "planHash", "policyVersion", "questions", "reviewer", "reviewRound", "scanGeneration"];
    if (!packetKeysAre(packet, topKeys)) invalid("packet", "Packet fields do not match dvw.feedback.v1.");
    if (packet.packetVersion !== "dvw.feedback.v1") invalid("packetVersion", "Unsupported packet version.");
    if (typeof packet.artifactVersion !== "string" || !packet.artifactVersion) invalid("artifactVersion", "Artifact version must be non-empty text.");
    else if (packet.artifactVersion !== review.artifactVersion) push("artifactVersion", "Artifact version does not match.");
    if (typeof packet.planHash !== "string" || !/^[a-f0-9]{64}$/u.test(packet.planHash)) invalid("planHash", "Plan hash must be 64 lowercase hex characters.");
    else if (packet.planHash !== review.plan.planHash) push("planHash", "Packet belongs to a different plan.");
    if (typeof packet.scanGeneration !== "string" || !packet.scanGeneration) invalid("scanGeneration", "Scan generation must be non-empty text.");
    else if (packet.scanGeneration !== review.plan.scanGeneration) push("scanGeneration", "Packet belongs to a different scan.");
    if (typeof packet.policyVersion !== "string" || !packet.policyVersion) invalid("policyVersion", "Policy version must be non-empty text.");
    else if (packet.policyVersion !== review.plan.policyVersion) push("policyVersion", "Packet belongs to a different policy.");
    if (!Number.isInteger(packet.reviewRound) || packet.reviewRound < 1) invalid("reviewRound", "Review round must be a positive integer.");
    else if (packet.reviewRound !== review.reviewRound) push("reviewRound", "Packet belongs to a different review round.");
    if (typeof packet.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(packet.checksum)) invalid("checksum", "Checksum must be 64 lowercase hex characters.");
    if (!Array.isArray(packet.actions)) invalid("actions", "Actions must be an array.");
    if (!Array.isArray(packet.questions)) invalid("questions", "Questions must be an array.");
    if (typeof packet.reviewer !== "string" || packet.reviewer.trim().length === 0 || packet.reviewer.length > 200) invalid("reviewer", "Reviewer must be 1 to 200 text characters.");
    if (typeof packet.exportedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(packet.exportedAt) || Number.isNaN(Date.parse(packet.exportedAt))) invalid("exportedAt", "Export time must be an ISO timestamp with an offset.");
    if (typeof packet.globalComment !== "string" || packet.globalComment.length > 4096) invalid("globalComment", "Global comment must be at most 4096 text characters.");
    if (Array.isArray(packet.actions)) {
      for (const [index, action] of packet.actions.entries()) {
        const path = "actions." + index;
        if (!packetKeysAre(action, ["actionId", "comment", "disposition", "proposedName", "reason"])) invalid(path, "Action fields are unknown or missing.");
        if (typeof action?.actionId !== "string" || !action.actionId) invalid(path + ".actionId", "Action ID must be non-empty text.");
        if (typeof action?.comment !== "string" || action.comment.length > 4096) invalid(path + ".comment", "Action comment must be at most 4096 text characters.");
        if (!["Accept", "Reject", "Edit", "Ask"].includes(action?.disposition)) invalid(path + ".disposition", "Disposition must be Accept, Reject, Edit, or Ask.");
        if (action?.proposedName !== null && (typeof action?.proposedName !== "string" || action.proposedName.length > 255)) invalid(path + ".proposedName", "Proposed name must be null or at most 255 text characters.");
        if (!packetKeysAre(action?.reason, ["code", "detail"])) invalid(path + ".reason", "Reason fields are unknown or missing.");
        if (typeof action?.reason?.code !== "string" || !/^[A-Z][A-Z0-9_.-]*$/u.test(action.reason.code)) invalid(path + ".reason.code", "Reason code must use uppercase structured text.");
        if (typeof action?.reason?.detail !== "string" || action.reason.detail.length > 4096) invalid(path + ".reason.detail", "Reason detail must be at most 4096 text characters.");
      }
    }
    if (Array.isArray(packet.questions)) {
      for (const [index, answer] of packet.questions.entries()) {
        const path = "questions." + index;
        if (!packetKeysAre(answer, ["answer", "comment", "questionKey", "scope"])) invalid(path, "Question fields are unknown or missing.");
        if (!isJsonValue(answer?.answer)) invalid(path + ".answer", "Answer must be a finite JSON value.");
        if (typeof answer?.comment !== "string" || answer.comment.length > 4096) invalid(path + ".comment", "Question comment must be at most 4096 text characters.");
        if (typeof answer?.questionKey !== "string" || !answer.questionKey) invalid(path + ".questionKey", "Question key must be non-empty text.");
        if (!packetKeysAre(answer?.scope, ["id", "type"])) invalid(path + ".scope", "Scope fields are unknown or missing.");
        const scopeType = answer?.scope?.type;
        if (!["item", "folder", "deal", "document-type", "global"].includes(scopeType)) invalid(path + ".scope.type", "Scope type is invalid.");
        if ((scopeType === "global" && answer?.scope?.id !== null) || (scopeType !== "global" && (typeof answer?.scope?.id !== "string" || !answer.scope.id))) invalid(path + ".scope.id", "Scope ID does not match its type.");
      }
    }
    if (!malformed) {
      const draft = { actions: packet.actions, globalComment: packet.globalComment, questions: packet.questions };
      issues.push(...localIssues(draft, packet.reviewer));
      const { checksum, ...payload } = packet;
      const expected = await sha256(canonicalText(payload));
      if (checksum !== expected) push("checksum", "Checksum mismatch; expected " + expected + ".");
    }
    issues.push(...nestedTextIssues(packet));
    const uniqueIssues = Array.from(
      new Map(issues.map((entry) => [entry.path + "\u0000" + entry.message, entry])).values(),
    );
    return { issues: uniqueIssues, packet: uniqueIssues.length ? null : packet };
  }

  function leafPaths(value, prefix = "") {
    if (Array.isArray(value)) return value.flatMap((entry, index) => leafPaths(entry, prefix ? prefix + "." + index : String(index)));
    if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, prefix ? prefix + "." + key : key));
    return [prefix];
  }

  function renderReport(title, accepted, ignored, rejected) {
    if (!importReport) return;
    importReport.replaceChildren();
    importReport.classList.toggle("is-valid", rejected.length === 0);
    importReport.classList.toggle("is-invalid", rejected.length > 0);
    const heading = document.createElement("h4");
    heading.textContent = title;
    importReport.append(heading);
    for (const [label, fields] of [["Accepted", accepted], ["Ignored", ignored], ["Rejected", rejected]]) {
      const section = document.createElement("section");
      const strong = document.createElement("strong");
      strong.textContent = label + " fields (" + fields.length + ")";
      section.append(strong);
      if (fields.length) {
        const list = document.createElement("ul");
        list.tabIndex = 0;
        list.setAttribute("aria-label", label + " import fields");
        for (const field of fields) {
          const item = document.createElement("li");
          item.textContent = typeof field === "string" ? field : field.path + ": " + field.message;
          list.append(item);
        }
        section.append(list);
      } else {
        const none = document.createElement("p");
        none.textContent = "None.";
        section.append(none);
      }
      importReport.append(section);
    }
  }

  function applyDraft(draft, reviewer, metadata) {
    const actions = new Map(draft.actions.map((entry) => [entry.actionId, entry]));
    for (const card of all("[data-action-review]")) {
      const state = actions.get(card.dataset.actionId);
      if (!state) continue;
      for (const button of all("[data-review-action]", card)) button.setAttribute("aria-pressed", String(button.dataset.reviewAction === state.disposition));
      const edit = one("[data-action-edit]", card);
      if (edit) { edit.disabled = state.disposition !== "Edit"; if (state.proposedName !== null) edit.value = state.proposedName; }
      const comment = one("[data-action-comment]", card); if (comment) comment.value = state.comment;
      const code = one("[data-action-reason-code]", card); if (code) code.value = state.reason.code;
      const detail = one("[data-action-reason-detail]", card); if (detail) detail.value = state.reason.detail;
    }
    const answers = new Map(draft.questions.map((entry) => [entry.questionKey, entry]));
    for (const card of all("[data-question-card]")) {
      const state = answers.get(card.dataset.questionKey);
      if (!state) continue;
      for (const option of all("[data-question-answer]", card)) option.checked = canonicalText(JSON.parse(option.dataset.choiceValue)) === canonicalText(state.answer);
      const comment = one("[data-question-comment]", card); if (comment) comment.value = state.comment;
    }
    const globalComment = one("[data-global-comment]"); if (globalComment) globalComment.value = draft.globalComment;
    const reviewerField = one("[data-reviewer]"); if (reviewerField) reviewerField.value = reviewer;
    importedMetadata = metadata;
  }

  function saveDraft() {
    try {
      localStorage.setItem(draftKey, canonicalText({ draft: feedbackState(), reviewer: one("[data-reviewer]")?.value || "" }));
    } catch { announce("Local draft storage is unavailable; export remains available."); }
  }

  async function updatePreview(exactPacket) {
    if (!preview) return;
    if (exactPacket) { preview.textContent = canonicalText(exactPacket); return; }
    try { preview.textContent = canonicalText(await buildPacket(importedMetadata)); }
    catch (error) {
      const issues = Array.isArray(error?.issues) ? error.issues : [];
      preview.textContent = canonicalText({ draft: feedbackState(), exportReady: false, issues });
    }
  }

  for (const control of all("[data-review-action]")) {
    control.addEventListener("click", () => {
      const card = control.closest("[data-action-review]");
      if (!card) return;
      for (const peer of all("[data-review-action]", card)) peer.setAttribute("aria-pressed", String(peer === control));
      const edit = one("[data-action-edit]", card);
      if (edit) edit.disabled = control.dataset.reviewAction !== "Edit";
      importedMetadata = null; pendingPacket = null; if (importButton) importButton.disabled = true;
      announce(control.dataset.reviewAction + " selected for " + card.dataset.actionLabel + ".");
      saveDraft(); void updatePreview();
    });
  }
  for (const field of all("[data-review-field]")) {
    field.addEventListener("input", () => { importedMetadata = null; saveDraft(); void updatePreview(); });
    field.addEventListener("change", () => { importedMetadata = null; saveDraft(); void updatePreview(); });
  }

  async function exportPacket() {
    const packet = await buildPacket(importedMetadata);
    if (preview) preview.textContent = canonicalText(packet);
    return { packet, text: canonicalText(packet) };
  }

  function fallbackCopy(text) {
    const field = document.createElement("textarea");
    field.value = text; field.setAttribute("readonly", ""); field.style.position = "fixed"; field.style.opacity = "0";
    document.body.append(field); field.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    field.replaceWith();
    if (!copied) throw new Error("Clipboard fallback was unavailable.");
  }

  one("[data-copy-packet]")?.addEventListener("click", async () => {
    try {
      const exported = await exportPacket();
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable.");
        await navigator.clipboard.writeText(exported.text);
      } catch { fallbackCopy(exported.text); }
      announce("Checksummed feedback packet copied. This is not approval.");
    } catch (error) { announce(error?.issues?.[0]?.path ? error.issues[0].path + ": " + error.issues[0].message : error.message); }
  });

  one("[data-download-packet]")?.addEventListener("click", async () => {
    try {
      const exported = await exportPacket();
      const url = URL.createObjectURL(new Blob([exported.text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = "feedback-" + review.plan.planHash + "-round-" + review.reviewRound + "-" + exported.packet.checksum + ".json";
      document.body.append(link); link.click(); link.replaceWith(); setTimeout(() => URL.revokeObjectURL(url), 0);
      announce("Checksummed feedback packet downloaded.");
    } catch (error) { announce(error?.issues?.[0]?.path ? error.issues[0].path + ": " + error.issues[0].message : error.message); }
  });

  one("[data-paste-packet]")?.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.readText) throw new Error("Clipboard read is unavailable; paste into the text area.");
      if (importText) importText.value = await navigator.clipboard.readText();
      announce("Packet pasted. Preview it before import.");
    } catch (error) { importText?.focus(); announce(error.message); }
  });

  one("[data-import-file]")?.addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file || !importText) return;
    importText.value = await file.text();
    announce("Packet file loaded. Preview it before import.");
  });

  one("[data-preview-import]")?.addEventListener("click", async () => {
    const result = await validatePacket(importText?.value || "");
    pendingPacket = result.packet;
    if (importButton) importButton.disabled = !pendingPacket;
    if (pendingPacket) {
      renderReport("Valid round-trip preview", leafPaths(pendingPacket).sort(compareText), [], []);
      announce("Packet is valid for this exact plan and round. Review the field list before import.");
    } else {
      renderReport("Import blocked", [], [], result.issues);
      announce("Packet import is blocked. Review the precise field errors.");
    }
  });

  importButton?.addEventListener("click", () => {
    if (!pendingPacket) return;
    applyDraft(
      { actions: pendingPacket.actions, globalComment: pendingPacket.globalComment, questions: pendingPacket.questions },
      pendingPacket.reviewer,
      { exportedAt: pendingPacket.exportedAt, reviewer: pendingPacket.reviewer },
    );
    saveDraft();
    if (preview) preview.textContent = canonicalText(pendingPacket);
    announce("Feedback imported losslessly. It may request a replan; it did not approve this plan.");
  });

  one("[data-clear-draft]")?.addEventListener("click", () => {
    for (const card of all("[data-action-review]")) {
      for (const button of all("[data-review-action]", card)) button.setAttribute("aria-pressed", "false");
      const edit = one("[data-action-edit]", card); if (edit) { edit.disabled = true; edit.value = edit.defaultValue; }
      for (const field of all("[data-action-comment], [data-action-reason-detail]", card)) field.value = "";
      const code = one("[data-action-reason-code]", card); if (code) code.value = "REVIEWER_NOTE";
    }
    for (const card of all("[data-question-card]")) {
      const options = all("[data-question-answer]", card); for (const option of options) option.checked = option.defaultChecked;
      const comment = one("[data-question-comment]", card); if (comment) comment.value = "";
    }
    for (const field of all("[data-global-comment], [data-reviewer], [data-feedback-import]")) field.value = "";
    pendingPacket = null; importedMetadata = null; if (importButton) importButton.disabled = true;
    try { localStorage.setItem(draftKey, ""); } catch {}
    renderReport("Round-trip preview", [], [], []); void updatePreview();
    announce("Local draft cleared. No plan, artifact, or Drive item was removed.");
  });

  const glossary = one("[data-glossary-card]");
  let glossaryTrigger = null;
  function closeGlossary() {
    if (!glossary) return;
    glossary.hidden = true;
    if (glossaryTrigger) glossaryTrigger.setAttribute("aria-expanded", "false");
  }
  for (const term of all("[data-term-key]")) {
    term.addEventListener("click", () => {
      if (!glossary) return;
      const definition = one('[data-glossary-key="' + term.dataset.termKey + '"]');
      if (!definition) return;
      glossaryTrigger = term;
      one("[data-glossary-term]", glossary).textContent = one("strong", definition).textContent;
      one("[data-glossary-definition]", glossary).textContent = one("p", definition).textContent;
      one("[data-glossary-source]", glossary).textContent = one("code", definition).textContent;
      glossary.hidden = false;
      term.setAttribute("aria-expanded", "true");
      one("[data-glossary-close]", glossary)?.focus();
    });
  }
  one("[data-glossary-close]")?.addEventListener("click", () => { closeGlossary(); glossaryTrigger?.focus(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && glossary && !glossary.hidden) { closeGlossary(); glossaryTrigger?.focus(); }
  });

  try {
    const saved = localStorage.getItem(draftKey);
    if (saved) {
      const stored = JSON.parse(saved);
      if (stored?.draft && Array.isArray(stored.draft.actions) && Array.isArray(stored.draft.questions)) applyDraft(stored.draft, String(stored.reviewer || ""), null);
    }
  } catch { announce("The local draft was ignored because it was invalid or unavailable."); }

  const initialTab = location.hash.slice(1);
  activateTab(initialTab || "overview", false);
  void updatePreview();
  for (const element of all(".anim")) element.classList.add("is-in");
})();`;
