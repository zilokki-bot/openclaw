import fs from "node:fs";
import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { discoverModelsFromCapturedSources } from "./agent-model-discovery.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";
import {
  toStaticCatalogEntry,
  type PreparedConfiguredRuntimeModel,
} from "./prepared-model-runtime.configured.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeWorkspaceFacts,
} from "./prepared-model-runtime.facts.js";
import type {
  PreparedModelRuntimeCatalogFacts,
  PreparedModelRuntimeInput,
} from "./prepared-model-runtime.facts.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import type { ModelRegistry } from "./sessions/model-registry.js";
import { stableStringify } from "./stable-stringify.js";

type PreparedConfiguredRegistryGroup = {
  agentFacts: PreparedModelRuntimeAgentFacts[];
  modelsJsonContents: string | null;
  oauthProviders: ReturnType<AuthStorage["getOAuthProviders"]>;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
};

const sharedStaticConfiguredCatalogFacts = new Map<string, PreparedModelRuntimeCatalogFacts>();

function modelCatalogEntryKey(entry: Pick<ModelCatalogEntry, "id" | "provider">): string {
  return `${normalizeProviderId(entry.provider)}\0${entry.id.trim().toLowerCase()}`;
}

function createConfiguredModelCatalogSnapshot(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): ModelCatalogSnapshot {
  const entries = new Map<string, ModelCatalogEntry>();
  const addEntry = (entry: ModelCatalogEntry) => {
    const key = modelCatalogEntryKey(entry);
    if (!entries.has(key)) {
      entries.set(key, entry);
    }
  };
  for (const entry of params.workspaceFacts.configuredCatalogEntries) {
    addEntry(entry);
  }
  for (const configured of params.configuredRuntimeModels) {
    addEntry(toStaticCatalogEntry(configured.model));
  }
  for (const { value } of params.agentFacts.configuredModelRefs) {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator >= value.length - 1) {
      continue;
    }
    const provider = normalizeProviderId(value.slice(0, separator));
    const modelId = value.slice(separator + 1).trim();
    if (!provider || !modelId) {
      continue;
    }
    const model = params.templateModelRegistry.find(provider, modelId);
    if (model) {
      addEntry(toStaticCatalogEntry(model));
    }
  }
  const configuredEntries = [...entries.values()];
  const staticEntries = params.configuredRuntimeModels.map(({ model }) =>
    toStaticCatalogEntry(model),
  );
  return {
    entries: configuredEntries,
    routeVariants: configuredEntries,
    ...(staticEntries.length > 0 ? { staticEntries } : {}),
  };
}

function prepareConfiguredRuntimeFacts(
  agentFacts: PreparedModelRuntimeAgentFacts,
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts,
  sharedTemplateModelRegistry: ModelRegistry,
): PreparedModelRuntimeCatalogFacts {
  const { configuredRuntimeModels } = agentFacts;
  const { inlineProviderModels } = workspaceFacts;
  return {
    templateModelRegistry: sharedTemplateModelRegistry,
    modelCatalog: createConfiguredModelCatalogSnapshot({
      agentFacts,
      workspaceFacts,
      templateModelRegistry: sharedTemplateModelRegistry,
      configuredRuntimeModels,
    }),
    configuredRuntimeModels,
    inlineProviderModels,
  };
}

