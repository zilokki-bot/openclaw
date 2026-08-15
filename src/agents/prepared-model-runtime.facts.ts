import { performance } from "node:perf_hooks";
import type { ConfiguredModelRef } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PreparedMessageToolCatalog } from "../channels/plugins/message-action-discovery.js";
import { prepareMediaCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  getPreparedMessageToolCatalog,
  getPreparedMessageToolCatalogForRegistry,
} from "../plugins/prepared-message-tool-catalog.js";
import type { PreparedProviderStaticCatalog } from "../plugins/provider-discovery.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { AgentCredentialMap } from "./agent-auth-credentials.js";
import { resolveAmbientAgentCredentialsForDiscovery } from "./agent-auth-discovery.js";
import { discoverAuthStorageFacts, discoverModels } from "./agent-model-discovery.js";
import { getPreparedRuntimeAuthProfileStoreSnapshot } from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  buildInlineProviderModels,
  type InlineModelEntry,
} from "./embedded-agent-runner/model.inline-provider.js";
import {
  createBundledStaticCatalogModelResolver,
  loadBundledProviderStaticCatalogContextModels,
} from "./embedded-agent-runner/model.static-catalog.js";
import { createStaticModelIdMatcher } from "./embedded-agent-runner/model.static-id.js";
import { buildPreparedModelCatalogSnapshot, type ModelCatalogEntry } from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { ensureOpenClawModelsJson, planOpenClawModelsJsonSource } from "./models-config.js";
import { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  resolvePluginModelCatalogOwnerPluginId,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";
import {
  capturePreparedModelsJsonContents as captureModelsJsonContents,
  clearSharedStaticConfiguredCatalogFacts,
} from "./prepared-model-runtime.catalog-cache.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectConfiguredProviderIdsNeedingStaticCatalog,
  collectPreparedModelRuntimeProviderIds,
  prepareConfiguredRuntimeModels,
  toStaticCatalogEntry,
  type PreparedConfiguredRuntimeModel,
} from "./prepared-model-runtime.configured.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
} from "./prepared-model-runtime.types.js";
import {
  clearSharedStaticWorkspaceBuilds,
  prepareSharedStaticWorkspaceBuildGroup,
  preparedModelRuntimeWorkspaceFactsKey,
} from "./prepared-model-runtime.workspace-cache.js";
import { ensureRuntimePluginsLoaded } from "./runtime-plugins.js";
import { AuthStorage, type AuthStorageData } from "./sessions/auth-storage.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

export {
  fingerprintPreparedRuntimeFacts,
  prepareConfiguredRuntimeFactsBatch,
} from "./prepared-model-runtime.catalog-cache.js";

const MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;

type PreparedModelRuntimeAgentBaseFacts = {
  input: PreparedModelRuntimeInput;
  env: NodeJS.ProcessEnv;
  authStore: AuthProfileStore;
  templateAuthStorage: AuthStorage;
  credentials: Readonly<AuthStorageData>;
  providerIds: string[];
  configuredModelRefs: readonly ConfiguredModelRef[];
};

export type PreparedModelRuntimeAgentFacts = PreparedModelRuntimeAgentBaseFacts & {
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  configuredGeneratedCatalogPluginIds: readonly string[];
};

export type PreparedModelRuntimeWorkspaceFacts = {
  pluginMetadataSnapshot: PluginMetadataSnapshot;
  messageToolCatalog?: PreparedMessageToolCatalog;
  mediaCapabilityProviders?: ReturnType<typeof prepareMediaCapabilityProviders>;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  providerStaticModels?: readonly ProviderRuntimeModel[];
  providerStaticModelsComplete: boolean;
  inlineProviderModels: readonly InlineModelEntry[];
  configuredCatalogEntries: readonly ModelCatalogEntry[];
};

export type PreparedModelRuntimeCatalogFacts = {
  templateModelRegistry: ModelRegistry;
  modelCatalog: ModelCatalogSnapshot;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  inlineProviderModels: readonly InlineModelEntry[];
};

export type PreparedModelRuntimeCatalogSource = Readonly<{
  modelsJsonContents: string | null;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
}>;

