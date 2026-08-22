// Shared-connection tests cover the process-wide Workboard store memo.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkboardStore } from "./store.js";

afterEach(() => {
  WorkboardStore.resetShared();
  vi.restoreAllMocks();
});

describe("WorkboardStore.shared", () => {
  it("opens one SQLite connection no matter how many registrations ask for it", () => {
    const open = vi.spyOn(WorkboardStore, "openSqlite");
    // Plugin register(), gateway methods and tool construction each ask for a
    // store; before this they each opened their own connection to the same file.
    const first = WorkboardStore.shared();
    const second = WorkboardStore.shared();
    const third = WorkboardStore.shared();

    expect(open).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("still hands out isolated stores through openSqlite", () => {
    const shared = WorkboardStore.shared();
    const isolated = WorkboardStore.openSqlite();

    expect(isolated).not.toBe(shared);
    expect(WorkboardStore.shared()).toBe(shared);
  });

  it("reopens after the memo is reset", () => {
    const first = WorkboardStore.shared();
    WorkboardStore.resetShared();
    const second = WorkboardStore.shared();

    expect(second).not.toBe(first);
  });

  it("keeps one connection across a second module instance", async () => {
    const first = WorkboardStore.shared();
    // A module-level memo resets when the module is evaluated again, which is one
    // of the ways registration re-ran and leaked another connection. The memo is
    // therefore keyed on globalThis, not on this module instance.
    const reimported = (await import("./store.js?shared-connection-second-instance")) as {
      WorkboardStore: typeof WorkboardStore;
    };

    expect(reimported.WorkboardStore.shared()).toBe(first);
  });
});
