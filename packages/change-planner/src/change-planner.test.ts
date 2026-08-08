import { describe, expect, test } from "vitest";
import type { ObservedItem } from "@dvw/core";
import type { QuestionResolution } from "@dvw/decision-memory";
import type { EvidenceBuildResult } from "@dvw/evidence-builder";
import type { ReasoningSuggestion } from "@dvw/reasoning";
import * as changePlanner from "./index.js";

const { buildChangePlan } = changePlanner;

const observedTime = "2026-08-08T12:00:00.000Z";

function item(overrides: Partial<ObservedItem> = {}): ObservedItem {
  return {
    contentFingerprint: `sha256:${"a".repeat(64)}`,
    createdTime: observedTime,
    id: "file-1",
    mimeType: "application/pdf",
    modifiedTime: observedTime,
    name: "Draft invoice.pdf",
    parentIds: ["root"],
    permissions: { canRead: true, canWrite: true },
    scanGeneration: "scan-1",
    shortcutTargetId: null,
    trashed: false,
    ...overrides,
  };
}

function evidence(
  target: ObservedItem,
  overrides: Partial<EvidenceBuildResult> = {},
): EvidenceBuildResult {
  const evidenceId = `fact-${target.id}-name`;
  return {
    bundle: {
      candidateDocumentTypes: [{ confidence: 0.95, documentTypeId: "invoice" }],
      candidateEntities: [{ confidence: 0.96, entityId: "hotel-paisano" }],
      conflicts: [],
      matchedRules: [
        {
          policyLocator: "paisano:1.0.0/naming.json#invoice",
          reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
        },
      ],
      observedFacts: [
        {
          field: "item.name",
          id: evidenceId,
          source: "Observed",
          sourceLocator: `drive:item:${target.id}#name`,
          value: target.name,
        },
      ],
      sourceLocators: [
        `drive:item:${target.id}#name`,
        "paisano:1.0.0/naming.json#invoice",
      ],
      targetId: target.id,
    },
    context: {
      archive: {
        actionType: "KEEP",
        identityComponents: [],
        isArchive: false,
        isConfigured: false,
        isFrozen: false,
        itemId: target.id,
        matchedRules: [],
        preserveHierarchy: false,
        reasonCode: "PAISANO.ARCHIVE.NOT_AN_ARCHIVE",
      },
      protected: {
        actionType: "KEEP",
        flags: [],
        itemId: target.id,
        matchedRules: [],
        reasonCode: "PAISANO.PROTECTED.NO_RULE_MATCH",
      },
    },
    duplicateCandidates: [],
    namingParts: [],
    policyVersion: "1.0.0",
    reviewState: "DETERMINISTIC",
    scanGeneration: "scan-1",
    ...overrides,
  };
}

function suggestion(
  overrides: Partial<ReasoningSuggestion> = {},
): ReasoningSuggestion {
  return {
    actionType: "RENAME",
    confidence: 0.93,
    desiredState: { name: "2026-08-08 — Hotel Paisano — Invoice.pdf" },
    evidenceIds: ["fact-file-1-name"],
    rationale: "The observed name matches the invoice naming rule.",
    reasonCode: "PAISANO.NAME.DEAL_DOCUMENT",
    unresolvedQuestions: [],
    ...overrides,
  };
}

function resolved(questionKey: string): QuestionResolution {
  return {
    decision: {
      answer: "use observed invoice date",
      approver: "buck",
      createdTime: observedTime,
      decisionId: `decision-${questionKey}`,
      evidenceIds: ["fact-file-1-name"],
      policyVersion: "1.0.0",
      provenance: "HumanDecision",
      questionKey,
      scope: { id: "file-1", type: "item" },
      supersedesDecisionId: null,
    },
    reason: "ACTIVE_COMPATIBLE_DECISION",
    shouldAsk: false,
    status: "RESOLVED",
  };
}

