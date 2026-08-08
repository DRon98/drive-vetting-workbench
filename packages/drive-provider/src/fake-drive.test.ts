import type {
  CreateShortcutRequest,
  MutationResult,
  ObservedItem,
  ProviderResult,
  RenameRequest,
} from "@dvw/core";
import { describe, expect, test } from "vitest";

import contractFixtureJson from "../../../fixtures/drive-provider/contract-fixture.json" with { type: "json" };

import {
  createInstrumentedFakeDrive,
  type FakeDriveFixture,
  type FakeDriveMethod,
} from "./fake-drive.js";

const contractFixture: FakeDriveFixture = contractFixtureJson;

function getValue<Value>(result: ProviderResult<Value>): Value {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function getError<Value>(result: ProviderResult<Value>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected the fake provider to return a typed error.");
  }
  return result.error;
}

function requestPage(pageToken: string | null, supportsAllDrives = true) {
  return {
    pageSize: 2,
    pageToken,
    rootId: "root",
    supportsAllDrives,
  } as const;
}

describe("instrumented fake Drive reads", () => {
  test("requires the returned page token before exposing a later-page item", async () => {
    const drive = createInstrumentedFakeDrive(contractFixture);

    const firstPage = getValue(await drive.read.listItems(requestPage(null)));
    expect(firstPage.items.map((item) => item.id)).toEqual([
      "document-one",
      "permission-denied",
    ]);
    expect(firstPage.nextPageToken).not.toBeNull();

    const repeatedFirstPage = getValue(
      await drive.read.listItems(requestPage(null)),
    );
    expect(repeatedFirstPage.items.map((item) => item.id)).not.toContain(
      "shortcut-b",
    );

    const secondPage = getValue(
      await drive.read.listItems(requestPage(firstPage.nextPageToken)),
    );
    expect(secondPage.items.map((item) => item.id)).toEqual([
      "shortcut-a",
      "shortcut-b",
    ]);
    expect(secondPage.nextPageToken).toBeNull();
    expect(
      drive.calls
        .filter((call) => call.method === "listItems")
        .map((call) => call.request),
    ).toEqual([
      requestPage(null),
      requestPage(null),
      requestPage(firstPage.nextPageToken),
    ]);
  });

  test("requires the Shared Drive support flag for a shared result page", async () => {
    const drive = createInstrumentedFakeDrive(contractFixture);

    const result = await drive.read.listItems(requestPage(null, false));

    expect(getError(result)).toEqual({
      code: "PROVIDER_FAILURE",
      itemId: "root",
      message: "Shared Drive access requires supportsAllDrives.",
      retryable: false,
    });
  });

  test("returns permission and export failures with target item context", async () => {
    const drive = createInstrumentedFakeDrive(contractFixture);

    const deniedGet = await drive.read.getItem("permission-denied");
    expect(getError(deniedGet)).toMatchObject({
      code: "DENIED",
      itemId: "permission-denied",
      retryable: false,
    });

    const deniedExport = await drive.read.exportItem({
      exportMimeType: "text/plain",
      itemId: "permission-denied",
    });
    expect(getError(deniedExport)).toMatchObject({
      code: "DENIED",
      itemId: "permission-denied",
    });

    const unsupportedExport = await drive.read.exportItem({
      exportMimeType: "application/pdf",
      itemId: "document-one",
    });
    expect(getError(unsupportedExport)).toMatchObject({
      code: "UNSUPPORTED_EXPORT",
      itemId: "document-one",
      retryable: false,
    });
  });

  test("exports synthetic Google-native content without external access", async () => {
    const drive = createInstrumentedFakeDrive(contractFixture);

    const exported = getValue(
      await drive.read.exportItem({
        exportMimeType: "text/plain",
        itemId: "document-one",
      }),
    );

    expect(exported.mimeType).toBe("text/plain");
    expect(new TextDecoder().decode(exported.bytes)).toBe(
      "Synthetic document one",
    );
  });

  test("preserves stable IDs, parents, trashed state, and representable shortcut cycles", async () => {
    const drive = createInstrumentedFakeDrive(contractFixture);
    const first = getValue(await drive.read.getItem("shortcut-a"));
    const second = getValue(await drive.read.getItem("shortcut-b"));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null) {
      throw new Error("The shortcut-cycle fixture is incomplete.");
    }

    expect(first).toMatchObject({
      id: "shortcut-a",
      parentIds: ["root"],
      shortcutTargetId: "shortcut-b",
      trashed: false,
    });
    expect(second).toMatchObject({
      id: "shortcut-b",
      parentIds: ["root"],
      shortcutTargetId: "shortcut-a",
      trashed: true,
    });

    const followedIds = new Set<string>();
    let current: ObservedItem | null = first;
    let cycleDetected = false;
    while (current !== null && current.shortcutTargetId !== null) {
      if (followedIds.has(current.id)) {
        cycleDetected = true;
        break;
      }
      followedIds.add(current.id);
      current = getValue(await drive.read.getItem(current.shortcutTargetId));
    }
    expect(cycleDetected).toBe(true);
  });

  test("injects a typed rate limit on a selected method call", async () => {
    const drive = createInstrumentedFakeDrive(contractFixture);
    drive.controls.failOnCall("exportItem", 1, {
      code: "RATE_LIMITED",
      itemId: "document-one",
      message: "Synthetic quota window.",
      retryable: true,
    });

    const first = await drive.read.exportItem({
      exportMimeType: "text/plain",
      itemId: "document-one",
    });
    expect(getError(first)).toEqual({
      code: "RATE_LIMITED",
      itemId: "document-one",
      message: "Synthetic quota window.",
      retryable: true,
    });

    const second = await drive.read.exportItem({
      exportMimeType: "text/plain",
      itemId: "document-one",
    });
    expect(getValue(second).mimeType).toBe("text/plain");
  });
});

