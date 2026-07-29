import { randomUUID } from "node:crypto";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { resolvePluginSubagentToolsAlsoAllow } from "./server-plugin-runtime-client.js";

type DispatchGatewayMethodInProcessOptions = {
  allowSyntheticModelOverride?: boolean;
  agentRunTracking?: "plugin_subagent";
  forceSyntheticClient?: boolean;
  pluginRuntimeOwnerId?: string;
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  syntheticScopes?: string[];
};

type DispatchGatewayMethodInProcess = <T>(
  method: string,
  params: Record<string, unknown>,
  options?: DispatchGatewayMethodInProcessOptions,
) => Promise<T>;

type FallbackModelOverrideAuthorization = { allowed: true } | { allowed: false; reason: string };

type GatewaySubagentRuntimeParams = {
  authorizeFallbackModelOverride: (params: {
    pluginId?: string;
    provider?: string;
    model?: string;
  }) => FallbackModelOverrideAuthorization;
  canClientUseModelOverride: (client: GatewayRequestOptions["client"]) => boolean;
  canTrustedOfficialPluginRequestScopes: (params: {
    pluginId?: string;
    pluginOrigin?: string;
    pluginTrustedOfficialInstall?: boolean;
  }) => boolean;
  dispatchGatewayMethodInProcess: DispatchGatewayMethodInProcess;
  hasAdminScope: (client: GatewayRequestOptions["client"] | undefined) => boolean;
};

const PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT = 1_000;

function normalizeSubagentRunRuntime(
  value: unknown,
): Awaited<ReturnType<PluginRuntime["subagent"]["run"]>>["runtime"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const harness = typeof record.harness === "string" ? record.harness.trim() : "";
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  return harness && provider && model ? { harness, provider, model } : undefined;
}

