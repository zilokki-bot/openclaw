// Covers the one-time fold of the legacy nodes/*.json store into device records.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { migrateLegacyNodePairingStore } from "./node-pairing-migration.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-node-pairing-migration-" });

describe("migrateLegacyNodePairingStore", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  test("returns null when no legacy store exists", async () => {
    const baseDir = await suiteRootTracker.make("case");
    await expect(migrateLegacyNodePairingStore({ baseDir })).resolves.toBeNull();
  });
});