function captureModelsJsonContents(agentDir: string): string | null {
  try {
    return fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function fingerprintPreparedRuntimeFacts(value: unknown): string {
  return sha256Base64Url(stableStringify(value));
}

function hasSameOAuthProviderGeneration(
  left: ReturnType<AuthStorage["getOAuthProviders"]>,
  right: ReturnType<AuthStorage["getOAuthProviders"]>,
): boolean {
  // OAuth descriptors carry executable hooks. Match those hooks by identity so equivalent
  // AuthStorage instances share built-ins without merging distinct closure generations.
  return (
    left.length === right.length &&
    left.every((provider, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        provider.id === candidate.id &&
        provider.name === candidate.name &&
        provider.usesCallbackServer === candidate.usesCallbackServer &&
        provider.login === candidate.login &&
        provider.refreshToken === candidate.refreshToken &&
        provider.getApiKey === candidate.getApiKey &&
        provider.modifyModels === candidate.modifyModels
      );
    })
  );
}

function groupConfiguredRegistrySources(
  agentFacts: readonly PreparedModelRuntimeAgentFacts[],
): PreparedConfiguredRegistryGroup[] {
  const groups = new Map<string, PreparedConfiguredRegistryGroup[]>();
  for (const facts of agentFacts) {
    const modelsJsonContents = captureModelsJsonContents(facts.input.agentDir);
    const oauthProviders = facts.templateAuthStorage.getOAuthProviders();
    // Generated catalogs are agent-owned. Capture only plugins needed by unresolved configured
    // refs, then group exact bytes and OAuth behavior so publication never mixes generations.
    const pluginCatalogs = loadPersistedPluginModelCatalogsReadOnly(
      facts.input.agentDir,
      facts.configuredGeneratedCatalogPluginIds,
    );
    const key = fingerprintPreparedRuntimeFacts({
      credentials: facts.credentials,
      modelsJsonContents,
      pluginCatalogs,
    });
    const candidates = groups.get(key) ?? [];
    const group = candidates.find((candidate) =>
      hasSameOAuthProviderGeneration(candidate.oauthProviders, oauthProviders),
    );
    if (group) {
      group.agentFacts.push(facts);
    } else {
      candidates.push({
        agentFacts: [facts],
        modelsJsonContents,
        oauthProviders,
        pluginCatalogs,
      });
      groups.set(key, candidates);
    }
  }
  return [...groups.values()].flat();
}

export function prepareConfiguredRuntimeFactsBatch(params: {
  agentFacts: readonly PreparedModelRuntimeAgentFacts[];
  workspaceFacts: PreparedModelRuntimeWorkspaceFacts;
}): {
  catalogs: Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>;
  registryCount: number;
} {
  const catalogs = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>();
  let registryCount = 0;
  for (const group of groupConfiguredRegistrySources(params.agentFacts)) {
    const representative = group.agentFacts[0];
    if (!representative) {
      continue;
    }
    const sourceKey = fingerprintPreparedRuntimeFacts({
      config: hashRuntimeConfigValue(representative.input.config),
      agentDir: representative.input.agentDir,
      credentials: representative.credentials,
      modelsJsonContents: group.modelsJsonContents,
      pluginCatalogs: group.pluginCatalogs,
      metadata: params.workspaceFacts.pluginMetadataSnapshot.configFingerprint,
    });
    const cachedCatalogs = group.agentFacts.map((facts) =>
      sharedStaticConfiguredCatalogFacts.get(
        `${sourceKey}\0${facts.input.agentId ?? ""}\0${fingerprintPreparedRuntimeFacts(
          facts.configuredModelRefs,
        )}`,
      ),
    );
    if (
      cachedCatalogs.every(
        (catalog): catalog is PreparedModelRuntimeCatalogFacts => catalog !== undefined,
      )
    ) {
      for (const [index, facts] of group.agentFacts.entries()) {
        catalogs.set(facts.input, cachedCatalogs[index]!);
      }
      continue;
    }
    // Catalog bytes, credentials, and OAuth provider behavior are identical inside this group.
    // Parse once, then fork request auth without reopening filesystem or SQLite catalog sources.
    const templateModelRegistry = discoverModelsFromCapturedSources(
      representative.templateAuthStorage,
      {
        config: representative.input.config,
        includePluginCatalogs: true,
        modelsJsonContents: group.modelsJsonContents,
        pluginCatalogs: group.pluginCatalogs,
        pluginMetadataSnapshot: params.workspaceFacts.pluginMetadataSnapshot,
        ...(representative.input.workspaceDir
          ? { workspaceDir: representative.input.workspaceDir }
          : {}),
      },
    );
    registryCount += 1;
    for (const facts of group.agentFacts) {
      const catalogFacts = prepareConfiguredRuntimeFacts(
        facts,
        params.workspaceFacts,
        templateModelRegistry,
      );
      catalogs.set(facts.input, catalogFacts);
      sharedStaticConfiguredCatalogFacts.set(
        `${sourceKey}\0${facts.input.agentId ?? ""}\0${fingerprintPreparedRuntimeFacts(
          facts.configuredModelRefs,
        )}`,
        catalogFacts,
      );
    }
  }
  return { catalogs, registryCount };
}

export function clearSharedStaticConfiguredCatalogFacts(): void {
  sharedStaticConfiguredCatalogFacts.clear();
}

export function capturePreparedModelsJsonContents(agentDir: string): string | null {
  return captureModelsJsonContents(agentDir);
}