describe("instrumented fake Drive mutations", () => {
  const renameRequest: RenameRequest = {
    expectedModifiedTime: "2026-01-02T00:00:00.000Z",
    name: "Renamed Document",
    targetId: "document-one",
  };

  const shortcutRequest: CreateShortcutRequest = {
    name: "Organized Link",
    parentId: "root",
    targetId: "document-one",
  };

  test("exposes distinct read and mutation providers with no destructive mutation method", () => {
    const drive = createInstrumentedFakeDrive(contractFixture);

    expect(drive.read.capability).toBe("read");
    expect(drive.mutation.capability).toBe("mutation");
    const mutationMethods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(drive.mutation) as object,
    );
    expect(mutationMethods).toEqual(
      expect.arrayContaining(["rename", "createShortcut"]),
    );
    expect(mutationMethods.join(" ")).not.toMatch(
      /delete|trash|move|overwrite|content.?update/i,
    );
  });

  test("counts zero, one, and repeated successful provider writes", async () => {
    let clockTick = 0;
    const drive = createInstrumentedFakeDrive(contractFixture, {
      now: () =>
        ["2026-02-01T00:00:00.000Z", "2026-02-02T00:00:00.000Z"][clockTick++] ??
        "2026-02-03T00:00:00.000Z",
    });
    expect(drive.writeCount).toBe(0);

    const renamed = getValue(await drive.mutation.rename(renameRequest));
    expect(renamed).toMatchObject({
      id: "document-one",
      modifiedTime: "2026-02-01T00:00:00.000Z",
      name: "Renamed Document",
    });
    expect(drive.writeCount).toBe(1);

    const secondRename = getValue(
      await drive.mutation.rename({
        ...renameRequest,
        expectedModifiedTime: renamed.modifiedTime,
        name: "Renamed Again",
      }),
    );
    expect(secondRename.id).toBe("document-one");
    expect(drive.writeCount).toBe(2);
    expect(drive.mutationRequests.map((entry) => entry.method)).toEqual([
      "rename",
      "rename",
    ]);
  });

  test("fails stale rename preconditions after a controlled external state change", async () => {
    const drive = createInstrumentedFakeDrive(contractFixture);
    drive.controls.advanceModifiedTime(
      "document-one",
      "2026-03-01T00:00:00.000Z",
    );

    const result = await drive.mutation.rename(renameRequest);

    expect(getError(result)).toEqual({
      code: "STALE_STATE",
      itemId: "document-one",
      message: "The item changed after it was observed.",
      retryable: false,
    });
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toHaveLength(1);
  });

  test("supports a successful write followed by an injected partial failure", async () => {
    const drive = createInstrumentedFakeDrive(contractFixture, {
      idFactory: (sequence) => `shortcut-created-${sequence}`,
      now: () => "2026-04-01T00:00:00.000Z",
    });
    drive.controls.failOnCall("createShortcut", 2, {
      code: "PROVIDER_FAILURE",
      itemId: "document-one",
      message: "Synthetic second-write failure.",
      retryable: true,
    });

    const first = getValue(
      await drive.mutation.createShortcut(shortcutRequest),
    );
    expect(first).toMatchObject({
      id: "shortcut-created-1",
      parentIds: ["root"],
      shortcutTargetId: "document-one",
    });
    expect(drive.writeCount).toBe(1);

    const failed = await drive.mutation.createShortcut({
      ...shortcutRequest,
      name: "Second Link",
    });
    expect(getError(failed)).toMatchObject({
      code: "PROVIDER_FAILURE",
      itemId: "document-one",
      retryable: true,
    });
    expect(drive.writeCount).toBe(1);

    const third = getValue(
      await drive.mutation.createShortcut({
        ...shortcutRequest,
        name: "Third Link",
      }),
    );
    expect(third.id).toBe("shortcut-created-2");
    expect(drive.writeCount).toBe(2);
    expect(drive.mutationRequests).toHaveLength(3);
  });

  test("records every method call separately from successful mutations", async () => {
    const drive = createInstrumentedFakeDrive(contractFixture);

    await drive.read.getItem("document-one");
    await drive.mutation.rename(renameRequest);
    await drive.mutation.createShortcut(shortcutRequest);

    expect(drive.calls.map((entry) => entry.method)).toEqual([
      "getItem",
      "rename",
      "createShortcut",
    ] satisfies FakeDriveMethod[]);
    expect(drive.mutationRequests).toEqual([
      { method: "rename", request: renameRequest },
      { method: "createShortcut", request: shortcutRequest },
    ]);
  });

  test("keeps failed mutation results out of the successful write count", async () => {
    const drive = createInstrumentedFakeDrive(contractFixture);
    const missingTargetResult: ProviderResult<MutationResult> =
      await drive.mutation.rename({
        ...renameRequest,
        targetId: "missing",
      });

    expect(getError(missingTargetResult)).toMatchObject({
      code: "NOT_FOUND",
      itemId: "missing",
    });
    expect(drive.writeCount).toBe(0);
    expect(drive.mutationRequests).toHaveLength(1);
  });
});
