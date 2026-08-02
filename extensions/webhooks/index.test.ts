// Webhooks tests cover index plugin behavior.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

function createApi(params?: {
  pluginConfig?: OpenClawPluginApi["pluginConfig"];
  registerHttpRoute?: OpenClawPluginApi["registerHttpRoute"];
  logger?: OpenClawPluginApi["logger"];
}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "webhooks",
    name: "Webhooks",
    source: "test",
    pluginConfig: params?.pluginConfig ?? {},
    runtime: {
      tasks: {
        managedFlows: {
          bindSession: vi.fn(({ sessionKey }: { sessionKey: string }) => ({ sessionKey })),
        },
      },
    } as unknown as OpenClawPluginApi["runtime"],
    registerHttpRoute: params?.registerHttpRoute ?? vi.fn(),
    logger:
      params?.logger ??
      ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as OpenClawPluginApi["logger"]),
  });
}

function requireFirstRouteRegistration(mock: ReturnType<typeof vi.fn>) {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected webhook route registration");
  }
  return call[0] as Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];
}

describe("webhooks plugin registration", () => {
  it("registers SecretRef-backed routes synchronously", () => {
    const registerHttpRoute = vi.fn();

    const result = plugin.register(
      createApi({
        pluginConfig: {
          routes: {
            zapier: {
              sessionKey: "agent:main:main",
              secret: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_WEBHOOK_SECRET",
              },
            },
          },
        },
        registerHttpRoute,
      }),
    );

    expect(result).toBeUndefined();
    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    const route = requireFirstRouteRegistration(registerHttpRoute);
    expect(route.path).toBe("/plugins/webhooks/zapier");
    expect(route.auth).toBe("plugin");
    expect(route.match).toBe("exact");
    expect(route.replaceExisting).toBe(true);
    expect(route.handler).toBeTypeOf("function");
  });

  it("skips duplicate registration on the same api but arms a fresh api after reload", () => {
    const pluginConfig = {
      routes: {
        github: {
          sessionKey: "agent:main:codex-coord",
          secret: "secret-ref",
        },
      },
    };
    const firstRegisterHttpRoute = vi.fn();
    const firstLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const firstApi = createApi({
      pluginConfig,
      registerHttpRoute: firstRegisterHttpRoute,
      logger: firstLogger,
    });

    plugin.register(firstApi);
    plugin.register(firstApi);

    expect(firstRegisterHttpRoute).toHaveBeenCalledTimes(1);
    expect(firstLogger.warn).toHaveBeenCalledWith(
      "[webhooks] duplicate register skipped; routes already installed.",
    );

    const secondRegisterHttpRoute = vi.fn();
    const secondLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    plugin.register(
      createApi({
        pluginConfig,
        registerHttpRoute: secondRegisterHttpRoute,
        logger: secondLogger,
      }),
    );

    expect(secondRegisterHttpRoute).toHaveBeenCalledTimes(1);
    expect(secondLogger.warn).not.toHaveBeenCalled();
  });

  it("does not mark an api registered when route registration throws", () => {
    const registerHttpRoute = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("register failed");
      })
      .mockImplementation(() => undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const api = createApi({
      pluginConfig: {
        routes: {
          github: {
            sessionKey: "agent:main:codex-coord",
            secret: "secret-ref",
          },
        },
      },
      registerHttpRoute,
      logger,
    });

    expect(() => plugin.register(api)).toThrow("register failed");
    expect(() => plugin.register(api)).not.toThrow();

    expect(registerHttpRoute).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "[webhooks] duplicate register skipped; routes already installed.",
    );
  });
});
