import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSharedWorkboardStore, WorkboardStore } from "./store.js";

afterEach(() => {
  resetSharedWorkboardStore();
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
    resetSharedWorkboardStore();
    const second = WorkboardStore.shared();

    expect(second).not.toBe(first);
  });
});
