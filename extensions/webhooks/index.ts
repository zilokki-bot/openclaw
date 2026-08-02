// Webhooks plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { resolveWebhooksPluginConfig } from "./src/config.js";
import { createTaskFlowWebhookRequestHandler, type TaskFlowWebhookTarget } from "./src/http.js";

const REGISTERED_API_KEY = Symbol.for("openclaw.webhooks.registeredApis");

function registeredApis(): WeakSet<OpenClawPluginApi> {
  const globalRecord = globalThis as typeof globalThis & {
    [REGISTERED_API_KEY]?: WeakSet<OpenClawPluginApi>;
  };
  globalRecord[REGISTERED_API_KEY] ??= new WeakSet<OpenClawPluginApi>();
  return globalRecord[REGISTERED_API_KEY];
}

function registerWebhookRoutes(api: OpenClawPluginApi): void {
  const routes = resolveWebhooksPluginConfig({
    pluginConfig: api.pluginConfig,
  });
  if (routes.length === 0) {
    return;
  }

  const targetsByPath = new Map<string, TaskFlowWebhookTarget[]>();
  const handler = createTaskFlowWebhookRequestHandler({
    cfg: api.config,
    targetsByPath,
  });

  for (const route of routes) {
    const taskFlow = api.runtime.tasks.managedFlows.bindSession({
      sessionKey: route.sessionKey,
    });
    const target: TaskFlowWebhookTarget = {
      routeId: route.routeId,
      path: route.path,
      secretInput: route.secret,
      secretConfigPath: `plugins.entries.webhooks.routes.${route.routeId}.secret`,
      defaultControllerId: route.controllerId,
      taskFlow,
    };
    targetsByPath.set(target.path, [...(targetsByPath.get(target.path) ?? []), target]);
    api.registerHttpRoute({
      path: target.path,
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler,
    });
    api.logger.info?.(
      `[webhooks] registered route ${route.routeId} on ${route.path} for session ${route.sessionKey}`,
    );
  }
}

export default definePluginEntry({
  id: "webhooks",
  name: "Webhooks",
  description:
    "Authenticated inbound webhooks that bind external automation to OpenClaw TaskFlows.",
  register(api: OpenClawPluginApi) {
    const apis = registeredApis();
    if (apis.has(api)) {
      api.logger.warn?.("[webhooks] duplicate register skipped; routes already installed.");
      return;
    }
    apis.add(api);
    registerWebhookRoutes(api);
  },
});
