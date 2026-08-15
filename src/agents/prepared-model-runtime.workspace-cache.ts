import path from "node:path";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeWorkspaceFacts,
} from "./prepared-model-runtime.facts.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

type PreparedWorkspaceBuildStats = Pick<
  PreparedModelRuntimeBuildStats,
  | "runtimePluginMs"
  | "pluginMetadataMs"
  | "staticProviderPlanningMs"
  | "staticProviderCatalogMs"
  | "ambientCredentialsMs"
  | "agentFactsMs"
  | "configuredProjectionMs"
>;

type SharedStaticWorkspaceBuild = {
  agentFacts?: readonly PreparedModelRuntimeAgentFacts[];
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts;
  buildStats: PreparedWorkspaceBuildStats;
};

type PreparedWorkspaceBuildResult = {
  agentFacts: PreparedModelRuntimeAgentFacts[];
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts;
  buildStats: PreparedWorkspaceBuildStats;
};

type PrepareWorkspaceBuildGroupUnshared = (
  inputs: readonly PreparedModelRuntimeInput[],
  catalogMode: PreparedModelRuntimeCatalogMode,
  cachedWorkspaceFacts?: PreparedModelRuntimeWorkspaceFacts,
) => Promise<PreparedWorkspaceBuildResult>;

// Managed worktrees without a workspace extension root have the same static plugin/provider
// graph as the configured workspace. Keep this cache deliberately narrower than the lifecycle
// owner cache: dynamic worktree projections may share only immutable static facts, and any
// workspace-origin plugin opts out.
const sharedStaticWorkspaceBuilds = new Map<string, SharedStaticWorkspaceBuild>();
const sharedStaticWorkspaceBuildInflight = new Map<string, Promise<void>>();
let sharedStaticWorkspaceBuildEpoch = 0;
let sharedStaticAgentFactsEpoch = 0;

function normalizedInheritedAuthDir(input: PreparedModelRuntimeInput): string | undefined {
  return input.inheritedAuthDir ? path.resolve(input.inheritedAuthDir) : undefined;
}

function sharedStaticWorkspaceBuildKey(
  input: PreparedModelRuntimeInput,
  catalogMode: PreparedModelRuntimeCatalogMode,
): string | undefined {
  if (catalogMode !== "static" || input.readOnly || input.workspacePluginRootPresent === true) {
    return undefined;
  }
  return JSON.stringify({
    config: hashRuntimeConfigValue(input.config),
    env: hashRuntimeConfigValue(input.env ?? process.env),
    inheritedAuthDir: normalizedInheritedAuthDir(input),
    skipCredentials: input.skipCredentials === true,
  });
}

function findSharedStaticAgentFacts(
  facts: readonly PreparedModelRuntimeAgentFacts[],
  input: PreparedModelRuntimeInput,
): PreparedModelRuntimeAgentFacts | undefined {
  return facts.find(
    (candidate) =>
      candidate.input.agentId === input.agentId &&
      candidate.input.agentDir === input.agentDir &&
      normalizedInheritedAuthDir(candidate.input) === normalizedInheritedAuthDir(input) &&
      (candidate.input.skipCredentials === true) === (input.skipCredentials === true) &&
      (input.workspacePluginRootPresent === false ||
        candidate.input.workspaceDir === input.workspaceDir),
  );
}

function materializeSharedStaticWorkspaceBuild(
  cached: SharedStaticWorkspaceBuild,
  inputs: readonly PreparedModelRuntimeInput[],
  key: string,
): PreparedWorkspaceBuildResult | undefined {
  if (!cached.agentFacts) {
    return undefined;
  }
  const agentFacts: PreparedModelRuntimeAgentFacts[] = [];
  for (const input of inputs) {
    const cachedFacts = findSharedStaticAgentFacts(cached.agentFacts, input);
    if (!cachedFacts) {
      // Never project facts for an agent/auth identity that was not part of the cached build.
      sharedStaticWorkspaceBuilds.delete(key);
      return undefined;
    }
    agentFacts.push({
      ...cachedFacts,
      input,
      env: input.env ?? process.env,
      // AuthStorage instances are mutable per run. Rehydrate from the immutable credential map
      // without reopening the agent SQLite store for every child worktree.
      templateAuthStorage: AuthStorage.inMemory(cachedFacts.credentials),
    });
  }
  const buildStats: PreparedWorkspaceBuildStats = {
    runtimePluginMs: 0,
    pluginMetadataMs: 0,
    staticProviderPlanningMs: 0,
    staticProviderCatalogMs: 0,
    ambientCredentialsMs: 0,
    agentFactsMs: 0,
    configuredProjectionMs: 0,
  };
  return { agentFacts, workspaceFacts: cached.workspaceFacts, buildStats };
}

