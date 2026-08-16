// Cron tool canonicalization tests cover payload-kind inference from flat params.
import { describe, expect, it } from "vitest";
import { canonicalizeCronToolObject } from "./cron-tool-canonicalize.js";

function canonicalize(input: Record<string, unknown>): Record<string, unknown> {
  return canonicalizeCronToolObject({ ...input });
}

describe("canonicalizeCronToolObject payload kind inference", () => {
  it("treats a null timeout override as an agentTurn signal", () => {
    // A clear-only patch carries no message and no other field, so without this
    // signal it would lose its payload kind and stop being an agentTurn edit.
    expect(canonicalize({ payload: { timeoutSeconds: null } })).toEqual({
      payload: { kind: "agentTurn", timeoutSeconds: null },
    });
  });

  it("treats a numeric timeout override as an agentTurn signal", () => {
    expect(canonicalize({ payload: { timeoutSeconds: 120 } })).toEqual({
      payload: { kind: "agentTurn", timeoutSeconds: 120 },
    });
  });

  it("keeps an explicit payload kind instead of inferring one", () => {
    expect(canonicalize({ payload: { kind: "systemEvent", timeoutSeconds: null } })).toEqual({
      payload: { kind: "systemEvent", timeoutSeconds: null },
    });
  });

  it("infers agentTurn for a kind the cron tool surface does not expose", () => {
    // The model-facing tool advertises only systemEvent/agentTurn/script, so a
    // "command" literal is not a recognised kind and falls through to inference.
    expect(canonicalize({ payload: { kind: "command", timeoutSeconds: null } })).toEqual({
      payload: { kind: "agentTurn", timeoutSeconds: null },
    });
  });

  it("prefers script when a script body is present", () => {
    expect(canonicalize({ payload: { script: "run()", timeoutSeconds: null } })).toEqual({
      payload: { kind: "script", script: "run()", timeoutSeconds: null },
    });
  });

  it("does not invent a kind from an undefined timeout", () => {
    expect(canonicalize({ payload: { timeoutSeconds: undefined } })).toEqual({
      payload: { timeoutSeconds: undefined },
    });
  });

  it("still infers systemEvent from text alone", () => {
    expect(canonicalize({ payload: { text: "tick" } })).toEqual({
      payload: { kind: "systemEvent", text: "tick" },
    });
  });
});
