import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";

const providerMocks = vi.hoisted(() => ({
  liveCatalog: vi.fn(),
  staticCatalog: vi.fn(),
}));
const manifestModelMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

const providerConfig = {
  providers: {
    openai: {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses" as const,
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          reasoning: true,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    },
  },
};

vi.mock("../plugins/provider-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-discovery.js")>();
  const provider: ProviderPlugin = {
    id: "openai",
    pluginId: "openai",
    label: "OpenAI",
    auth: [],
    catalog: { order: "simple", run: async () => null },
    staticCatalog: { order: "simple", run: async () => null },
  };
  return {
    ...actual,
    resolveRuntimePluginDiscoveryProviders: vi.fn(async () => [provider]),
    runProviderCatalog: providerMocks.liveCatalog,
    runProviderStaticCatalog: providerMocks.staticCatalog,
  };
});

vi.mock("../agents/embedded-agent-runner/model.static-catalog.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../agents/embedded-agent-runner/model.static-catalog.js")
    >();
  return {
    ...actual,
    createBundledStaticCatalogModelResolver: (
      ...args: Parameters<typeof actual.createBundledStaticCatalogModelResolver>
    ) => {
      const fallback = actual.createBundledStaticCatalogModelResolver(...args);
      return (lookup: { provider: string; modelId: string }) =>
        manifestModelMocks.resolve(lookup) ?? fallback(lookup);
    },
  };
});

const { resetPreparedModelRuntimeSnapshotsForTest } =
  await import("../agents/prepared-model-runtime.test-support.js");
const {
  getPreparedModelRuntimeSnapshot,
  prepareGatewayConfiguredModelRuntimeAgent,
  refreshPreparedModelRuntimeSnapshots,
} = await import("../agents/prepared-model-runtime.js");
const { writePersistedAuthProfileStoreRaw } = await import("../agents/auth-profiles/sqlite.js");
const { resolveAgentDir, resolveAgentWorkspaceDir } = await import("../agents/agent-scope.js");
const { startGatewaySidecars } = await import("./server-startup-post-attach.js");

beforeEach(() => {
  resetPreparedModelRuntimeSnapshotsForTest();
  vi.clearAllMocks();
});

async function listenGatewayProbe(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz" || req.url === "/rpc/ping") {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, status: req.url === "/readyz" ? "ready" : "live" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback health server address");
  }
  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function requestAfter(port: number, pathname: string, delayMs: number) {
  const startedAt = performance.now();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { elapsedMs: performance.now() - startedAt, response };
}

afterEach(() => {
  resetPreparedModelRuntimeSnapshotsForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.clearAllMocks();
});

