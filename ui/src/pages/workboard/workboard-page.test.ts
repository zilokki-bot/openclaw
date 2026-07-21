import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import type { WorkboardCapability } from "../../lib/workboard/capability.ts";

const { invalidateLoads, loadWorkboardMock, stopPolling, stopLifecycleRefresh } = vi.hoisted(
  () => ({
    invalidateLoads: vi.fn(),
    loadWorkboardMock: vi.fn(async () => true),
    stopPolling: vi.fn(),
    stopLifecycleRefresh: vi.fn(),
  }),
);

vi.mock("../../lib/workboard/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workboard/index.ts")>()),
  configureWorkboardPolling: vi.fn(),
  invalidateWorkboardLoads: invalidateLoads,
  loadWorkboard: loadWorkboardMock,
  stopWorkboardLifecycleRefresh: stopLifecycleRefresh,
  stopWorkboardPolling: stopPolling,
  syncWorkboardLifecycle: vi.fn(async () => undefined),
}));

await import("./workboard-page.ts");

type WorkboardPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
};

function contextWithWorkboard(
  workboard: WorkboardCapability,
  gatewayOverride: Partial<ApplicationGatewaySnapshot> = {},
): ApplicationContext {
  const snapshot: ApplicationGatewaySnapshot = {
    client: null,
    connected: false,
    reconnecting: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    ...gatewayOverride,
  };
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway: { snapshot, subscribe } as unknown as ApplicationContext["gateway"],
    agents: {
      state: { agentsList: null, agentsLoading: false },
      subscribe,
      ensureList: vi.fn(async () => undefined),
    } as unknown as ApplicationContext["agents"],
    runtimeConfig: {
      state: {
        configSnapshot: {
          config: { plugins: { entries: { workboard: { enabled: true } } } },
        },
        configLoading: false,
      },
      subscribe,
    } as unknown as ApplicationContext["runtimeConfig"],
    sessions: {
      state: { result: null, loading: false },
      subscribe,
      refresh: vi.fn(async () => undefined),
    } as unknown as ApplicationContext["sessions"],
    workboard,
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("WorkboardPage lifecycle", () => {
  it("stops the previous capability runtime when the workboard source changes", async () => {
    const first = createWorkboardCapability();
    const second = createWorkboardCapability();
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = contextWithWorkboard(first);
    document.body.append(page);
    await page.updateComplete;
    vi.clearAllMocks();

    page.context = contextWithWorkboard(second);
    (page as unknown as { requestUpdate: () => void }).requestUpdate();
    await page.updateComplete;

    expect(stopPolling).toHaveBeenCalledWith(first);
    expect(stopLifecycleRefresh).toHaveBeenCalledWith(first);
  });

  it("reloads cards when the gateway client changes", async () => {
    const workboard = createWorkboardCapability();
    const firstClient = { request: vi.fn() } as never;
    const secondClient = { request: vi.fn() } as never;
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = contextWithWorkboard(workboard, {
      client: firstClient,
      connected: true,
    });
    document.body.append(page);
    await page.updateComplete;

    expect(invalidateLoads).toHaveBeenCalledWith(workboard);
    expect(loadWorkboardMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: workboard, client: firstClient }),
    );
    vi.clearAllMocks();

    page.context = contextWithWorkboard(workboard, {
      client: secondClient,
      connected: true,
    });
    (page as unknown as { requestUpdate: () => void }).requestUpdate();
    await page.updateComplete;

    expect(invalidateLoads).toHaveBeenCalledWith(workboard);
    expect(loadWorkboardMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: workboard, client: secondClient }),
    );
  });
});
