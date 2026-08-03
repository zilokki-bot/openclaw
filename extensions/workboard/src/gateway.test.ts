// Workboard tests cover gateway plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { dispatchOnce, registerWorkboardGatewayMethods } from "./gateway.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

describe("workboard gateway methods", () => {
  it("registers CRUD methods with read/write scopes", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    const store = new WorkboardStore(createMemoryStore());
    registerWorkboardGatewayMethods({ api, store });

    expect([...methods.keys()]).toEqual([
      "workboard.cards.list",
      "workboard.cards.create",
      "workboard.cards.safeChildCreate",
      "workboard.cards.update",
      "workboard.cards.move",
      "workboard.cards.delete",
      "workboard.cards.comment",
      "workboard.cards.link",
      "workboard.cards.linkDependency",
      "workboard.cards.proof",
      "workboard.cards.artifact",
      "workboard.cards.claim",
      "workboard.cards.heartbeat",
      "workboard.cards.release",
      "workboard.cards.promote",
      "workboard.cards.reassign",
      "workboard.cards.reclaim",
      "workboard.cards.complete",
      "workboard.cards.block",
      "workboard.cards.unblock",
      "workboard.cards.bulk",
      "workboard.cards.diagnostics",
      "workboard.cards.diagnostics.refresh",
      "workboard.cards.dispatch",
      "workboard.boards.list",
      "workboard.boards.upsert",
      "workboard.boards.archive",
      "workboard.boards.delete",
      "workboard.cards.stats",
      "workboard.cards.runs",
      "workboard.cards.specify",
      "workboard.cards.decompose",
      "workboard.notifications.subscribe",
      "workboard.notifications.list",
      "workboard.notifications.delete",
      "workboard.notifications.events",
      "workboard.notifications.advance",
      "workboard.cards.attachments.list",
      "workboard.cards.attachments.get",
      "workboard.cards.attachments.add",
      "workboard.cards.attachments.delete",
      "workboard.cards.workerLog",
      "workboard.cards.protocolViolation",
      "workboard.cards.archive",
      "workboard.cards.export",
    ]);
    expect(methods.get("workboard.cards.list")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics.refresh")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.cards.export")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.create")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.cards.safeChildCreate")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.cards.runs")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.attachments.get")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.cards.attachments.add")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.boards.upsert")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.notifications.list")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.events")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.advance")?.opts).toEqual({
      scope: "operator.write",
    });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const listHandler = methods.get("workboard.cards.list")?.handler;
    const createRespond = vi.fn();
    await createHandler?.({
      params: { title: "Investigate queue drift", priority: "urgent" },
      respond: createRespond,
    } as never);
    expect(createRespond.mock.calls[0]?.[0]).toBe(true);
    expect(
      createRespond.mock.calls[0]?.[1]?.card?.metadata?.automation?.workspaceAccess,
    ).toBeUndefined();

    const listRespond = vi.fn();
    await listHandler?.({ params: {}, respond: listRespond } as never);
    expect(listRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ title: "Investigate queue drift" })],
    });

    const archived = await store.create({ title: "Archived board history" });
    await store.archive(archived.id, true);

    const activeOnlyRespond = vi.fn();
    await listHandler?.({ params: {}, respond: activeOnlyRespond } as never);
    expect(activeOnlyRespond.mock.calls[0]?.[1]?.cards).toEqual([
      expect.objectContaining({ title: "Investigate queue drift" }),
    ]);

    const includeArchivedRespond = vi.fn();
    await listHandler?.({
      params: { includeArchived: true },
      respond: includeArchivedRespond,
    } as never);
    expect(includeArchivedRespond.mock.calls[0]?.[1]?.cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Investigate queue drift" }),
        expect.objectContaining({ title: "Archived board history" }),
      ]),
    );

    const eventsRespond = vi.fn();
    await methods.get("workboard.notifications.events")?.handler({
      params: { advance: true },
      respond: eventsRespond,
    } as never);
    expect(eventsRespond.mock.calls[0]?.[0]).toBe(false);
    expect(eventsRespond.mock.calls[0]?.[2]?.message).toContain("workboard.notifications.advance");
  });

  it("creates a safe child-create receipt from sandboxed native workboard_create readback", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const spawnSafe = vi.fn(async () => ({
      status: "accepted" as const,
      runId: "run-safe-create",
      childSessionKey: "agent:workboard-worker:subagent:create",
    }));
    const waitForRun = vi.fn(async () => ({ status: "ok" as const }));
    const getToolReceipts = vi.fn(async () => ({
      receipts: [
        {
          runId: "run-safe-create",
          toolName: "workboard_create",
          toolCallId: "tool-call-1",
          agentId: "workboard-worker",
          sessionKey: "agent:workboard-worker:subagent:create",
          toolResult: {
            card: {
              id: "safe-card",
              workspaceAccess: {
                unrestricted: false,
                sandboxed: true,
              },
            },
          },
        },
      ],
    }));
    const store = new WorkboardStore(createMemoryStore());
    const created = await store.create({
      title: "Safe child card",
      workspaceAccess: {
        unrestricted: false,
        sandboxed: true,
        agentId: "workboard-worker",
        sessionKey: "agent:workboard-worker:subagent:create",
      },
    });
    getToolReceipts.mockResolvedValue({
      receipts: [
        {
          runId: "run-safe-create",
          toolName: "workboard_create",
          toolCallId: "tool-call-1",
          agentId: "workboard-worker",
          sessionKey: "agent:workboard-worker:subagent:create",
          toolResult: {
            card: {
              id: created.id,
              workspaceAccess: {
                unrestricted: false,
                sandboxed: true,
              },
            },
          },
        },
      ],
    });
    const api = {
      runtime: {
        subagent: {
          spawnSafe,
          waitForRun,
          getToolReceipts,
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store });

    const respond = vi.fn();
    await methods.get("workboard.cards.safeChildCreate")?.handler({
      params: {
        card: {
          id: "safe-card",
          title: "Safe child card",
          idempotencyKey: "safe-pilot-1",
        },
      },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(spawnSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "workboard-worker",
        runTimeoutSeconds: 600,
        expectsCompletionMessage: false,
      }),
    );
    expect(waitForRun).toHaveBeenCalledWith({ runId: "run-safe-create", timeoutMs: 600_000 });
    expect(getToolReceipts).toHaveBeenCalledWith({
      runId: "run-safe-create",
      toolName: "workboard_create",
    });
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      receipt: {
        taskId: "run-safe-create",
        runId: "run-safe-create",
        childSessionKey: "agent:workboard-worker:subagent:create",
        agentId: "workboard-worker",
        sandboxPosture: {
          sandbox: "require",
          context: "isolated",
          mode: "run",
          cleanup: "keep",
          inheritedToolAllowlist: ["workboard_create"],
          singleRequest: true,
        },
        toolResult: {
          card: {
            id: created.id,
            workspaceAccess: {
              unrestricted: false,
              sandboxed: true,
            },
          },
        },
        readback: {
          card: expect.objectContaining({ id: created.id, title: "Safe child card" }),
          workspaceAccess: expect.objectContaining({ unrestricted: false }),
        },
      },
    });
    expect(respond.mock.calls[0]?.[1]?.receipt.argsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects safe child-create when native receipt is missing", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        subagent: {
          spawnSafe: vi.fn(async () => ({
            status: "accepted" as const,
            runId: "run-safe-create",
            childSessionKey: "agent:workboard-worker:subagent:create",
          })),
          waitForRun: vi.fn(async () => ({ status: "ok" as const })),
          getToolReceipts: vi.fn(async () => ({ receipts: [] })),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const respond = vi.fn();
    await methods.get("workboard.cards.safeChildCreate")?.handler({
      params: { card: { title: "No fake JSON" } },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]?.message).toContain("restricted workboard_create receipt");
  });

  it("rejects safe child-create when multiple restricted native receipts are returned", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        subagent: {
          spawnSafe: vi.fn(async () => ({
            status: "accepted" as const,
            runId: "run-safe-create",
            childSessionKey: "agent:workboard-worker:subagent:create",
          })),
          waitForRun: vi.fn(async () => ({ status: "ok" as const })),
          getToolReceipts: vi.fn(async () => ({
            receipts: [
              {
                runId: "run-safe-create",
                toolName: "workboard_create",
                toolResult: {
                  card: {
                    id: "safe-card-one",
                    workspaceAccess: { unrestricted: false, sandboxed: true },
                  },
                },
              },
              {
                runId: "run-safe-create",
                toolName: "workboard_create",
                toolResult: {
                  card: {
                    id: "safe-card-two",
                    workspaceAccess: { unrestricted: false, sandboxed: true },
                  },
                },
              },
            ],
          })),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const respond = vi.fn();
    await methods.get("workboard.cards.safeChildCreate")?.handler({
      params: { card: { title: "No hidden fanout" } },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]?.message).toContain(
      "multiple restricted workboard_create receipts",
    );
  });

  it("rejects safe child-create when spawn is not accepted", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        subagent: {
          spawnSafe: vi.fn(async () => ({
            status: "forbidden" as const,
            error: "sandbox required",
          })),
          waitForRun: vi.fn(),
          getToolReceipts: vi.fn(),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const respond = vi.fn();
    await methods.get("workboard.cards.safeChildCreate")?.handler({
      params: { card: { title: "No spawn" } },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]?.message).toContain("sandbox required");
    expect(api.runtime.subagent.waitForRun).not.toHaveBeenCalled();
  });

  it("rejects safe child-create escape hatches before spawning", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const spawnSafe = vi.fn();
    const api = {
      runtime: {
        subagent: {
          spawnSafe,
          waitForRun: vi.fn(),
          getToolReceipts: vi.fn(),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const wrongAgentRespond = vi.fn();
    await methods.get("workboard.cards.safeChildCreate")?.handler({
      params: { agentId: "developer", card: { title: "Wrong target" } },
      respond: wrongAgentRespond,
    } as never);
    expect(wrongAgentRespond.mock.calls[0]?.[0]).toBe(false);
    expect(wrongAgentRespond.mock.calls[0]?.[2]?.message).toContain("workboard-worker");

    const workspaceRespond = vi.fn();
    await methods.get("workboard.cards.safeChildCreate")?.handler({
      params: { workspaceDir: "/tmp/unsafe", card: { title: "Wrong workspace" } },
      respond: workspaceRespond,
    } as never);
    expect(workspaceRespond.mock.calls[0]?.[0]).toBe(false);
    expect(workspaceRespond.mock.calls[0]?.[2]?.message).toContain("workspace paths");
    expect(spawnSafe).not.toHaveBeenCalled();
  });

  it("rejects safe child-create when native receipt is unrestricted", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        subagent: {
          spawnSafe: vi.fn(async () => ({
            status: "accepted" as const,
            runId: "run-safe-create",
            childSessionKey: "agent:workboard-worker:subagent:create",
          })),
          waitForRun: vi.fn(async () => ({ status: "ok" as const })),
          getToolReceipts: vi.fn(async () => ({
            receipts: [
              {
                runId: "run-safe-create",
                toolName: "workboard_create",
                toolResult: {
                  card: {
                    id: "unsafe-card",
                    workspaceAccess: {
                      unrestricted: true,
                    },
                  },
                },
              },
            ],
          })),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const respond = vi.fn();
    await methods.get("workboard.cards.safeChildCreate")?.handler({
      params: { card: { title: "No unrestricted proof" } },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]?.message).toContain("restricted workboard_create receipt");
  });

  it("rejects safe child-create when Workboard readback does not match the receipt", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        subagent: {
          spawnSafe: vi.fn(async () => ({
            status: "accepted" as const,
            runId: "run-safe-create",
            childSessionKey: "agent:workboard-worker:subagent:create",
          })),
          waitForRun: vi.fn(async () => ({ status: "ok" as const })),
          getToolReceipts: vi.fn(async () => ({
            receipts: [
              {
                runId: "run-safe-create",
                toolName: "workboard_create",
                toolResult: {
                  card: {
                    id: "missing-card",
                    workspaceAccess: {
                      unrestricted: false,
                      sandboxed: true,
                    },
                  },
                },
              },
            ],
          })),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const respond = vi.fn();
    await methods.get("workboard.cards.safeChildCreate")?.handler({
      params: { card: { title: "No readback" } },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]?.message).toContain("Workboard readback");
  });

  it("stores metadata updates through dedicated card methods", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Carry metadata" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const commentRespond = vi.fn();
    await methods.get("workboard.cards.comment")?.handler({
      params: { id: cardId, body: "Waiting on CI" },
      respond: commentRespond,
    } as never);

    expect(commentRespond.mock.calls[0]?.[0]).toBe(true);
    expect(commentRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        metadata: {
          comments: [expect.objectContaining({ body: "Waiting on CI" })],
        },
        events: expect.arrayContaining([expect.objectContaining({ kind: "comment_added" })]),
      },
    });
  });

  it("blocks terminal status through the card move gateway method", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Needs proof" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const moveRespond = vi.fn();
    await methods.get("workboard.cards.move")?.handler({
      params: { id: cardId, status: "done" },
      respond: moveRespond,
    } as never);

    expect(moveRespond.mock.calls[0]?.[0]).toBe(false);
    expect(moveRespond.mock.calls[0]?.[2]?.message).toContain("workboard_complete with proof");
  });

  it("validates labels from comma-separated gateway input", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const respond = vi.fn();
    await createHandler?.({
      params: { title: "Check labels", labels: `valid, ${"x".repeat(41)}` },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      message: "labels must be 40 characters or fewer.",
    });
  });

  it("dispatches workboard cards when gateway params are omitted", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn().mockResolvedValue({ runId: "run-card" });
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
        subagent: { run },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Ready worker",
      status: "ready",
      priority: "urgent",
      workspace: { kind: "dir", path: "/workspace/ready" },
    });

    registerWorkboardGatewayMethods({ api, store });

    const respond = vi.fn();
    await methods.get("workboard.cards.dispatch")?.handler({ respond } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      started: [expect.objectContaining({ cardId: card.id, runId: "run-card" })],
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `subagent:workboard-default-${card.id}`,
      }),
    );
  });

  it("coalesces concurrent identical dispatch gateway calls", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    let resolveRun: ((value: { runId: string }) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<{ runId: string }>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
        subagent: { run },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Ready worker",
      status: "ready",
      priority: "urgent",
      boardId: "coalesce",
      workspace: { kind: "dir", path: "/workspace/coalesce" },
    });

    registerWorkboardGatewayMethods({ api, store });

    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const handler = methods.get("workboard.cards.dispatch")?.handler;
    const first = handler?.({
      params: { boardId: "coalesce" },
      respond: firstRespond,
    } as never);
    const second = handler?.({
      params: { boardId: "coalesce" },
      respond: secondRespond,
    } as never);

    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    resolveRun?.({ runId: "run-card" });
    await Promise.all([first, second]);

    expect(firstRespond.mock.calls[0]?.[0]).toBe(true);
    expect(secondRespond.mock.calls[0]?.[0]).toBe(true);
    expect(firstRespond.mock.calls[0]?.[1]).toMatchObject({
      started: [expect.objectContaining({ runId: "run-card" })],
    });
    expect(secondRespond.mock.calls[0]?.[1]).toMatchObject({
      started: [expect.objectContaining({ runId: "run-card" })],
    });
  });

  it("keeps concurrent dispatch calls separate when their options differ", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const resolvers: ((value: { runId: string }) => void)[] = [];
    const run = vi.fn(
      () =>
        new Promise<{ runId: string }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
        subagent: { run },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Alpha worker",
      status: "ready",
      priority: "urgent",
      boardId: "alpha",
      workspace: { kind: "dir", path: "/workspace/alpha" },
    });
    await store.create({
      title: "Beta worker",
      status: "ready",
      priority: "urgent",
      boardId: "beta",
      workspace: { kind: "dir", path: "/workspace/beta" },
    });

    registerWorkboardGatewayMethods({ api, store });

    const alphaRespond = vi.fn();
    const betaRespond = vi.fn();
    const handler = methods.get("workboard.cards.dispatch")?.handler;
    // Two boards in flight at the same time must not share one dispatch: the
    // coalescing key has to separate them, otherwise the second caller receives
    // the first board's result.
    const alpha = handler?.({ params: { boardId: "alpha" }, respond: alphaRespond } as never);
    const beta = handler?.({ params: { boardId: "beta" }, respond: betaRespond } as never);

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    resolvers[0]?.({ runId: "run-alpha" });
    resolvers[1]?.({ runId: "run-beta" });
    await Promise.all([alpha, beta]);

    expect(alphaRespond.mock.calls[0]?.[1]).toMatchObject({
      started: [expect.objectContaining({ runId: "run-alpha" })],
    });
    expect(betaRespond.mock.calls[0]?.[1]).toMatchObject({
      started: [expect.objectContaining({ runId: "run-beta" })],
    });
  });

  it("does not coalesce dispatches that differ only in an option the key used to omit", async () => {
    // The gateway handler passes only boardId and allowManagedWorktrees, so a
    // handler-level test cannot distinguish a subset key from a full-options
    // key. maxStarts is a real dispatch option the handler does not pass, and it
    // is exactly what a hand-picked key silently drops: two callers asking for
    // different start budgets on the same board would share one run, and the
    // second caller would receive bounds it never asked for. Driving dispatchOnce
    // directly is the only way to observe that.
    const resolvers: ((value: { runId: string }) => void)[] = [];
    const run = vi.fn(
      () =>
        new Promise<{ runId: string }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Budget worker one",
      status: "ready",
      priority: "urgent",
      boardId: "budget",
      workspace: { kind: "dir", path: "/workspace/budget-one" },
    });
    await store.create({
      title: "Budget worker two",
      status: "ready",
      priority: "urgent",
      boardId: "budget",
      workspace: { kind: "dir", path: "/workspace/budget-two" },
    });

    const shared = { store, subagent: { run } } as unknown as Parameters<typeof dispatchOnce>[0];
    const narrow = dispatchOnce({
      ...shared,
      options: { boardId: "budget", allowManagedWorktrees: false, maxStarts: 1 },
    });
    const wide = dispatchOnce({
      ...shared,
      options: { boardId: "budget", allowManagedWorktrees: false, maxStarts: 2 },
    });

    // Coalescing hands the second caller the *same* promise, so both awaits
    // settle to one shared result object. Two independent dispatches always
    // produce two distinct results, whatever each one manages to start. Identity
    // is therefore the signal here, not the number of started runs: the cards
    // are claimed by whichever dispatch reaches them first.
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    for (const [index, resolve] of resolvers.entries()) {
      resolve({ runId: `run-${index}` });
    }
    const [narrowResult, wideResult] = await Promise.all([narrow, wide]);

    expect(narrowResult).not.toBe(wideResult);
  });

  it("requires admin scope for managed-worktree dispatch", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn().mockResolvedValue({ runId: "run-card" });
    const createWorktree = vi.fn().mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });
    const api = {
      runtime: {
        subagent: { run },
        worktrees: {
          create: createWorktree,
          release: vi.fn(),
          removeIfLossless: vi.fn(),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const denied = await store.create({
      title: "Denied checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-denied" },
    });
    registerWorkboardGatewayMethods({ api, store });
    const handler = methods.get("workboard.cards.dispatch")?.handler;

    const deniedRespond = vi.fn();
    await handler?.({
      client: { connect: { scopes: ["operator.write"] } },
      respond: deniedRespond,
    } as never);

    expect(createWorktree).not.toHaveBeenCalled();
    expect(deniedRespond.mock.calls[0]?.[1]).toMatchObject({
      startFailures: [
        expect.objectContaining({
          cardId: denied.id,
          error: "managed worktree dispatch requires operator.admin",
        }),
      ],
    });
    await expect(store.get(denied.id)).resolves.toMatchObject({ status: "ready" });
    await store.update(denied.id, { status: "blocked" });

    const allowed = await store.create({
      title: "Allowed checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-allowed" },
    });
    await handler?.({
      client: { connect: { scopes: ["operator.admin"] } },
      respond: vi.fn(),
    } as never);

    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo-allowed", ownerId: allowed.id }),
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it("claims, heartbeats, and bulk-updates cards through gateway methods", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Claim me" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const claimRespond = vi.fn();
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: cardId, ownerId: "main" },
      respond: claimRespond,
    } as never);
    expect(claimRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "running", metadata: { claim: { ownerId: "main" } } },
      token: expect.any(String),
    });

    const heartbeatRespond = vi.fn();
    await methods.get("workboard.cards.heartbeat")?.handler({
      params: { id: cardId, ownerId: "main", note: "alive" },
      respond: heartbeatRespond,
    } as never);
    expect(heartbeatRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { metadata: { comments: [expect.objectContaining({ body: "alive" })] } },
    });

    const bulkRespond = vi.fn();
    await methods.get("workboard.cards.bulk")?.handler({
      params: { ids: [cardId], patch: { priority: "urgent" } },
      respond: bulkRespond,
    } as never);
    expect(bulkRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ priority: "urgent" })],
    });

    const completeRespond = vi.fn();
    await methods.get("workboard.cards.complete")?.handler({
      params: { id: cardId, summary: "Operator closed it." },
      respond: completeRespond,
    } as never);
    expect(completeRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        status: "done",
        metadata: {
          comments: expect.arrayContaining([
            expect.objectContaining({ body: "Operator closed it." }),
          ]),
        },
      },
    });

    const blockedCreateRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Block me" },
      respond: blockedCreateRespond,
    } as never);
    const blockedCardId = blockedCreateRespond.mock.calls[0]?.[1]?.card.id;
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: blockedCardId, ownerId: "main" },
      respond: vi.fn(),
    } as never);
    const blockRespond = vi.fn();
    await methods.get("workboard.cards.block")?.handler({
      params: { id: blockedCardId, reason: "Operator blocked it." },
      respond: blockRespond,
    } as never);
    expect(blockRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "blocked" },
    });
  });
});
