import { describe, expect, it } from "vitest";
import { resolveChildAdmission } from "./child-admission.js";

/**
 * ARCH2 target model (Black Rock, 2026-08-17):
 *   agents.defaults.subagents.maxChildrenPerAgent = 6
 *   agents.defaults.subagents.maxSpawnDepth       = 2
 * parent (depth 0) → child (depth 1) → grandchild (depth 2); depth 3 is forbidden.
 */
const MAX_SPAWN_DEPTH = 2;
const MAX_CHILDREN_PER_AGENT = 6;

describe("child admission — ARCH2 model 6/2", () => {
  it("lets a parent (depth 0) and a child (depth 1) spawn, but a grandchild (depth 2) cannot", () => {
    for (const callerDepth of [0, 1]) {
      expect(
        resolveChildAdmission({
          callerDepth,
          maxSpawnDepth: MAX_SPAWN_DEPTH,
          activeChildren: 0,
          maxActiveChildren: MAX_CHILDREN_PER_AGENT,
          collect: false,
        }),
      ).toEqual({ ok: true });
    }
    const grandchild = resolveChildAdmission({
      callerDepth: 2,
      maxSpawnDepth: MAX_SPAWN_DEPTH,
      activeChildren: 0,
      maxActiveChildren: MAX_CHILDREN_PER_AGENT,
      collect: false,
    });
    expect(grandchild.ok).toBe(false);
    if (!grandchild.ok) {
      expect(grandchild.governingCap).toBe("subagents.maxSpawnDepth");
      expect(grandchild.error).toContain("current depth: 2, max: 2");
    }
  });

  it("admits up to 6 active children per agent and rejects the 7th", () => {
    for (let active = 0; active < MAX_CHILDREN_PER_AGENT; active += 1) {
      expect(
        resolveChildAdmission({
          callerDepth: 0,
          maxSpawnDepth: MAX_SPAWN_DEPTH,
          activeChildren: active,
          maxActiveChildren: MAX_CHILDREN_PER_AGENT,
          collect: false,
        }),
      ).toEqual({ ok: true });
    }
    const seventh = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: MAX_SPAWN_DEPTH,
      activeChildren: MAX_CHILDREN_PER_AGENT,
      maxActiveChildren: MAX_CHILDREN_PER_AGENT,
      collect: false,
    });
    expect(seventh.ok).toBe(false);
    if (!seventh.ok) {
      expect(seventh.governingCap).toBe("subagents.maxChildrenPerAgent");
      expect(seventh.error).toContain("6/6");
    }
  });

  it("depth is checked before the children cap (a depth-2 caller is rejected even with free child slots)", () => {
    const result = resolveChildAdmission({
      callerDepth: 2,
      maxSpawnDepth: MAX_SPAWN_DEPTH,
      activeChildren: 0,
      maxActiveChildren: MAX_CHILDREN_PER_AGENT,
      collect: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.governingCap).toBe("subagents.maxSpawnDepth");
    }
  });
});