export function preparedModelRuntimeWorkspaceFactsKey(input: PreparedModelRuntimeInput): string {
  return JSON.stringify({
    // Config is the process generation. Agent-specific configured refs are projected after these
    // workspace/plugin facts are shared.
    config: hashRuntimeConfigValue(input.config),
    env: hashRuntimeConfigValue(input.env ?? process.env),
    readOnly: input.readOnly === true,
    inheritedAuthDir: normalizedInheritedAuthDir(input),
    skipCredentials: input.skipCredentials === true,
    workspaceDir: input.workspaceDir,
  });
}

export async function prepareSharedStaticWorkspaceBuildGroup(
  inputs: readonly PreparedModelRuntimeInput[],
  catalogMode: PreparedModelRuntimeCatalogMode,
  prepareUnshared: PrepareWorkspaceBuildGroupUnshared,
): Promise<PreparedWorkspaceBuildResult> {
  const input = inputs[0];
  if (!input) {
    throw new Error("prepared model runtime workspace group is empty");
  }
  const sharedBuildKey = sharedStaticWorkspaceBuildKey(input, catalogMode);
  if (!sharedBuildKey || input.workspacePluginRootPresent === true) {
    return await prepareUnshared(inputs, catalogMode);
  }
  const cached = sharedStaticWorkspaceBuilds.get(sharedBuildKey);
  if (cached) {
    const materialized = materializeSharedStaticWorkspaceBuild(cached, inputs, sharedBuildKey);
    if (materialized) {
      return materialized;
    }
  }

  const epoch = sharedStaticWorkspaceBuildEpoch;
  const agentFactsEpoch = sharedStaticAgentFactsEpoch;
  const inflightKey = `${epoch}\0${agentFactsEpoch}\0${sharedBuildKey}`;
  const existing = sharedStaticWorkspaceBuildInflight.get(inflightKey);
  if (existing) {
    await existing.catch(() => undefined);
    const published = sharedStaticWorkspaceBuilds.get(sharedBuildKey);
    if (published) {
      const materialized = materializeSharedStaticWorkspaceBuild(published, inputs, sharedBuildKey);
      if (materialized) {
        return materialized;
      }
    }
  }

  let resolveInflight!: () => void;
  let rejectInflight!: (error: unknown) => void;
  const inflight = new Promise<void>((resolve, reject) => {
    resolveInflight = resolve;
    rejectInflight = reject;
  });
  sharedStaticWorkspaceBuildInflight.set(inflightKey, inflight);
  void inflight.catch(() => undefined);
  try {
    const retained = sharedStaticWorkspaceBuilds.get(sharedBuildKey);
    const result = await prepareUnshared(
      inputs,
      catalogMode,
      // Reuse workspace facts only when auth invalidation intentionally scrubbed the
      // credential-bearing projection. A normal agent-identity miss keeps the previous
      // fail-closed behavior and builds that group's workspace facts independently.
      retained && !retained.agentFacts ? retained.workspaceFacts : undefined,
    );
    if (
      sharedStaticWorkspaceBuildEpoch === epoch &&
      !result.workspaceFacts.pluginMetadataSnapshot.plugins.some(
        (plugin) => plugin.origin === "workspace",
      )
    ) {
      sharedStaticWorkspaceBuilds.set(sharedBuildKey, {
        ...(sharedStaticAgentFactsEpoch === agentFactsEpoch
          ? { agentFacts: result.agentFacts }
          : {}),
        workspaceFacts: result.workspaceFacts,
        buildStats: result.buildStats,
      });
    }
    resolveInflight();
    return result;
  } catch (error) {
    rejectInflight(error);
    throw error;
  } finally {
    if (sharedStaticWorkspaceBuildInflight.get(inflightKey) === inflight) {
      sharedStaticWorkspaceBuildInflight.delete(inflightKey);
    }
  }
}

export function clearSharedStaticWorkspaceBuilds(): void {
  sharedStaticWorkspaceBuildEpoch += 1;
  sharedStaticAgentFactsEpoch += 1;
  sharedStaticWorkspaceBuilds.clear();
  sharedStaticWorkspaceBuildInflight.clear();
}

/** Drops credential-bearing facts while retaining immutable plugin/provider discovery. */
export function clearSharedStaticWorkspaceAgentFacts(): void {
  sharedStaticAgentFactsEpoch += 1;
  for (const [key, cached] of sharedStaticWorkspaceBuilds) {
    sharedStaticWorkspaceBuilds.set(key, {
      workspaceFacts: cached.workspaceFacts,
      buildStats: cached.buildStats,
    });
  }
}