export function createGatewaySubagentRuntime(
  runtimeParams: GatewaySubagentRuntimeParams,
): PluginRuntime["subagent"] {
  const { dispatchGatewayMethodInProcess } = runtimeParams;
  const getSessionMessages: PluginRuntime["subagent"]["getSessionMessages"] = async (params) => {
    const limit =
      params.limit == null || !Number.isFinite(params.limit)
        ? undefined
        : Math.min(
            PLUGIN_SUBAGENT_SESSION_MESSAGES_MAX_LIMIT,
            Math.max(1, Math.floor(params.limit)),
          );
    const payload = await dispatchGatewayMethodInProcess<{ messages?: unknown[] }>("sessions.get", {
      key: params.sessionKey,
      ...(limit != null && { limit }),
    });
    return { messages: Array.isArray(payload?.messages) ? payload.messages : [] };
  };

  return {
    async run(params) {
      const scope = getPluginRuntimeGatewayRequestScope();
      const pluginId =
        typeof scope?.pluginId === "string" && scope.pluginId.trim()
          ? scope.pluginId.trim()
          : undefined;
      const runtimePluginToolGrant = resolvePluginSubagentToolsAlsoAllow({
        pluginId,
        toolsAlsoAllow: params.toolsAlsoAllow,
      });
      const overrideRequested = Boolean(params.provider || params.model);
      const hasRequestScopeClient = Boolean(scope?.client);
      let allowOverride =
        hasRequestScopeClient && runtimeParams.canClientUseModelOverride(scope?.client ?? null);
      let allowSyntheticModelOverride = false;
      if (overrideRequested && !allowOverride && !hasRequestScopeClient) {
        const fallbackAuth = runtimeParams.authorizeFallbackModelOverride({
          pluginId: scope?.pluginId,
          provider: params.provider,
          model: params.model,
        });
        if (!fallbackAuth.allowed) {
          throw new Error(fallbackAuth.reason);
        }
        allowOverride = true;
        allowSyntheticModelOverride = true;
      }
      if (overrideRequested && !allowOverride) {
        throw new Error("provider/model override is not authorized for this plugin subagent run.");
      }
      const payload = await dispatchGatewayMethodInProcess<{ runId?: string; runtime?: unknown }>(
        "agent",
        {
          sessionKey: params.sessionKey,
          message: params.message,
          deliver: params.deliver ?? false,
          ...(allowOverride && params.provider && { provider: params.provider }),
          ...(allowOverride && params.model && { model: params.model }),
          ...(params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt }),
          ...(params.lane && { lane: params.lane }),
          ...(params.cwd && { cwd: params.cwd }),
          ...(params.lightContext === true && { bootstrapContextMode: "lightweight" }),
          // The gateway `agent` schema requires `idempotencyKey: NonEmptyString`,
          // so fall back to a generated UUID when the caller omits it. Without
          // this, plugin subagent runs (for example memory-core dreaming
          // narrative) silently fail schema validation at the gateway.
          idempotencyKey: params.idempotencyKey || randomUUID(),
        },
        {
          allowSyntheticModelOverride,
          agentRunTracking: "plugin_subagent",
          ...(pluginId ? { pluginRuntimeOwnerId: pluginId } : {}),
          ...(runtimePluginToolGrant ? { runtimePluginToolGrant } : {}),
        },
      );
      const runId = payload?.runId;
      if (typeof runId !== "string" || !runId) {
        throw new Error("Gateway agent method returned an invalid runId.");
      }
      const runtime = normalizeSubagentRunRuntime(payload?.runtime);
      return { runId, ...(runtime ? { runtime } : {}) };
    },
    async spawnSafe(params) {
      const scope = getPluginRuntimeGatewayRequestScope();
      if (!runtimeParams.canTrustedOfficialPluginRequestScopes(scope ?? {})) {
        throw new Error(
          "Safe subagent spawn is only available to bundled or trusted official plugins.",
        );
      }
      const controllerIdentity = scope?.client?.internal?.agentRuntimeIdentity;
      const controllerSessionKey = controllerIdentity?.sessionKey?.trim();
      const controllerAgentId = controllerIdentity?.agentId?.trim();
      if (!controllerSessionKey || !controllerAgentId) {
        throw new Error("safe subagent spawn requires authenticated agent runtime identity.");
      }
      const targetAgentId = params.agentId?.trim() || "workboard-worker";
      if (targetAgentId !== "workboard-worker") {
        throw new Error("safe subagent spawn only supports agentId=workboard-worker.");
      }
      const { spawnSubagentDirect } = await import("../agents/subagent-spawn.js");
      const result = await spawnSubagentDirect(
        {
          task: params.task,
          label: params.label,
          agentId: targetAgentId,
          taskName: params.taskName,
          runTimeoutSeconds: params.runTimeoutSeconds,
          mode: "run",
          cleanup: "keep",
          sandbox: "require",
          context: "isolated",
          lightContext: params.lightContext ?? true,
          expectsCompletionMessage: params.expectsCompletionMessage ?? false,
        },
        {
          agentSessionKey: controllerSessionKey,
          completionOwnerKey: controllerSessionKey,
          requesterAgentIdOverride: controllerAgentId,
          inheritedToolAllowlist: ["workboard_create"],
        },
      );
      return {
        status: result.status,
        ...(result.childSessionKey ? { childSessionKey: result.childSessionKey } : {}),
        ...(result.runId ? { runId: result.runId } : {}),
        ...(result.mode ? { mode: result.mode } : {}),
        ...(result.taskName ? { taskName: result.taskName } : {}),
        ...(result.note ? { note: result.note } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    },
    async waitForRun(params) {
      const payload = await dispatchGatewayMethodInProcess<{ status?: string; error?: string }>(
        "agent.wait",
        {
          runId: params.runId,
          ...(params.timeoutMs != null && { timeoutMs: params.timeoutMs }),
        },
      );
      let status = payload?.status;
      if (status === "completed" || status === "succeeded") {
        status = "ok";
      } else if (status === "error" && payload?.error?.trim().toLowerCase() === "completed") {
        status = "ok";
      }
      if (status !== "ok" && status !== "error" && status !== "timeout") {
        throw new Error(`Gateway agent.wait returned unexpected status: ${payload?.status}`);
      }
      return {
        status,
        ...(status !== "ok" &&
          typeof payload?.error === "string" &&
          payload.error && { error: payload.error }),
      };
    },
    getSessionMessages,
    async deleteSession(params) {
      const scope = getPluginRuntimeGatewayRequestScope();
      const pluginId =
        typeof scope?.pluginId === "string" && scope.pluginId.trim()
          ? scope.pluginId.trim()
          : undefined;
      const pluginOwnedCleanupOptions = pluginId
        ? {
            pluginRuntimeOwnerId: pluginId,
            ...(!runtimeParams.hasAdminScope(scope?.client)
              ? {
                  forceSyntheticClient: true,
                  syntheticScopes: [ADMIN_SCOPE],
                }
              : {}),
          }
        : undefined;
      await dispatchGatewayMethodInProcess(
        "sessions.delete",
        {
          key: params.sessionKey,
          deleteTranscript: params.deleteTranscript ?? true,
        },
        pluginOwnedCleanupOptions,
      );
    },
    async getToolReceipts(params) {
      const { listSubagentToolReceipts } = await import("../agents/subagent-tool-receipts.js");
      return { receipts: listSubagentToolReceipts(params) };
    },
  };
}
