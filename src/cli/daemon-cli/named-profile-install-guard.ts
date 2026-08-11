// Validates explicit named-profile paths before they are persisted in a managed Gateway service.
import fs from "node:fs";
import path from "node:path";

type PathStat = Pick<fs.Stats, "isDirectory" | "isFile" | "isSymbolicLink" | "uid">;

export type NamedProfileInstallGuardResult = { ok: true } | { ok: false; reason: string };

type NamedProfileInstallGuardParams = {
  env: Record<string, string | undefined>;
  configPath: string;
  configValid: boolean;
  configPort: number;
  installPort: number;
  lstatSync?: (candidate: string) => PathStat;
  realpathSync?: (candidate: string) => string;
  getuid?: () => number | undefined;
};

function isNamedProfile(profile: string | undefined): boolean {
  const normalized = profile?.trim().toLowerCase();
  return Boolean(normalized && normalized !== "default");
}

function isAbsoluteNormalizedPath(value: string): boolean {
  if (!path.isAbsolute(value) || value !== path.normalize(value)) {
    return false;
  }
  return !value.split(path.sep).includes("..");
}

function isOwnedByCurrentUser(stat: PathStat, getuid: () => number | undefined): boolean {
  const currentUid = getuid();
  return currentUid === undefined || stat.uid === currentUid;
}

/**
 * A named profile may opt into non-default config/state paths, but only when both
 * existing objects have a stable filesystem identity owned by the invoking user.
 * Errors deliberately name only env keys so service install diagnostics never echo
 * path-adjacent secrets or an arbitrary foreign filesystem layout.
 */
export function validateNamedProfileInstallPaths(
  params: NamedProfileInstallGuardParams,
): NamedProfileInstallGuardResult {
  const configOverride = params.env.OPENCLAW_CONFIG_PATH?.trim();
  const stateOverride = params.env.OPENCLAW_STATE_DIR?.trim();
  if (!configOverride && !stateOverride) {
    return { ok: true };
  }
  if (!isNamedProfile(params.env.OPENCLAW_PROFILE)) {
    return {
      ok: false,
      reason:
        "explicit OPENCLAW_CONFIG_PATH/OPENCLAW_STATE_DIR require a non-default OPENCLAW_PROFILE",
    };
  }
  if (!configOverride || !stateOverride) {
    return {
      ok: false,
      reason:
        "named-profile service install requires both OPENCLAW_CONFIG_PATH and OPENCLAW_STATE_DIR",
    };
  }
  if (!isAbsoluteNormalizedPath(configOverride) || !isAbsoluteNormalizedPath(stateOverride)) {
    return {
      ok: false,
      reason: "OPENCLAW_CONFIG_PATH and OPENCLAW_STATE_DIR must be absolute normalized paths",
    };
  }
  if (!params.configValid) {
    return { ok: false, reason: "named-profile config is not valid" };
  }
  if (params.configPath !== configOverride) {
    return { ok: false, reason: "OPENCLAW_CONFIG_PATH does not match the validated config" };
  }
  if (params.configPort !== params.installPort) {
    return { ok: false, reason: "--port must match gateway.port for a named-profile service" };
  }

  const lstatSync = params.lstatSync ?? fs.lstatSync;
  const realpathSync = params.realpathSync ?? fs.realpathSync.native;
  const getuid = params.getuid ?? process.getuid;
  try {
    const configStat = lstatSync(configOverride);
    const stateStat = lstatSync(stateOverride);
    if (
      configStat.isSymbolicLink() ||
      stateStat.isSymbolicLink() ||
      !configStat.isFile() ||
      !stateStat.isDirectory()
    ) {
      return {
        ok: false,
        reason: "named-profile paths must be existing regular config and directory",
      };
    }
    if (!isOwnedByCurrentUser(configStat, getuid) || !isOwnedByCurrentUser(stateStat, getuid)) {
      return { ok: false, reason: "named-profile paths must be owned by the installing user" };
    }
    if (
      realpathSync(configOverride) !== configOverride ||
      realpathSync(stateOverride) !== stateOverride
    ) {
      return { ok: false, reason: "named-profile paths must not resolve through symlinks" };
    }
  } catch {
    return {
      ok: false,
      reason: "named-profile config/state paths must already exist and be accessible",
    };
  }
  return { ok: true };
}
