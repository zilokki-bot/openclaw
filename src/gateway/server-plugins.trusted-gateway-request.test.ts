// Tests trusted plugin Gateway dispatch client shaping.
import { describe, expect, it, vi } from "vitest";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { dispatchTrustedPluginGatewayMethod } from "./server-plugins.js";

type HandleGatewayRequestOptions = GatewayRequestOptions & {
  req: { method: string; params?: unknown };
  respond: (ok: boolean, payload?: unknown) => void;
};

const handleGatewayRequest = vi.hoisted(() =>
  vi.fn(async (opts: HandleGatewayRequestOptions) => {
    opts.respond(true, { ok: true });
  }),
);

vi.mock("./server-methods.js", () => ({
  handleGatewayRequest,
}));

describe("trusted plugin Gateway request dispatch", () => {
  it("preserves authenticated agent runtime identity for safe child-create gateway calls", async () => {
    const scope = {
      context: {} as never,
      client: {
        connect: {
          scopes: ["operator.write"],
        },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:codex-coord",
          },
        },
      } as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
    };

    await withPluginRuntimeGatewayRequestScope(scope, () =>
      withPluginRuntimePluginScope({ pluginId: "workboard", pluginOrigin: "bundled" }, () =>
        dispatchTrustedPluginGatewayMethod(
          "workboard.cards.safeChildCreate",
          {
            card: {
              title: "Safe card",
              idempotencyKey: "br-wb:v1:safe-card",
            },
          },
          { scopes: ["operator.write"] },
        ),
      ),
    );

    expect(handleGatewayRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.objectContaining({
          method: "workboard.cards.safeChildCreate",
        }),
        client: expect.objectContaining({
          connect: expect.objectContaining({
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
      }),
    );
  });
});
