// Tests trusted runtime synthetic Gateway client shaping.
import { describe, expect, it } from "vitest";
import { createSyntheticOperatorClient } from "./synthetic-operator-client.js";

describe("createSyntheticOperatorClient", () => {
  it("preserves authenticated agent runtime identity for safe child-create gateway calls", () => {
    const client = createSyntheticOperatorClient({
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:codex-coord",
      },
      pluginRuntimeOwnerId: "workboard",
      scopes: ["operator.write"],
    });

    expect(client).toEqual(
      expect.objectContaining({
        connect: expect.objectContaining({
          role: "operator",
          scopes: ["operator.write"],
        }),
        internal: expect.objectContaining({
          pluginRuntimeOwnerId: "workboard",
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:codex-coord",
          },
        }),
      }),
    );
  });
});
