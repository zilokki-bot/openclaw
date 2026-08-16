import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  refreshSessionCatalogsLive,
  SessionCatalogLiveState,
} from "../../components/app-sidebar-session-catalog-live.ts";
import { catalogPage } from "../app-sidebar.ts";

describe("AppSidebar session catalog pagination", () => {
  it("keeps the current refetch guard when an older request finishes", () => {
    const live = new SessionCatalogLiveState();
    const older = live.beginRefetch(true);
    const current = live.beginRefetch(true);

    live.endRefetch(older);
    expect(live.refetching).toBe(true);
    live.endRefetch(current);
    expect(live.refetching).toBe(false);
  });

  it("invalidates request ownership when live state is cleared", () => {
    const live = new SessionCatalogLiveState();
    const first = live.beginRequest(1);
    live.clear();
    const second = live.beginRequest(1);

    expect(live.ownsRequest(first.requestOwner)).toBe(false);
    expect(live.ownsRequest(second.requestOwner)).toBe(true);
  });

  it("keeps the stable cadence when only session recency timestamps change", async () => {
    vi.useFakeTimers();
    try {
      const pageAt = (timestamp: number): SessionsCatalogListResult => {
        const page = catalogPage([{ threadId: "thread-active", name: "Active session" }]);
        const catalog = page.catalogs[0];
        const host = catalog?.hosts[0];
        const session = host?.sessions[0];
        if (!catalog || !host || !session) {
          throw new Error("recency catalog fixture is incomplete");
        }
        host.sessions = [{ ...session, updatedAt: timestamp, recencyAt: timestamp }];
        return page;
      };
      let catalogs = pageAt(1).catalogs;
      const client = {
        request: vi.fn().mockResolvedValue(pageAt(2)),
      } as unknown as GatewayBrowserClient;
      const refresh = vi.fn();

      await refreshSessionCatalogsLive({
        live: new SessionCatalogLiveState(),
        client,
        agentId: "main",
        generation: 1,
        revision: 1,
        currentGeneration: () => 1,
        currentRevision: () => 1,
        currentClient: () => client,
        catalogs: () => catalogs,
        pageDepths: new Map(),
        connected: () => true,
        applyFinal: (next) => {
          catalogs = next;
        },
        applyError: (error) => {
          throw error;
        },
        refresh,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(25_000);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sheds expanded-page replay and backs off when the catalog list is slow", async () => {
    vi.useFakeTimers();
    try {
      // The host must already hold expanded rows, otherwise there is nothing to
      // preserve and the assertions below would pass on a data-losing build.
      const expanded = catalogPage(
        [
          { threadId: "thread-1", name: "First page" },
          { threadId: "thread-2", name: "Second page" },
        ],
        "cursor-2",
      );
      let catalogs: SessionCatalog[] = expanded.catalogs;
      const request = vi.fn(async (_method: string, requestParams: Record<string, unknown>) => {
        if (requestParams.cursors) {
          return catalogPage([{ threadId: "thread-2", name: "Second page" }]);
        }
        // A slow gateway round-trip is exactly when replaying every expanded
        // page costs the most, so the elapsed time drives the decision.
        vi.setSystemTime(Date.now() + 2_000);
        return catalogPage([{ threadId: "thread-1", name: "First page" }], "cursor-1");
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const refresh = vi.fn();

      await refreshSessionCatalogsLive({
        live: new SessionCatalogLiveState(),
        client,
        agentId: "main",
        generation: 1,
        revision: 1,
        currentGeneration: () => 1,
        currentRevision: () => 1,
        currentClient: () => client,
        catalogs: () => catalogs,
        pageDepths: new Map([["codex\u0000gateway:local", 1]]),
        connected: () => true,
        applyFinal: (next) => {
          catalogs = next;
        },
        applyError: (error) => {
          throw error;
        },
        refresh,
      });

      // The expanded page must not be replayed: only the initial list ran.
      expect(request.mock.calls.some(([, callParams]) => callParams.cursors)).toBe(false);

      // Shedding the replay must not shed the rows already on screen, nor the
      // cursor that a later manual load-more depends on.
      const shedHost = catalogs[0]?.hosts[0];
      expect(shedHost?.sessions.map((session) => session.threadId)).toEqual([
        "thread-1",
        "thread-2",
      ]);
      expect(shedHost?.nextCursor).toBe("cursor-2");

      // And the next poll must be pushed out past both normal cadences.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(270_000);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps replaying expanded pages when the catalog list is fast", async () => {
    vi.useFakeTimers();
    try {
      let catalogs: SessionCatalog[] = [];
      const request = vi.fn(async (_method: string, requestParams: Record<string, unknown>) => {
        if (requestParams.cursors) {
          return catalogPage([{ threadId: "thread-2", name: "Second page" }]);
        }
        return catalogPage([{ threadId: "thread-1", name: "First page" }], "cursor-1");
      });
      const client = { request } as unknown as GatewayBrowserClient;

      await refreshSessionCatalogsLive({
        live: new SessionCatalogLiveState(),
        client,
        agentId: "main",
        generation: 1,
        revision: 1,
        currentGeneration: () => 1,
        currentRevision: () => 1,
        currentClient: () => client,
        catalogs: () => catalogs,
        pageDepths: new Map([["codex\u0000gateway:local", 1]]),
        connected: () => true,
        applyFinal: (next) => {
          catalogs = next;
        },
        applyError: (error) => {
          throw error;
        },
        refresh: vi.fn(),
      });

      expect(request.mock.calls.some(([, callParams]) => callParams.cursors)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