function prepareAgentFacts(
  input: PreparedModelRuntimeInput,
  catalogMode: PreparedModelRuntimeCatalogMode,
  ambientCredentials: Readonly<AgentCredentialMap>,
): PreparedModelRuntimeAgentBaseFacts {
  const env = input.env ?? process.env;
  const publishedStore = getPreparedRuntimeAuthProfileStoreSnapshot(
    input.agentDir,
    input.inheritedAuthDir,
  );
  // Runtime-only external profiles exist only in the published auth generation. Re-reading the
  // durable store here would erase startup hydration before this owner can carry it forward.
  const preparedStore =
    publishedStore &&
    (publishedStore.runtimeExternalProfileIds !== undefined ||
      publishedStore.runtimeExternalProfileIdsAuthoritative === true)
      ? publishedStore
      : undefined;
  const authFacts = discoverAuthStorageFacts(input.agentDir, {
    config: input.config,
    // Snapshot construction never initializes, migrates, or externally syncs auth. ModelRegistry
    // discovery only parses the credential generation captured here.
    readOnly: true,
    ambientCredentials,
    ...(preparedStore ? { preparedStore } : {}),
    ...(input.skipCredentials ? { skipCredentials: true } : {}),
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
  });
  const credentials = authFacts.credentials;
  const templateAuthStorage = authFacts.authStorage;
  const configuredModelRefs = collectPreparedModelRuntimeConfiguredRefs(
    input.config,
    input.agentId,
  );
  return {
    input,
    env,
    authStore: authFacts.store,
    templateAuthStorage,
    credentials,
    configuredModelRefs,
    // Gateway startup prepares only providers named by config/model selection. An unrelated
    // stored credential must not pull that provider's complete catalog into the admission path.
    providerIds: collectPreparedModelRuntimeProviderIds(
      input.config,
      credentials,
      catalogMode === "live",
      configuredModelRefs,
    ),
  };
}

function listPreparedSyntheticAuthProviderRefs(providers: readonly ProviderPlugin[]): string[] {
  return [
    ...new Set(
      providers.flatMap((provider) =>
        typeof provider.resolveSyntheticAuth === "function"
          ? [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])]
          : [],
      ),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function resolvePreparedSyntheticAuth(params: {
  config: PreparedModelRuntimeInput["config"];
  provider: string;
  providers: readonly ProviderPlugin[];
}): { apiKey?: string } | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  const providerPlugin = params.providers.find((candidate) =>
    [candidate.id, ...(candidate.aliases ?? []), ...(candidate.hookAliases ?? [])].some(
      (ref) => normalizeProviderId(ref) === normalizedProvider,
    ),
  );
  return (
    providerPlugin?.resolveSyntheticAuth?.({
      config: params.config,
      provider: params.provider,
      providerConfig: Object.entries(params.config.models?.providers ?? {}).find(
        ([providerId]) => normalizeProviderId(providerId) === normalizedProvider,
      )?.[1],
    }) ?? undefined
  );
}

export { preparedModelRuntimeWorkspaceFactsKey };

export async function prepareWorkspaceBuildGroup(
  inputs: readonly PreparedModelRuntimeInput[],
  catalogMode: PreparedModelRuntimeCatalogMode,
): Promise<Awaited<ReturnType<typeof prepareWorkspaceBuildGroupUnshared>>> {
  return prepareSharedStaticWorkspaceBuildGroup(
    inputs,
    catalogMode,
    prepareWorkspaceBuildGroupUnshared,
  );
}

