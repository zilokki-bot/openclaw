// Lobster API module exposes the plugin public contract.
export { definePluginEntry } from "openclaw/plugin-sdk/core";
export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
export {
  applyWindowsSpawnProgramPolicy,
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
} from "openclaw/plugin-sdk/windows-spawn";

// Public workflow-controller seam for trusted OpenClaw plugins.  Keep this
// deliberately smaller than the tool implementation: callers must bind their
// own TaskFlow authority and provide a requester-bound delivery policy.
export { createEmbeddedLobsterRunner, resolveLobsterCwd } from "./src/lobster-runner.js";
export type { LobsterEnvelope, LobsterRunner, LobsterRunnerParams } from "./src/lobster-runner.js";
export { runManagedLobsterFlow, resumeManagedLobsterFlow } from "./src/lobster-taskflow.js";
export type {
  ManagedLobsterFlowResult,
  RunManagedLobsterFlowParams,
  ResumeManagedLobsterFlowParams,
} from "./src/lobster-taskflow.js";