function candidate(
  target: ObservedItem,
  suggestionOverrides: Partial<ReasoningSuggestion> = {},
  evidenceOverrides: Partial<EvidenceBuildResult> = {},
  questions: readonly {
    readonly questionKey: string;
    readonly resolution: QuestionResolution;
  }[] = [],
) {
  return {
    evidence: evidence(target, evidenceOverrides),
    questions,
    reasoning: {
      status: "VALIDATED" as const,
      suggestion: suggestion({
        evidenceIds: [`fact-${target.id}-name`],
        ...suggestionOverrides,
      }),
    },
  };
}

function plan(input: {
  candidates?: readonly ReturnType<typeof candidate>[];
  observedItems?: readonly ObservedItem[];
}) {
  const target = item();
  return buildChangePlan({
    candidates: input.candidates ?? [candidate(target)],
    observedItems: input.observedItems ?? [target],
    policyVersion: "1.0.0",
    scanGeneration: "scan-1",
  });
}

describe("deterministic change planning", () => {
  test("produces the same canonical actions and hash regardless of input order", () => {
    const first = item();
    const second = item({ id: "file-2", name: "Board memo.pdf" });
    const firstCandidate = candidate(first);
    const secondCandidate = candidate(second, {
      actionType: "KEEP",
      desiredState: { name: second.name },
      reasonCode: "PAISANO.NAME.ALREADY_COMPLIANT",
    });
    const forward = plan({
      candidates: [firstCandidate, secondCandidate],
      observedItems: [first, second],
    });
    const reverse = plan({
      candidates: [secondCandidate, firstCandidate],
      observedItems: [second, first],
    });

    expect(reverse).toEqual(forward);
    expect(forward.planHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(forward.actions[0]?.preconditions)).toBe(true);
    expect(forward).toMatchSnapshot("canonical deterministic plan");
  });

  test("excludes display confidence and rationale from the authorization hash", () => {
    const target = item();
    const first = plan({
      candidates: [candidate(target)],
      observedItems: [target],
    });
    const second = plan({
      candidates: [
        candidate(target, {
          confidence: 0.51,
          rationale: "A different display explanation.",
        }),
      ],
      observedItems: [target],
    });

    expect(first.actions[0]?.confidence).not.toBe(
      second.actions[0]?.confidence,
    );
    expect(first.planHash).toBe(second.planHash);
  });

  test("includes observed preconditions and intended after-state", () => {
    const result = plan({});
    expect(result.actions[0]).toMatchObject({
      desiredState: { name: "2026-08-08 — Hotel Paisano — Invoice.pdf" },
      preconditions: {
        modifiedTime: observedTime,
        name: "Draft invoice.pdf",
        parentIds: ["root"],
        trashed: false,
      },
      targetId: "file-1",
      type: "RENAME",
    });
  });

  test("orders renames before shortcuts and permits one valid shortcut", () => {
    const renameTarget = item();
    const shortcutTarget = item({
      id: "source-2",
      name: "Source.pdf",
      permissions: { canRead: true, canWrite: false },
    });
    const destination = item({
      id: "destination",
      mimeType: "application/vnd.google-apps.folder",
      name: "Destination",
    });
    const result = plan({
      candidates: [
        candidate(shortcutTarget, {
          actionType: "CREATE_SHORTCUT",
          desiredState: {
            name: "Source shortcut",
            parentId: destination.id,
          },
        }),
        candidate(renameTarget),
      ],
      observedItems: [destination, shortcutTarget, renameTarget],
    });

    expect(result.approvalEligible).toBe(true);
    expect(result.actions.map((action) => action.type)).toEqual([
      "RENAME",
      "CREATE_SHORTCUT",
    ]);
    expect(result.effectiveActions).toHaveLength(2);
    expect(result.actions[1]?.preconditions).toMatchObject({
      destination: { id: "destination", name: "Destination" },
      existingShortcutIds: [],
      source: { name: "Source.pdf" },
    });
  });

  test("keeps no-write explanations and excludes review actions from effective actions", () => {
    const keepTarget = item({ id: "keep", name: "Keep.pdf" });
    const archiveTarget = item({ id: "archive", name: "Archive.pdf" });
    const reviewTarget = item({ id: "review", name: "Review.pdf" });
    const result = plan({
      candidates: [
        candidate(keepTarget, {
          actionType: "KEEP",
          desiredState: { name: keepTarget.name },
        }),
        candidate(archiveTarget, {
          actionType: "PRESERVE_ARCHIVE",
          desiredState: { parentIds: archiveTarget.parentIds },
        }),
        candidate(reviewTarget, {
          actionType: "NEEDS_REVIEW",
          desiredState: {},
        }),
      ],
      observedItems: [keepTarget, archiveTarget, reviewTarget],
    });

    expect(result.explanations.map((entry) => entry.writeRequired)).toEqual([
      false,
      false,
      false,
    ]);
    expect(result.explanations.map((entry) => entry.summary)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/No write is needed/u),
        expect.stringMatching(/archive hierarchy/u),
      ]),
    );
    expect(result.effectiveActions).toEqual([]);
    expect(result.approvalEligible).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NEEDS_REVIEW_ACTION" }),
      ]),
    );
  });

  test("allows a material question only after a compatible human decision", () => {
    const target = item();
    const questionKey = "invoice.authoritative-date";
    const withQuestion = {
      evidenceIds: ["fact-file-1-name"],
      prompt: "Which invoice date is authoritative?",
      questionKey,
    };
    const unresolved = plan({
      candidates: [
        candidate(target, { unresolvedQuestions: [withQuestion] }, {}, []),
      ],
      observedItems: [target],
    });
    const answered = plan({
      candidates: [
        candidate(target, { unresolvedQuestions: [withQuestion] }, {}, [
          { questionKey, resolution: resolved(questionKey) },
        ]),
      ],
      observedItems: [target],
    });

    expect(unresolved.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNRESOLVED_QUESTION" }),
      ]),
    );
    expect(unresolved.effectiveActions).toEqual([]);
    expect(answered.approvalEligible).toBe(true);
    expect(answered.effectiveActions).toHaveLength(1);
  });
});

