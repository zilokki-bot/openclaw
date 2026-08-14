import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { resolveDefaultAgentId } from "./agent-scope-config.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
  listConfiguredOwnerInputs,
  normalizeOptionalDir,
  normalizePreparedModelRuntimeInput,
  resolvePublishedOwner,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeRefreshOptions,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";

type GatewayRuntimeSeed = {
  config: OpenClawConfig;
  defaultWorkspaceDir?: string;
  catalogMode: "static";
  onBuildStats?: PreparedModelRuntimeRefreshOptions["onBuildStats"];
};

export function createGatewayPreparedModelRuntimeLifecycle(deps: {
  owners: Map<string, PreparedModelRuntimeOwner>;
  getPendingReplacement: () => PreparedModelRuntimeReplacement | undefined;
  publishConfigured: (
    input: PreparedModelRuntimeInput,
    catalogMode: "static",
    onBuildStats?: PreparedModelRuntimeRefreshOptions["onBuildStats"],
  ) => Promise<PreparedModelRuntimeSnapshot>;
}) {
  let active = false;
  let seed: GatewayRuntimeSeed | undefined;

  const resolveConfiguredInput = (agentId: string): PreparedModelRuntimeInput | undefined => {
    if (!seed) {
      return undefined;
    }
    return listConfiguredOwnerInputs(seed.config, seed.defaultWorkspaceDir).find(
      (input) => input.agentId === agentId,
    );
  };

  const prepareAgent = async (agentId: string): Promise<void> => {
    for (;;) {
      const replacement = deps.getPendingReplacement();
      if (replacement) {
        await replacement.promise;
        continue;
      }
      const input = resolveConfiguredInput(agentId);
      if (!input) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime configured agent is not available: ${agentId}`,
        );
      }
      const normalizedInput = normalizePreparedModelRuntimeInput(input);
      const existing = resolvePublishedOwner(deps.owners, normalizedInput);
      if (existing?.snapshot && !existing.needsRefresh && !existing.pending) {
        return;
      }
      try {
        await deps.publishConfigured(
          normalizedInput,
          seed?.catalogMode ?? "static",
          seed?.onBuildStats,
        );
        return;
      } catch (error) {
        if (error instanceof PreparedModelRuntimePublicationSupersededError) {
          continue;
        }
        throw error;
      }
    }
  };

  return {
    isActive: () => active,
    markActive: (enabled: boolean) => {
      active ||= enabled;
    },
    activateStartup: async (
      config: OpenClawConfig,
      options: PreparedModelRuntimeRefreshOptions = {},
    ): Promise<void> => {
      const inputs = listConfiguredOwnerInputs(config, options.defaultWorkspaceDir);
      const defaultAgentId = resolveDefaultAgentId(config);
      if (!inputs.some((input) => input.agentId === defaultAgentId)) {
        throw new Error(
          "prepared model runtime default owner is missing from the configured roster",
        );
      }
      active = true;
      // Readiness owns only the authoritative identity/config seed. Workspace facts and model
      // projections stay request-driven because even the default workspace may block the loop.
      seed = {
        config,
        ...(options.defaultWorkspaceDir
          ? { defaultWorkspaceDir: options.defaultWorkspaceDir }
          : {}),
        catalogMode: "static",
        ...(options.onBuildStats ? { onBuildStats: options.onBuildStats } : {}),
      };
    },
    ensureForInput: async (
      input: PreparedModelRuntimeInput,
      options: { allowDynamicWorkspace?: boolean } = {},
    ): Promise<boolean> => {
      if (!active || !input.agentId || isReservedSystemAgentId(input.agentId)) {
        return false;
      }
      const configuredInput = resolveConfiguredInput(input.agentId);
      if (!configuredInput) {
        return false;
      }
      const normalizedConfiguredInput = normalizePreparedModelRuntimeInput(configuredInput);
      const normalizedWorkspaceDir = normalizeOptionalDir(input.workspaceDir);
      if (
        !options.allowDynamicWorkspace &&
        normalizedWorkspaceDir !== undefined &&
        normalizedWorkspaceDir !== normalizedConfiguredInput.workspaceDir
      ) {
        return false;
      }
      await prepareAgent(input.agentId);
      return true;
    },
    prepareAgent,
    recordPublishedConfig: (
      config: OpenClawConfig,
      options: PreparedModelRuntimeRefreshOptions,
    ) => {
      if (!active) {
        return;
      }
      seed = {
        config,
        ...(options.defaultWorkspaceDir
          ? { defaultWorkspaceDir: options.defaultWorkspaceDir }
          : {}),
        catalogMode: "static",
        ...(options.onBuildStats ? { onBuildStats: options.onBuildStats } : {}),
      };
    },
    clearSeed: () => {
      seed = undefined;
    },
    reset: () => {
      active = false;
      seed = undefined;
    },
  };
}
