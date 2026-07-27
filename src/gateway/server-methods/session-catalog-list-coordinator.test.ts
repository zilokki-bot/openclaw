import { describe, expect, it, vi } from "vitest";
import {
  buildSessionCatalogListCacheKey,
  SessionCatalogListBusyError,
  SessionCatalogListCoordinator,
} from "./session-catalog-list-coordinator.js";

describe("SessionCatalogListCoordinator", () => {
  it("shares in-flight loads for the same key", async () => {
    const coordinator = new SessionCatalogListCoordinator<string>({
      freshTtlMs: 100,
      staleTtlMs: 1_000,
      maxCacheEntries: 8,
      maxConcurrentLoads: 2,
    });
    let resolveLoad: ((value: string) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const first = coordinator.run({ key: "catalog", load, cacheable: () => true });
    const second = coordinator.run({ key: "catalog", load, cacheable: () => true });

    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    resolveLoad?.("hosts");

    await expect(Promise.all([first, second])).resolves.toEqual(["hosts", "hosts"]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("serves stale cache instead of admitting extra pressure", async () => {
    let now = 0;
    const coordinator = new SessionCatalogListCoordinator<string>({
      freshTtlMs: 10,
      staleTtlMs: 1_000,
      maxCacheEntries: 8,
      maxConcurrentLoads: 1,
      now: () => now,
    });
    await expect(
      coordinator.run({
        key: "cached",
        load: async () => "stale-value",
        cacheable: () => true,
      }),
    ).resolves.toBe("stale-value");
    now = 20;
    const blocker = coordinator.run({
      key: "blocking",
      load: () => new Promise<string>(() => {}),
      cacheable: () => true,
    });
    void blocker.catch(() => undefined);

    await expect(
      coordinator.run({
        key: "cached",
        load: async () => "fresh-value",
        cacheable: () => true,
      }),
    ).resolves.toBe("stale-value");
  });

  it("rejects excess uncached pressure with a retryable busy error", async () => {
    const coordinator = new SessionCatalogListCoordinator<string>({
      freshTtlMs: 100,
      staleTtlMs: 1_000,
      maxCacheEntries: 8,
      maxConcurrentLoads: 1,
      maxQueuedLoads: 1,
    });
    const blocker = coordinator.run({
      key: "blocking",
      load: () => new Promise<string>(() => {}),
      cacheable: () => true,
    });
    void blocker.catch(() => undefined);

    const queued = coordinator.run({
      key: "queued",
      load: async () => "queued",
      cacheable: () => true,
    });
    void queued.catch(() => undefined);

    await expect(
      coordinator.run({
        key: "overflow",
        load: async () => "overflow",
        cacheable: () => true,
      }),
    ).rejects.toBeInstanceOf(SessionCatalogListBusyError);
  });

  it("normalizes cache key ordering", () => {
    expect(
      buildSessionCatalogListCacheKey({
        catalogIds: ["z", "a"],
        agentId: "main",
        hostIds: ["b", "a"],
        cursors: { two: "2", one: "1" },
      }),
    ).toBe(
      buildSessionCatalogListCacheKey({
        catalogIds: ["a", "z"],
        agentId: "main",
        hostIds: ["a", "b"],
        cursors: { one: "1", two: "2" },
      }),
    );
  });
});