describe("Gateway prepared model runtime startup", () => {
  it("keeps health probes responsive without executing unnecessary provider catalogs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-model-runtime-startup-"));
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      plugins: { enabled: false },
    } satisfies OpenClawConfig;
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const agentDir = resolveAgentDir(cfg, "main", env);
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "openai:startup": {
            type: "api_key",
            provider: "openai",
            key: "test-openai-api-key",
          },
        },
        order: { openai: ["openai:startup"] },
      },
      agentDir,
    );
    const blockEventLoop = async () => {
      const stopAt = performance.now() + 1_500;
      while (performance.now() < stopAt) {
        // Deliberately model synchronous provider/plugin catalog work that starves timers.
      }
      return providerConfig;
    };
    providerMocks.staticCatalog.mockImplementation(blockEventLoop);
    providerMocks.liveCatalog.mockImplementation(blockEventLoop);
    const healthServer = await listenGatewayProbe();

    try {
      await withEnvAsync(
        {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          const probe = requestAfter(healthServer.port, "/healthz", 25);
          const sidecars = startGatewaySidecars({
            cfg,
            pluginRegistry: { plugins: [], typedHooks: [] } as never,
            defaultWorkspaceDir: workspaceDir,
            deps: {} as never,
            startChannels: vi.fn(async () => {}),
            shouldStartPluginServices: () => false,
            log: { warn: vi.fn() },
            logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            logChannels: { info: vi.fn(), error: vi.fn() },
          });

          const [{ elapsedMs, response }] = await Promise.all([probe, sidecars]);
          expect(response.status).toBe(200);
          // The configured model is already resolved from manifest facts. Either provider hook
          // would deliberately block the event loop well beyond this responsiveness guard.
          expect(elapsedMs).toBeLessThan(1_000);
          expect(providerMocks.staticCatalog).not.toHaveBeenCalled();
          expect(providerMocks.liveCatalog).not.toHaveBeenCalled();
        },
      );
    } finally {
      await healthServer.close();
      closeOpenClawAgentDatabasesForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps 21-agent 19-workspace 168-model startup responsive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-model-runtime-fleet-startup-"));
    const stateDir = path.join(root, "state");
    const workspaces = Array.from({ length: 19 }, (_, index) =>
      path.join(root, `workspace-${index}`),
    );
    const modelEntries = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `openai/fleet-${index}`,
        { agentRuntime: { id: "openclaw" } },
      ]),
    );
    const agents = Array.from({ length: 21 }, (_, index) => ({
      id: index === 0 ? "main" : `agent-${index}`,
      ...(index === 0 ? { default: true } : {}),
      workspace: workspaces[Math.min(index, 18)],
      model: { primary: "openai/fleet-0" },
      models: modelEntries,
    }));
    const configuredProjectionCount = agents.reduce(
      (count, agent) => count + Object.keys(agent.models).length,
      0,
    );
    expect(configuredProjectionCount).toBe(168);
    const staticModels = Array.from({ length: 8 }, (_, index) => ({
      id: `fleet-${index}`,
      name: `Fleet ${index}`,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_096,
    }));
    const cfg = {
      agents: { list: agents },
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: staticModels,
          },
        },
      },
      plugins: { enabled: false },
    } satisfies OpenClawConfig;
    providerMocks.staticCatalog.mockImplementation(() => {
      const stopAt = performance.now() + 35;
      while (performance.now() < stopAt) {
        // Scale the production synchronous workspace-facts cost deterministically.
      }
      return {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: staticModels,
          },
        },
      };
    });
    manifestModelMocks.resolve.mockImplementation(
      ({ provider, modelId }: { provider: string; modelId: string }) => {
        if (provider !== "openai" || !modelId.startsWith("fleet-")) {
          return undefined;
        }
        return {
          id: modelId,
          name: modelId,
          provider,
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 4_096,
        };
      },
    );
    const gatewayProbe = await listenGatewayProbe();

    try {
      await withEnvAsync(
        {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          const traceDetails: Array<{
            name: string;
            metrics: ReadonlyArray<readonly [string, number | string]>;
          }> = [];
          const startupTrace = {
            detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) =>
              traceDetails.push({ name, metrics }),
            mark: vi.fn(),
            measure: async <T>(_name: string, run: () => T | Promise<T>) => await run(),
          };
          const probes = ["/healthz", "/readyz", "/rpc/ping"].map((pathname) =>
            requestAfter(gatewayProbe.port, pathname, 25),
          );
          const startup = startGatewaySidecars({
            cfg,
            pluginRegistry: { plugins: [], typedHooks: [] } as never,
            defaultWorkspaceDir: workspaces[0]!,
            deps: {} as never,
            startChannels: vi.fn(async () => {}),
            shouldStartPluginServices: () => false,
            log: { warn: vi.fn() },
            logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            logChannels: { info: vi.fn(), error: vi.fn() },
            startupTrace,
          });

          const [probeResults, sidecars] = await Promise.all([Promise.all(probes), startup]);
          expect(providerMocks.staticCatalog).not.toHaveBeenCalled();
          expect(traceDetails).not.toContainEqual(
            expect.objectContaining({ name: "sidecars.model-runtime-build" }),
          );
          const readinessRssBytes = process.memoryUsage().rss;

          const postReadyProbes = ["/healthz", "/readyz", "/rpc/ping"].map((pathname) =>
            requestAfter(gatewayProbe.port, pathname, 25),
          );
          const lazyStartedAt = performance.now();
          const [, lazyProbeResults] = await Promise.all([
            prepareGatewayConfiguredModelRuntimeAgent("agent-20"),
            Promise.all(postReadyProbes),
          ]);
          const firstNondefaultMs = performance.now() - lazyStartedAt;
          const lazySnapshot = getPreparedModelRuntimeSnapshot({
            agentId: "agent-20",
            agentDir: resolveAgentDir(cfg, "agent-20"),
            workspaceDir: resolveAgentWorkspaceDir(cfg, "agent-20"),
            config: cfg,
          });
          const lazyBuildDetail = traceDetails.find(
            ({ name }) => name === "sidecars.model-runtime-build",
          );
          const lazyMetrics = Object.fromEntries(lazyBuildDetail?.metrics ?? []);
          const lazyRssBytes = process.memoryUsage().rss;
          expect(lazySnapshot).toBeDefined();
          expect(lazySnapshot?.agentId).toBe("agent-20");
          expect(lazyMetrics.agentCount).toBe(1);
          expect(lazyMetrics.workspaceGroupCount).toBe(1);
          // Eight model projections plus the selected primary reference are materialized.
          expect(lazyMetrics.configuredModelRefCount).toBe(9);
          expect(lazyMetrics.configuredRuntimeModelCount).toBe(8);
          expect(Number(lazyMetrics.staticProviderPlanningMs)).toBeGreaterThanOrEqual(0);
          expect(Number(lazyMetrics.workspaceUnattributedMs)).toBeLessThan(100);
          expect(lazyRssBytes - readinessRssBytes).toBeLessThan(256 * 1024 * 1024);

          let fullFleetMetrics: Record<string, number> = {};
          const fullFleetStartedAt = performance.now();
          await refreshPreparedModelRuntimeSnapshots(cfg, {
            gatewayLifecycle: true,
            catalogMode: "static",
            defaultWorkspaceDir: workspaces[0]!,
            onBuildStats: (stats) => {
              fullFleetMetrics = { ...stats };
            },
          });
          const fullFleetFixtureMs = performance.now() - fullFleetStartedAt;
          expect(fullFleetMetrics.agentCount).toBe(21);
          expect(fullFleetMetrics.workspaceGroupCount).toBe(19);
          expect(fullFleetMetrics.configuredRuntimeModelCount).toBe(168);
          expect(fullFleetMetrics.workspaceUnattributedMs).toBeLessThan(100);
          const fullFleetRssBytes = process.memoryUsage().rss;
          expect(fullFleetRssBytes - readinessRssBytes).toBeLessThan(512 * 1024 * 1024);
          if (process.env.OPENCLAW_BENCHMARK_OUTPUT === "1") {
            process.stdout.write(
              `${JSON.stringify({
                benchmark: "gateway-startup-21x19x168",
                readinessMaxProbeMs: Math.max(...probeResults.map(({ elapsedMs }) => elapsedMs)),
                firstNondefaultMs,
                postReadyMaxProbeMs: Math.max(
                  ...lazyProbeResults.map(({ elapsedMs }) => elapsedMs),
                ),
                staticCatalogCalls: providerMocks.staticCatalog.mock.calls.length,
                configuredProjectionCount,
                readinessRssBytes,
                lazyBuild: lazyMetrics,
                lazyRssBytes,
                fullFleetFixtureMs,
                fullFleetBuild: fullFleetMetrics,
                fullFleetRssBytes,
              })}\n`,
            );
          }
          for (const { elapsedMs, response } of probeResults) {
            expect(response.status).toBe(200);
            expect(elapsedMs).toBeLessThan(1_000);
          }
          for (const { elapsedMs, response } of lazyProbeResults) {
            expect(response.status).toBe(200);
            // Allow loaded CI scheduling jitter while staying below the deterministic 1.5s
            // provider-hook stall this request-driven build must never fan out across workspaces.
            expect(elapsedMs).toBeLessThan(1_250);
          }
          // Readiness publishes only the authoritative seed. Exactly one non-default workspace is
          // materialized by the first request rather than admitting all 19 workspace groups.
          expect(providerMocks.staticCatalog.mock.calls.length).toBeLessThan(19);
          for (const sidecar of sidecars.postReadySidecars) {
            await sidecar.stop();
          }
        },
      );
    } finally {
      await gatewayProbe.close();
      closeOpenClawAgentDatabasesForTest();
      await rm(root, { recursive: true, force: true });
    }
  });
});
