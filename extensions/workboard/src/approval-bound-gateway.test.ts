// Workboard tests cover gateway plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

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
  it("binds approval requests to a server-derived digest of card, revision, and exact patch", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const requestApproval = vi.fn(async () => ({ status: "accepted", id: "plugin:bound" }));
    const api = {
      runtime: { approvalBoundMutation: { request: requestApproval } },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Approval digest" });
    registerWorkboardGatewayMethods({ api, store });
    const handler = methods.get("workboard.cards.approvalBoundRequest")?.handler;

    const firstRespond = vi.fn();
    await handler?.({
      params: {
        id: card.id,
        expectedRevision: 0,
        patch: { notes: "approved exact value" },
      },
      respond: firstRespond,
    } as never);
    const firstMutationId = requestApproval.mock.calls[0]?.[0].mutationId;
    expect(firstMutationId).toMatch(/^workboard-card-update:[a-f0-9]{64}$/);
    expect(requestApproval.mock.calls[0]?.[0]).toMatchObject({
      resourceKind: "workboard-card",
      resourceId: card.id,
      expectedRevision: 0,
    });
    expect(requestApproval.mock.calls[0]?.[0].description).toContain(`card=${card.id}`);
    expect(requestApproval.mock.calls[0]?.[0].description).toContain("revision=0");
    expect(requestApproval.mock.calls[0]?.[0].description).toContain("fields=notes");
    expect(requestApproval.mock.calls[0]?.[0].description).toContain(`mutation=${firstMutationId}`);

    const secondRespond = vi.fn();
    await handler?.({
      params: {
        id: card.id,
        expectedRevision: 0,
        patch: { notes: "different value" },
      },
      respond: secondRespond,
    } as never);
    expect(requestApproval.mock.calls[1]?.[0].mutationId).not.toBe(firstMutationId);
  });

  it("never releases a durable receipt and finalizes after a later card revision", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-gateway-cas-"));
    const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
    try {
      const methods = new Map<string, RegisteredMethod>();
      const reserve = vi.fn(() => ({ outcome: "already-reserved" as const, reservation: {} }));
      const finalize = vi.fn(() => ({ outcome: "finalized", reservation: {} }));
      const release = vi.fn();
      const api = {
        runtime: { approvalBoundMutation: { reserve, finalize, release } },
        registerGatewayMethod: vi.fn(
          (
            method: string,
            handler: RegisteredMethod["handler"],
            opts: RegisteredMethod["opts"],
          ) => {
            methods.set(method, { handler, opts });
          },
        ),
      } as unknown as OpenClawPluginApi;
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const card = await store.create({ title: "Recoverable card" });
      const lookupApprovalMutationReceipt = store.lookupApprovalMutationReceipt.bind(store);
      const lookupSpy = vi
        .spyOn(store, "lookupApprovalMutationReceipt")
        .mockImplementationOnce(lookupApprovalMutationReceipt)
        .mockRejectedValueOnce(new Error("simulated receipt readback failure"));
      const updateIfRevision = store.updateIfRevision.bind(store);
      vi.spyOn(store, "updateIfRevision").mockImplementationOnce(async (params) => {
        await updateIfRevision(params);
        throw new Error("simulated post-commit cleanup failure");
      });
      registerWorkboardGatewayMethods({ api, store });
      const handler = methods.get("workboard.cards.approvalBoundUpdate")?.handler;
      const request = {
        params: {
          id: card.id,
          approvalId: "approval-a",
          mutationId: "mutation-a",
          expectedRevision: 0,
          patch: { notes: "approved" },
        },
        client: {
          connect: { client: { id: "client-a" }, device: { id: "device-a" } },
          isDeviceTokenAuth: true,
        },
      };

      const firstRespond = vi.fn();
      await handler?.({ ...request, respond: firstRespond } as never);
      expect(firstRespond.mock.calls[0]?.[0]).toBe(false);
      expect(firstRespond.mock.calls[0]?.[2]?.message).toContain(
        "simulated post-commit cleanup failure",
      );
      expect(await store.get(card.id)).toMatchObject({ revision: 1, notes: "approved" });
      expect(release).not.toHaveBeenCalled();
      expect(lookupSpy).toHaveBeenCalledTimes(1);

      lookupSpy.mockReset().mockImplementation(lookupApprovalMutationReceipt);

      await store.update(card.id, { notes: "later legitimate update" });
      expect(await store.get(card.id)).toMatchObject({
        revision: 2,
        notes: "later legitimate update",
      });

      const retryRespond = vi.fn();
      await handler?.({ ...request, respond: retryRespond } as never);
      expect(retryRespond.mock.calls[0]?.[0]).toBe(true);
      expect(retryRespond.mock.calls[0]?.[1]).toMatchObject({
        replayed: true,
        card: { revision: 2, notes: "later legitimate update" },
        receipt: { approvalId: "approval-a", oldRevision: 0, newRevision: 1 },
      });
      // Recovery-by-receipt runs before the expiry-sensitive reserve(), so the
      // retry never consults it: reserve() is called once, on the first attempt.
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(finalize).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
    } finally {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers by receipt after the redemption window has expired", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-gateway-expiry-"));
    const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
    try {
      const methods = new Map<string, RegisteredMethod>();
      // reserve() succeeds once, then behaves like an expired redemption window
      // for every later call — the exact state after a crash + a late retry.
      let reserveCalls = 0;
      const reserve = vi.fn(() => {
        reserveCalls += 1;
        if (reserveCalls > 1) {
          throw new Error("approval redemption window expired");
        }
        return { outcome: "reserved" as const, reservation: {} };
      });
      const finalize = vi.fn(() => ({ outcome: "finalized", reservation: {} }));
      const release = vi.fn();
      const api = {
        runtime: { approvalBoundMutation: { reserve, finalize, release } },
        registerGatewayMethod: vi.fn(
          (
            method: string,
            handler: RegisteredMethod["handler"],
            opts: RegisteredMethod["opts"],
          ) => {
            methods.set(method, { handler, opts });
          },
        ),
      } as unknown as OpenClawPluginApi;
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const card = await store.create({ title: "Late retry card" });
      // Crash after the card write commits: the receipt is durable, finalize never runs.
      const updateIfRevision = store.updateIfRevision.bind(store);
      vi.spyOn(store, "updateIfRevision").mockImplementationOnce(async (params) => {
        await updateIfRevision(params);
        throw new Error("simulated crash after card commit");
      });
      registerWorkboardGatewayMethods({ api, store });
      const handler = methods.get("workboard.cards.approvalBoundUpdate")?.handler;
      const request = {
        params: {
          id: card.id,
          approvalId: "approval-expired",
          mutationId: "mutation-expired",
          expectedRevision: 0,
          patch: { notes: "approved once" },
        },
        client: {
          connect: { client: { id: "client-a" }, device: { id: "device-a" } },
          isDeviceTokenAuth: true,
        },
      };

      const firstRespond = vi.fn();
      await handler?.({ ...request, respond: firstRespond } as never);
      expect(firstRespond.mock.calls[0]?.[0]).toBe(false);
      expect(await store.get(card.id)).toMatchObject({ revision: 1, notes: "approved once" });
      expect(finalize).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();

      // The late retry must replay from the receipt and finalize, never reaching
      // the expiry-sensitive reserve().
      const retryRespond = vi.fn();
      await handler?.({ ...request, respond: retryRespond } as never);
      expect(retryRespond.mock.calls[0]?.[0]).toBe(true);
      expect(retryRespond.mock.calls[0]?.[1]).toMatchObject({
        replayed: true,
        receipt: { approvalId: "approval-expired", oldRevision: 0, newRevision: 1 },
      });
      expect(finalize).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      // reserve() must NOT be consulted on the recovery path.
      expect(reserve).toHaveBeenCalledTimes(1);
      // and no second card mutation happened.
      expect(await store.get(card.id)).toMatchObject({ revision: 1, notes: "approved once" });
    } finally {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still rejects an expired reserve when no receipt exists", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-gateway-noreceipt-"));
    const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
    try {
      const methods = new Map<string, RegisteredMethod>();
      const reserve = vi.fn(() => {
        throw new Error("approval redemption window expired");
      });
      const finalize = vi.fn();
      const release = vi.fn();
      const api = {
        runtime: { approvalBoundMutation: { reserve, finalize, release } },
        registerGatewayMethod: vi.fn(
          (
            method: string,
            handler: RegisteredMethod["handler"],
            opts: RegisteredMethod["opts"],
          ) => {
            methods.set(method, { handler, opts });
          },
        ),
      } as unknown as OpenClawPluginApi;
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const card = await store.create({ title: "No receipt card" });
      registerWorkboardGatewayMethods({ api, store });
      const handler = methods.get("workboard.cards.approvalBoundUpdate")?.handler;
      const respond = vi.fn();
      await handler?.({
        params: {
          id: card.id,
          approvalId: "approval-none",
          mutationId: "mutation-none",
          expectedRevision: 0,
          patch: { notes: "never applied" },
        },
        client: {
          connect: { client: { id: "client-a" }, device: { id: "device-a" } },
          isDeviceTokenAuth: true,
        },
        respond,
      } as never);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[2]?.message).toContain("redemption window expired");
      expect(finalize).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(await store.get(card.id)).toMatchObject({ revision: 0 });
    } finally {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a stale or forged receipt instead of replaying it", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-gateway-forged-"));
    const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
    try {
      const methods = new Map<string, RegisteredMethod>();
      let reserveCalls = 0;
      const reserve = vi.fn(() => {
        reserveCalls += 1;
        if (reserveCalls > 1) {
          throw new Error("approval redemption window expired");
        }
        return { outcome: "reserved" as const, reservation: {} };
      });
      const finalize = vi.fn(() => ({ outcome: "finalized", reservation: {} }));
      const release = vi.fn();
      const api = {
        runtime: { approvalBoundMutation: { reserve, finalize, release } },
        registerGatewayMethod: vi.fn(
          (
            method: string,
            handler: RegisteredMethod["handler"],
            opts: RegisteredMethod["opts"],
          ) => {
            methods.set(method, { handler, opts });
          },
        ),
      } as unknown as OpenClawPluginApi;
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const card = await store.create({ title: "Forged receipt card" });
      const updateIfRevision = store.updateIfRevision.bind(store);
      vi.spyOn(store, "updateIfRevision").mockImplementationOnce(async (params) => {
        await updateIfRevision(params);
        throw new Error("simulated crash after card commit");
      });
      registerWorkboardGatewayMethods({ api, store });
      const handler = methods.get("workboard.cards.approvalBoundUpdate")?.handler;
      const base = {
        params: {
          id: card.id,
          approvalId: "approval-forged",
          mutationId: "mutation-forged",
          expectedRevision: 0,
          patch: { notes: "approved once" },
        },
        client: {
          connect: { client: { id: "client-a" }, device: { id: "device-a" } },
          isDeviceTokenAuth: true,
        },
      };
      await handler?.({ ...base, respond: vi.fn() } as never);
      expect(await store.get(card.id)).toMatchObject({ revision: 1 });
      const committedRevision = 1;

      // Each variant changes exactly one element of the immutable tuple.
      const variants = [
        {
          name: "different patch (different mutationId)",
          request: { ...base, params: { ...base.params, patch: { notes: "different patch" } } },
        },
        {
          name: "different expectedRevision",
          request: { ...base, params: { ...base.params, expectedRevision: 5 } },
        },
        {
          name: "different client id",
          request: {
            ...base,
            client: {
              connect: { client: { id: "client-other" }, device: { id: "device-a" } },
              isDeviceTokenAuth: true,
            },
          },
        },
        {
          name: "different device id",
          request: {
            ...base,
            client: {
              connect: { client: { id: "client-a" }, device: { id: "device-other" } },
              isDeviceTokenAuth: true,
            },
          },
        },
        {
          name: "different device token auth",
          request: {
            ...base,
            client: {
              connect: { client: { id: "client-a" }, device: { id: "device-a" } },
              isDeviceTokenAuth: false,
            },
          },
        },
      ];
      for (const variant of variants) {
        const respond = vi.fn();
        await handler?.({ ...variant.request, respond } as never);
        expect(respond.mock.calls[0]?.[0], variant.name).toBe(false);
        // Never a silent replay, and never a second card mutation.
        expect(await store.get(card.id), variant.name).toMatchObject({
          revision: committedRevision,
          notes: "approved once",
        });
      }
      expect(release).not.toHaveBeenCalled();
    } finally {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives duplicate concurrent retries one terminal outcome", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-gateway-dup-"));
    const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
    try {
      const methods = new Map<string, RegisteredMethod>();
      let reserveCalls = 0;
      const reserve = vi.fn(() => {
        reserveCalls += 1;
        if (reserveCalls > 1) {
          throw new Error("approval redemption window expired");
        }
        return { outcome: "reserved" as const, reservation: {} };
      });
      const finalize = vi.fn(() => ({ outcome: "finalized", reservation: {} }));
      const release = vi.fn();
      const api = {
        runtime: { approvalBoundMutation: { reserve, finalize, release } },
        registerGatewayMethod: vi.fn(
          (
            method: string,
            handler: RegisteredMethod["handler"],
            opts: RegisteredMethod["opts"],
          ) => {
            methods.set(method, { handler, opts });
          },
        ),
      } as unknown as OpenClawPluginApi;
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const card = await store.create({ title: "Duplicate retry card" });
      const updateIfRevision = store.updateIfRevision.bind(store);
      vi.spyOn(store, "updateIfRevision").mockImplementationOnce(async (params) => {
        await updateIfRevision(params);
        throw new Error("simulated crash after card commit");
      });
      registerWorkboardGatewayMethods({ api, store });
      const handler = methods.get("workboard.cards.approvalBoundUpdate")?.handler;
      const request = {
        params: {
          id: card.id,
          approvalId: "approval-dup",
          mutationId: "mutation-dup",
          expectedRevision: 0,
          patch: { notes: "approved once" },
        },
        client: {
          connect: { client: { id: "client-a" }, device: { id: "device-a" } },
          isDeviceTokenAuth: true,
        },
      };
      await handler?.({ ...request, respond: vi.fn() } as never);
      expect(await store.get(card.id)).toMatchObject({ revision: 1 });

      const respondA = vi.fn();
      const respondB = vi.fn();
      await Promise.all([
        handler?.({ ...request, respond: respondA } as never),
        handler?.({ ...request, respond: respondB } as never),
      ]);
      expect(respondA.mock.calls[0]?.[0]).toBe(true);
      expect(respondB.mock.calls[0]?.[0]).toBe(true);
      expect(respondA.mock.calls[0]?.[1]).toMatchObject({ replayed: true });
      expect(respondB.mock.calls[0]?.[1]).toMatchObject({ replayed: true });
      // One terminal outcome: exactly one card mutation, no release.
      expect(await store.get(card.id)).toMatchObject({ revision: 1, notes: "approved once" });
      expect(release).not.toHaveBeenCalled();
    } finally {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases only a proven pre-commit Workboard rejection", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-gateway-release-"));
    const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
    try {
      const methods = new Map<string, RegisteredMethod>();
      const release = vi.fn();
      const api = {
        runtime: {
          approvalBoundMutation: {
            reserve: vi.fn(() => ({ outcome: "reserved", reservation: {} })),
            finalize: vi.fn(),
            release,
          },
        },
        registerGatewayMethod: vi.fn(
          (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) =>
            methods.set(method, { handler, opts }),
        ),
      } as unknown as OpenClawPluginApi;
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const card = await store.create({ title: "Pre-commit rejection" });
      registerWorkboardGatewayMethods({ api, store });
      const respond = vi.fn();

      await methods.get("workboard.cards.approvalBoundUpdate")?.handler({
        params: {
          id: card.id,
          approvalId: "approval-precommit",
          expectedRevision: 0,
          patch: { status: "not-a-workboard-status" },
        },
        client: {
          connect: { client: { id: "client-a" }, device: { id: "device-a" } },
          isDeviceTokenAuth: true,
        },
        respond,
      } as never);

      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
      const unchanged = await store.get(card.id);
      expect(unchanged).toMatchObject({ revision: 0 });
      expect(unchanged?.notes).toBeUndefined();
      expect(await store.lookupApprovalMutationReceipt("approval-precommit")).toBeUndefined();
    } finally {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
