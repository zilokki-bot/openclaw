/** Verifies prepared auth generations avoid rehydrating external profiles. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverAuthStorageFacts } from "./agent-model-discovery.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getPreparedRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const { resolveExternalAuthProfilesWithPluginsMock } = vi.hoisted(() => ({
  resolveExternalAuthProfilesWithPluginsMock: vi.fn(() => []),
}));

vi.mock("../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-runtime.js")>()),
  resolveExternalAuthProfilesWithPlugins: resolveExternalAuthProfilesWithPluginsMock,
}));

describe("prepared auth discovery", () => {
  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    resolveExternalAuthProfilesWithPluginsMock.mockClear();
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("preserves runtime external profiles and inherited main profiles without rehydration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-prepared-auth-"));
    const mainDir = path.join(root, "main");
    const agentDir = path.join(root, "agent");
    const mainStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:main": {
          type: "api_key",
          provider: "anthropic",
          key: "main-key",
        },
      },
    };
    const agentStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:local": {
          type: "api_key",
          provider: "openai",
          key: "local-key",
        },
        "external:local": {
          type: "api_key",
          provider: "external",
          key: "external-key",
        },
      },
      runtimeExternalProfileIds: ["external:local"],
      runtimeExternalProfileIdsAuthoritative: true,
    };
    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir: mainDir, store: mainStore },
        { agentDir, store: agentStore },
      ]);
      const preparedStore = getPreparedRuntimeAuthProfileStoreSnapshot(agentDir, mainDir);
      expect(preparedStore?.profiles).toEqual({
        ...mainStore.profiles,
        ...agentStore.profiles,
      });
      expect(preparedStore?.runtimeExternalProfileIds).toEqual(["external:local"]);

      const facts = discoverAuthStorageFacts(agentDir, {
        inheritedAuthDir: mainDir,
        preparedStore,
        readOnly: true,
      });
      expect(resolveExternalAuthProfilesWithPluginsMock).not.toHaveBeenCalled();
      expect(facts.store).toEqual(preparedStore);
      expect(facts.credentials.anthropic).toMatchObject({ type: "api_key", key: "main-key" });
      expect(facts.credentials.openai).toMatchObject({ type: "api_key", key: "local-key" });
      expect(facts.credentials.external).toMatchObject({ type: "api_key", key: "external-key" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