describe("whole-plan fail-closed validation", () => {
  test("exports planning only and has no provider or mutation surface", () => {
    expect(Object.keys(changePlanner).sort()).toEqual([
      "ChangePlanSchema",
      "PLAN_BLOCKER_CODES",
      "PLAN_HASH_CONTRACT",
      "buildChangePlan",
    ]);
  });

  test("blocks the complete plan when one target is absent", () => {
    const present = item();
    const absent = item({ id: "absent" });
    const result = plan({
      candidates: [candidate(present), candidate(absent)],
      observedItems: [present],
    });

    expect(result.approvalEligible).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TARGET_ABSENT" }),
      ]),
    );
  });

  test.each([
    {
      code: "NAME_COLLISION",
      make: () => {
        const target = item();
        const collision = item({ id: "collision", name: "Taken.pdf" });
        return plan({
          candidates: [
            candidate(target, { desiredState: { name: "Taken.pdf" } }),
          ],
          observedItems: [target, collision],
        });
      },
    },
    {
      code: "DUPLICATE_SHORTCUT",
      make: () => {
        const target = item();
        const destination = item({
          id: "destination",
          mimeType: "application/vnd.google-apps.folder",
          name: "Destination",
        });
        const existing = item({
          id: "shortcut-existing",
          mimeType: "application/vnd.google-apps.shortcut",
          name: "Invoice shortcut",
          parentIds: [destination.id],
          shortcutTargetId: target.id,
        });
        return plan({
          candidates: [
            candidate(target, {
              actionType: "CREATE_SHORTCUT",
              desiredState: {
                name: "Invoice shortcut",
                parentId: destination.id,
              },
            }),
          ],
          observedItems: [target, destination, existing],
        });
      },
    },
    {
      code: "SHORTCUT_CYCLE",
      make: () => {
        const source = item({
          id: "folder-source",
          mimeType: "application/vnd.google-apps.folder",
        });
        const descendant = item({
          id: "folder-child",
          mimeType: "application/vnd.google-apps.folder",
          parentIds: [source.id],
        });
        return plan({
          candidates: [
            candidate(source, {
              actionType: "CREATE_SHORTCUT",
              desiredState: { name: "Source", parentId: descendant.id },
            }),
          ],
          observedItems: [source, descendant],
        });
      },
    },
    {
      code: "PERMISSION_GAP",
      make: () => {
        const target = item({
          permissions: { canRead: true, canWrite: false },
        });
        return plan({
          candidates: [candidate(target)],
          observedItems: [target],
        });
      },
    },
    {
      code: "PERMISSION_GAP",
      make: () => {
        const target = item();
        const destination = item({
          id: "read-only-destination",
          mimeType: "application/vnd.google-apps.folder",
          permissions: { canRead: true, canWrite: false },
        });
        return plan({
          candidates: [
            candidate(target, {
              actionType: "CREATE_SHORTCUT",
              desiredState: {
                name: "Invoice shortcut",
                parentId: destination.id,
              },
            }),
          ],
          observedItems: [target, destination],
        });
      },
    },
    {
      code: "MATERIAL_EVIDENCE_MISSING",
      make: () => {
        const target = item();
        return plan({
          candidates: [candidate(target, { evidenceIds: ["missing-fact"] })],
          observedItems: [target],
        });
      },
    },
    {
      code: "MATERIAL_EVIDENCE_CONFLICT",
      make: () => {
        const target = item();
        const base = evidence(target);
        return plan({
          candidates: [
            candidate(
              target,
              {},
              {
                bundle: {
                  ...base.bundle,
                  conflicts: [
                    {
                      code: "CROSS_DEAL_REFERENCE",
                      material: true,
                      message:
                        "The observed and declared deal contexts conflict.",
                    },
                  ],
                },
                reviewState: "NEEDS_REVIEW",
              },
            ),
          ],
          observedItems: [target],
        });
      },
    },
    {
      code: "VERSION_MISMATCH",
      make: () => {
        const target = item();
        return plan({
          candidates: [candidate(target, {}, { policyVersion: "2.0.0" })],
          observedItems: [target],
        });
      },
    },
  ])("reports $code", ({ code, make }) => {
    const result = make();
    expect(result.approvalEligible).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  });

  test("blocks protected targets and unsafe archive suggestions", () => {
    const protectedTarget = item({ id: "protected" });
    const archiveTarget = item({ id: "archive" });
    const result = plan({
      candidates: [
        candidate(
          protectedTarget,
          {},
          {
            context: {
              ...evidence(protectedTarget).context,
              protected: {
                actionType: "NEEDS_REVIEW",
                flags: ["legal-original"],
                itemId: protectedTarget.id,
                matchedRules: [
                  {
                    policyLocator: "paisano:1.0.0/protected-items.json#legal",
                    reasonCode: "PAISANO.PROTECTED.LEGAL_ORIGINAL",
                  },
                ],
                reasonCode: "PAISANO.PROTECTED.LEGAL_ORIGINAL",
              },
            },
          },
        ),
        candidate(
          archiveTarget,
          {},
          {
            context: {
              ...evidence(archiveTarget).context,
              archive: {
                actionType: "PRESERVE_ARCHIVE",
                identityComponents: ["date", "deal"],
                isArchive: true,
                isConfigured: true,
                isFrozen: false,
                itemId: archiveTarget.id,
                matchedRules: [
                  {
                    policyLocator: "paisano:1.0.0/archive-rules.json#preserve",
                    reasonCode: "PAISANO.ARCHIVE.PRESERVE_HIERARCHY",
                  },
                ],
                preserveHierarchy: true,
                reasonCode: "PAISANO.ARCHIVE.PRESERVE_HIERARCHY",
              },
            },
          },
        ),
      ],
      observedItems: [protectedTarget, archiveTarget],
    });

    expect(result.blockers.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["ARCHIVE_PRESERVATION", "PROTECTED_ITEM"]),
    );
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: "archive",
          type: "PRESERVE_ARCHIVE",
        }),
        expect.objectContaining({
          targetId: "protected",
          type: "NEEDS_REVIEW",
        }),
      ]),
    );
  });

  test("blocks contradictory desired states for one target", () => {
    const target = item();
    const result = plan({
      candidates: [
        candidate(target, { desiredState: { name: "First.pdf" } }),
        candidate(target, { desiredState: { name: "Second.pdf" } }),
      ],
      observedItems: [target],
    });

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CONTRADICTORY_DESIRED_STATE" }),
      ]),
    );
  });

  test("blocks two planned renames that collide in one parent", () => {
    const first = item({ id: "first", name: "First.pdf" });
    const second = item({ id: "second", name: "Second.pdf" });
    const result = plan({
      candidates: [
        candidate(first, { desiredState: { name: "Same.pdf" } }),
        candidate(second, { desiredState: { name: "same.PDF" } }),
      ],
      observedItems: [first, second],
    });

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NAME_COLLISION" }),
      ]),
    );
  });

  test("enforces one shortcut per source unless an explicit exception is supplied", () => {
    const source = item({ id: "bookkeeping-source" });
    const firstDestination = item({
      id: "batch-1",
      mimeType: "application/vnd.google-apps.folder",
    });
    const secondDestination = item({
      id: "batch-2",
      mimeType: "application/vnd.google-apps.folder",
    });
    const candidates = [
      {
        ...candidate(source, {
          actionType: "CREATE_SHORTCUT",
          desiredState: { name: "Batch 1", parentId: firstDestination.id },
        }),
        maxShortcutsPerSource: null,
      },
      {
        ...candidate(source, {
          actionType: "CREATE_SHORTCUT",
          desiredState: { name: "Batch 2", parentId: secondDestination.id },
        }),
        maxShortcutsPerSource: null,
      },
    ] as const;
    const observedItems = [source, firstDestination, secondDestination];
    const excepted = plan({ candidates, observedItems });
    const defaultLimit = plan({
      candidates: candidates.map((entry) => ({
        evidence: entry.evidence,
        questions: entry.questions,
        reasoning: entry.reasoning,
      })),
      observedItems,
    });

    expect(excepted.approvalEligible).toBe(true);
    expect(excepted.effectiveActions).toHaveLength(2);
    expect(defaultLimit.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_SHORTCUT" }),
      ]),
    );
  });

  test("rejects duplicate action identities instead of emitting them twice", () => {
    const target = item();
    const duplicate = candidate(target);
    const result = plan({
      candidates: [duplicate, duplicate],
      observedItems: [target],
    });

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_ACTION" }),
      ]),
    );
  });

  test.each([
    ["unknown destructive action", { actionType: "DELETE" }],
    ["move-like rename payload", { desiredState: { parentId: "other" } }],
    ["trash field", { desiredState: { name: "Safe.pdf", trashed: true } }],
    ["content overwrite field", { desiredState: { content: "replacement" } }],
  ])("fails closed for %s", (_label, unsafe) => {
    const target = item();
    const result = plan({
      candidates: [candidate(target, unsafe as Partial<ReasoningSuggestion>)],
      observedItems: [target],
    });

    expect(result.approvalEligible).toBe(false);
    expect(result.effectiveActions).toEqual([]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_ACTION" }),
      ]),
    );
  });

  test("rejects an accessor payload without invoking it", () => {
    const target = item();
    let getterCalls = 0;
    const unsafeDesiredState = {};
    Object.defineProperty(unsafeDesiredState, "name", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "Unsafe.pdf";
      },
    });
    const baseCandidate = candidate(target);
    const unsafeCandidate = {
      ...baseCandidate,
      reasoning: {
        ...baseCandidate.reasoning,
        suggestion: {
          ...baseCandidate.reasoning.suggestion,
          desiredState: unsafeDesiredState,
        },
      },
    };
    const result = plan({
      candidates: [unsafeCandidate],
      observedItems: [target],
    });

    expect(getterCalls).toBe(0);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_ACTION" }),
      ]),
    );
  });
});
