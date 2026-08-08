import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DriveLab, LAB_SCENARIOS } from "@dvw/drive-simulator";
import { describe, expect, test } from "vitest";
import { resetAdversarialFixtures } from "../../scripts/reset-fixtures.js";

describe("append-only adversarial fixture reset", () => {
  test("initializes every lab and restores changed state without a cleanup path", () => {
    const root = mkdtempSync(join(tmpdir(), "dvw-adversarial-reset-"));
    const initialized = resetAdversarialFixtures(root);

    expect(initialized.map((entry) => entry.scenario)).toEqual(LAB_SCENARIOS);
    expect(
      initialized.every((entry) => entry.operation === "Initialized"),
    ).toBe(true);

    const messyRoot = join(root, "messy-paisano");
    const messy = DriveLab.open(messyRoot);
    const baselineHash = messy.baselineSnapshot().hash;
    messy.applyEdit({
      itemId: "messy-invoice-draft",
      name: "Synthetic operator edit.pdf",
      type: "rename",
    });
    expect(messy.snapshot().hash).not.toBe(baselineHash);

    const reset = resetAdversarialFixtures(root);
    expect(reset.every((entry) => entry.operation === "Reset")).toBe(true);
    for (const scenario of LAB_SCENARIOS) {
      const lab = DriveLab.open(join(root, scenario));
      expect(lab.snapshot().hash).toBe(lab.baselineSnapshot().hash);
    }

    const script = readFileSync(
      fileURLToPath(
        new URL("../../scripts/reset-fixtures.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(script).not.toMatch(/\b(?:rm|unlink|rmdir|rename)Sync\b/u);
    expect(script).not.toMatch(/\b(?:rm|unlink|rmdir)\s*\(/u);
  });
});
