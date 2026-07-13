// Shared-state SQLite CLI E2E tests cover startup ownership before offline maintenance.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../src/state/openclaw-state-db.js";

describe("shared-state SQLite CLI maintenance", () => {
  it("compacts after full CLI startup without retaining a config-health database handle", async () => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, ".openclaw");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
        };
        delete env.OPENCLAW_CONFIG_PATH;
        delete env.OPENCLAW_HOME;
        delete env.VITEST;

        try {
          const database = openOpenClawStateDatabase({ env });
          database.db.exec(`
            CREATE TABLE compact_cli_payload (
              id INTEGER PRIMARY KEY,
              payload TEXT NOT NULL
            );
            BEGIN IMMEDIATE;
          `);
          const insert = database.db.prepare(
            "INSERT INTO compact_cli_payload (payload) VALUES (?)",
          );
          for (let index = 0; index < 256; index += 1) {
            insert.run(`${index}:${"x".repeat(8_192)}`);
          }
          database.db.exec(`
            COMMIT;
            DELETE FROM compact_cli_payload;
            PRAGMA wal_checkpoint(TRUNCATE);
          `);
        } finally {
          closeOpenClawStateDatabase();
        }

        const entry = path.resolve(process.cwd(), "src/entry.ts");
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", entry, "doctor", "--state-sqlite", "compact", "--json"],
          {
            cwd: process.cwd(),
            env,
            encoding: "utf8",
            timeout: 60_000,
          },
        );

        expect(result.status, result.stderr || result.stdout).toBe(0);
        const report = JSON.parse(result.stdout.trim()) as {
          after: { autoVacuum: number; freelistPages: number };
          before: { freelistPages: number };
          integrityCheck: string;
          quickCheck: string;
          skipped: boolean;
        };
        expect(report).toMatchObject({
          after: {
            autoVacuum: 2,
            freelistPages: 0,
          },
          integrityCheck: "ok",
          quickCheck: "ok",
          skipped: false,
        });
        expect(report.before.freelistPages).toBeGreaterThan(0);
        expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
      },
      { prefix: "openclaw-state-sqlite-cli-" },
    );
  }, 90_000);
});