async function prepareWorkspaceBuildGroupUnshared(
  inputs: readonly PreparedModelRuntimeInput[],
  catalogMode: PreparedModelRuntimeCatalogMode,
): Promise<{
  agentFacts: PreparedModelRuntimeAgentFacts[];
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts;
  buildStats: Pick<
    PreparedModelRuntimeBuildStats,
    | "runtimePluginMs"
    | "pluginMetadataMs"
    | "staticProviderPlanningMs"
    | "staticProviderCatalogMs"
    | "ambientCredentialsMs"
    | "agentFactsMs"
    | "configuredProjectionMs"
  >;
}> {
  const input = inputs[0];
  if (!input) {
    throw new Error("prepared model runtime workspace group is empty");
  }
  const env = input.env ?? process.env;
  const runtimePluginStartedAt = performance.now();
  const runtimePluginRegistry =
    catalogMode === "live" && !input.readOnly
      ? ensureRuntimePluginsLoaded({
          config: input.config,
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
        })
      : undefined;
  const runtimePluginMs = performance.now() - runtimePluginStartedAt;
  const pluginMetadataStartedAt = performance.now();
  const pluginMetadataSnapshot = resolvePluginMetadataSnapshot({
    config: input.config,
    env,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.workspacePluginRootPresent === undefined
      ? {}
      : { workspacePluginRootPresent: input.workspacePluginRootPresent }),
  });
  const pluginMetadataMs = performance.now() - pluginMetadataStartedAt;
  const staticProviderPlanningStartedAt = performance.now();
  const matchesStaticModelId = createStaticModelIdMatcher({
    manifestPlugins: pluginMetadataSnapshot.plugins,
  });
  const mediaCapabilityProviders =
    input.readOnly || !runtimePluginRegistry
      ? undefined
      : prepareMediaCapabilityProviders({
          cfg: input.config,
          pluginMetadataSnapshot,
          registry: runtimePluginRegistry,
        });
  const messageToolCatalog = runtimePluginRegistry
    ? getPreparedMessageToolCatalogForRegistry(runtimePluginRegistry)
    : catalogMode === "live"
      ? getPreparedMessageToolCatalog()
      : undefined;
  const resolveManifestStaticCatalogModel = createBundledStaticCatalogModelResolver({
    cfg: input.config,
    env,
    includeRuntimeDiscovery: true,
    metadataSnapshot: pluginMetadataSnapshot,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const configuredManifestModels = new Map<string, ProviderRuntimeModel | undefined>();
  const resolveConfiguredManifestModel = (lookup: { provider: string; modelId: string }) => {
    const key = `${normalizeProviderId(lookup.provider)}\0${lookup.modelId.trim().toLowerCase()}`;
    if (configuredManifestModels.has(key)) {
      return configuredManifestModels.get(key);
    }
    const model = resolveManifestStaticCatalogModel(lookup);
    configuredManifestModels.set(key, model);
    return model;
  };
  const configuredProviderIds = collectPreparedModelRuntimeProviderIds(input.config, {}, false);
  const staticCatalogProviderIds = collectConfiguredProviderIdsNeedingStaticCatalog({
    config: input.config,
    matchesStaticModelId,
    resolveStaticCatalogModel: resolveConfiguredManifestModel,
  });
  const staticProviderPlanningMs = performance.now() - staticProviderPlanningStartedAt;
  const staticProviderCatalogStartedAt = performance.now();
  const preparedStaticProviderCatalog =
    catalogMode === "static"
      ? await prepareImplicitProviderStaticCatalog({
          config: input.config,
          env,
          pluginMetadataSnapshot,
          providerDiscoveryProviderIds: configuredProviderIds,
          staticCatalogProviderIds,
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
        })
      : undefined;
  const staticProviderCatalogMs = performance.now() - staticProviderCatalogStartedAt;
  const preparedSyntheticAuthProviders = preparedStaticProviderCatalog?.providers ?? [];
  // Static Gateway publication consumes provider discovery entrypoints without activating plugin
  // runtimes. The run boundary already owns runtime activation for its exact workspace.
  const ambientCredentialsStartedAt = performance.now();
  const ambientCredentials = resolveAmbientAgentCredentialsForDiscovery({
    config: input.config,
    env,
    syntheticAuthProviderRefs:
      catalogMode === "static"
        ? listPreparedSyntheticAuthProviderRefs(preparedSyntheticAuthProviders)
        : resolveRuntimeSyntheticAuthProviderRefs({
            config: input.config,
            env,
            index: pluginMetadataSnapshot.index,
            registryDiagnostics: pluginMetadataSnapshot.registryDiagnostics,
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          }),
    ...(catalogMode === "static"
      ? {
          resolveSyntheticAuth: (provider: string) =>
            resolvePreparedSyntheticAuth({
              config: input.config,
              provider,
              providers: preparedSyntheticAuthProviders,
            }),
        }
      : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const ambientCredentialsMs = performance.now() - ambientCredentialsStartedAt;
  const agentFactsStartedAt = performance.now();
  const agentBaseFacts = inputs.map((candidate) =>
    prepareAgentFacts(candidate, catalogMode, ambientCredentials),
  );
  const agentFactsMs = performance.now() - agentFactsStartedAt;
  const configuredProjectionStartedAt = performance.now();
  const providerStaticModels =
    catalogMode === "static"
      ? []
      : await loadBundledProviderStaticCatalogContextModels({
          cfg: input.config,
          env,
          metadataSnapshot: pluginMetadataSnapshot,
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
        });
  // Provider definitions are process/config facts. Which refs are admitted remains agent-owned.
  const inlineProviderModels = buildInlineProviderModels(input.config.models?.providers ?? {}, {
    providerMetadataOwners: pluginMetadataSnapshot.owners,
  });
  const configuredCatalogEntries = buildConfiguredModelCatalog({
    cfg: input.config,
    manifestPlugins: pluginMetadataSnapshot.plugins,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const agentFacts: PreparedModelRuntimeAgentFacts[] = [];
  for (const facts of agentBaseFacts) {
    const configuredRuntimeModels = prepareConfiguredRuntimeModels({
      config: facts.input.config,
      configuredModelRefs: facts.configuredModelRefs,
      metadataSnapshot: pluginMetadataSnapshot,
      ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
      providerStaticModels,
      matchesStaticModelId,
      resolveStaticCatalogModel: resolveConfiguredManifestModel,
    });
    const configuredEntryKeys = new Set(configuredCatalogEntries.map(modelCatalogEntryKey));
    for (const configured of configuredRuntimeModels) {
      configuredEntryKeys.add(
        modelCatalogEntryKey({ provider: configured.provider, id: configured.modelId }),
      );
    }
    const configuredGeneratedCatalogPluginIds = [
      ...new Set(
        facts.configuredModelRefs.flatMap(({ value }) => {
          const separator = value.indexOf("/");
          if (separator <= 0 || separator >= value.length - 1) {
            return [];
          }
          const provider = normalizeProviderId(value.slice(0, separator));
          const modelId = value.slice(separator + 1).trim();
          if (
            !provider ||
            !modelId ||
            configuredEntryKeys.has(modelCatalogEntryKey({ provider, id: modelId }))
          ) {
            return [];
          }
          const pluginId = resolvePluginModelCatalogOwnerPluginId({
            providerId: provider,
            pluginMetadataSnapshot,
          });
          return pluginId ? [pluginId] : [];
        }),
      ),
    ].toSorted((left, right) => left.localeCompare(right));
    agentFacts.push({
      ...facts,
      configuredRuntimeModels,
      configuredGeneratedCatalogPluginIds,
    });
  }
  const configuredProjectionMs = performance.now() - configuredProjectionStartedAt;
  const result = {
    agentFacts,
    buildStats: {
      runtimePluginMs,
      pluginMetadataMs,
      staticProviderPlanningMs,
      staticProviderCatalogMs,
      ambientCredentialsMs,
      agentFactsMs,
      configuredProjectionMs,
    },
    workspaceFacts: {
      pluginMetadataSnapshot,
      messageToolCatalog,
      providerStaticModelsComplete: catalogMode === "live",
      inlineProviderModels,
      configuredCatalogEntries,
      ...(mediaCapabilityProviders ? { mediaCapabilityProviders } : {}),
      ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
      ...(providerStaticModels ? { providerStaticModels } : {}),
    },
  };
  return result;
}

/** Clears request-shared static facts when the lifecycle owner is invalidated. */
export function clearPreparedModelRuntimeSharedWorkspaceBuilds(): void {
  clearSharedStaticWorkspaceBuilds();
  clearSharedStaticConfiguredCatalogFacts();
}

export async function prepareFullCatalogFacts(
  agentFacts: PreparedModelRuntimeAgentFacts,
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts,
  catalogMode: PreparedModelRuntimeCatalogMode,
  catalogSource?: PreparedModelRuntimeCatalogSource,
): Promise<PreparedModelRuntimeCatalogFacts> {
  const { credentials, env, input, templateAuthStorage } = agentFacts;
  const { pluginMetadataSnapshot, preparedStaticProviderCatalog } = workspaceFacts;
  const templateModelRegistry = discoverModels(templateAuthStorage, input.agentDir, {
    config: input.config,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    pluginMetadataSnapshot,
    ...(catalogMode === "static" ? { normalizeModels: false } : {}),
    ...(catalogSource
      ? {
          includePluginCatalogs: true,
          modelsJsonContents: catalogSource.modelsJsonContents,
          pluginCatalogs: catalogSource.pluginCatalogs,
        }
      : {}),
  });
  const modelCatalog = await buildPreparedModelCatalogSnapshot({
    agentDir: input.agentDir,
    authCredentials: credentials,
    config: input.config,
    modelRegistry: templateModelRegistry,
    metadataSnapshot: pluginMetadataSnapshot,
    includeProviderPluginAugmentation: catalogMode === "live",
    ...(input.env ? { env } : {}),
    ...(input.readOnly ? { readOnly: true } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const providerStaticModels =
    (workspaceFacts.providerStaticModelsComplete
      ? workspaceFacts.providerStaticModels
      : undefined) ??
    (await loadBundledProviderStaticCatalogContextModels({
      cfg: input.config,
      env,
      metadataSnapshot: pluginMetadataSnapshot,
      ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    }));
  const configuredRuntimeModels = agentFacts.configuredRuntimeModels;
  const staticModels = new Map<string, ProviderRuntimeModel>();
  for (const model of [
    ...configuredRuntimeModels.map((configured) => configured.model),
    ...providerStaticModels,
  ]) {
    const modelKey = `${normalizeProviderId(model.provider)}\0${model.id.trim().toLowerCase()}`;
    if (!staticModels.has(modelKey)) {
      staticModels.set(modelKey, model);
    }
  }
  const staticEntries = [...staticModels.values()].map(toStaticCatalogEntry);
  return {
    templateModelRegistry,
    modelCatalog: { ...modelCatalog, staticEntries },
    configuredRuntimeModels,
    inlineProviderModels: workspaceFacts.inlineProviderModels,
  };
}

function modelCatalogEntryKey(entry: Pick<ModelCatalogEntry, "id" | "provider">): string {
  return `${normalizeProviderId(entry.provider)}\0${entry.id.trim().toLowerCase()}`;
}

export async function prepareAgentCatalogSource(
  agentFacts: PreparedModelRuntimeAgentFacts,
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts,
  catalogMode: PreparedModelRuntimeCatalogMode,
  persist = true,
): Promise<PreparedModelRuntimeCatalogSource> {
  const { env, input, providerIds } = agentFacts;
  const options = {
    pluginMetadataSnapshot: workspaceFacts.pluginMetadataSnapshot,
    ...(workspaceFacts.preparedStaticProviderCatalog
      ? { preparedStaticProviderCatalog: workspaceFacts.preparedStaticProviderCatalog }
      : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
    ...(catalogMode === "static"
      ? {
          providerDiscoveryEntriesOnly: true as const,
          providerDiscoveryProviderIds: providerIds,
        }
      : { providerDiscoveryTimeoutMs: MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS }),
  };
  if (!persist) {
    const source = await planOpenClawModelsJsonSource(input.config, input.agentDir, options);
    return {
      modelsJsonContents: source.modelsJsonContents,
      pluginCatalogs: source.pluginCatalogs,
    };
  }
  if (!input.readOnly) {
    await ensureOpenClawModelsJson(input.config, input.agentDir, options);
  }
  // Capture immediately after the serialized write. Another owner may share this directory and
  // publish a different workspace generation before full-catalog parsing begins.
  return {
    modelsJsonContents: captureModelsJsonContents(input.agentDir),
    pluginCatalogs: loadPersistedPluginModelCatalogsReadOnly(input.agentDir),
  };
}
