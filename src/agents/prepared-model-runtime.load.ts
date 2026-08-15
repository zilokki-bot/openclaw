import {
  PreparedModelRuntimeOwnerNotPublishedError,
  hasConfiguredOwnerMatching,
  normalizePreparedModelRuntimeInput,
  rebindInputToCommittedConfiguredOwner,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";

export async function loadPreparedModelRuntimeSnapshotWithLifecycle(
  rawInput: PreparedModelRuntimeInput,
  deps: {
    owners: Map<string, PreparedModelRuntimeOwner>;
    getPendingReplacement: () => PreparedModelRuntimeReplacement | undefined;
    prepare: (input: PreparedModelRuntimeInput) => Promise<PreparedModelRuntimeSnapshot>;
    ensureConfigured: (input: PreparedModelRuntimeInput) => Promise<boolean>;
    activateStandalone: (
      input: PreparedModelRuntimeInput,
    ) => Promise<PreparedModelRuntimeSnapshot | undefined>;
  },
): Promise<PreparedModelRuntimeSnapshot> {
  let input = normalizePreparedModelRuntimeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  for (;;) {
    const replacement = deps.getPendingReplacement();
    if (replacement) {
      await replacement.promise;
      if (deps.getPendingReplacement()) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(deps.owners, input);
      continue;
    }
    try {
      return await deps.prepare(input);
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
    }
    const activationGate = deps.getPendingReplacement();
    if (activationGate) {
      await activationGate.promise;
      if (deps.getPendingReplacement()) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(deps.owners, input);
      continue;
    }
    if (!hasConfiguredOwnerMatching(deps.owners, input) && (await deps.ensureConfigured(input))) {
      input = rebindInputToCommittedConfiguredOwner(deps.owners, input);
      continue;
    }
    const activated = await deps.activateStandalone(input);
    const replacementAfterActivation = deps.getPendingReplacement();
    if (replacementAfterActivation) {
      await replacementAfterActivation.promise;
      if (deps.getPendingReplacement()) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(deps.owners, input);
      continue;
    }
    if (!activated) {
      return await deps.prepare(input);
    }
    try {
      return await deps.prepare(input);
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
      // A concurrent publication boundary may retire the standalone owner between build and read.
    }
  }
}
