import { describe, expect, it } from "vitest";
import {
  createDeterministicClock,
  createDeterministicIdFactory,
} from "./determinism.ts";

describe("deterministic test helpers", () => {
  it("returns the configured instant without reading the system clock", () => {
    expect(createDeterministicClock("2026-08-07T12:00:00.000Z").now()).toBe(
      "2026-08-07T12:00:00.000Z",
    );
  });

  it("generates stable monotonic IDs for one namespace", () => {
    const nextId = createDeterministicIdFactory("scan");
    expect([nextId(), nextId(), nextId()]).toEqual([
      "scan-0001",
      "scan-0002",
      "scan-0003",
    ]);
  });
});
