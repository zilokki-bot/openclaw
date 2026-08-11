import { describe, expect, it } from "vitest";
import { validateNamedProfileInstallPaths } from "./named-profile-install-guard.js";

const safeEnv = {
  OPENCLAW_PROFILE: "developer-gitlane",
  OPENCLAW_CONFIG_PATH: "/profiles/developer-gitlane/openclaw.json",
  OPENCLAW_STATE_DIR: "/profiles/developer-gitlane/state",
};

function guard(overrides: Partial<Parameters<typeof validateNamedProfileInstallPaths>[0]> = {}) {
  return validateNamedProfileInstallPaths({
    env: safeEnv,
    configPath: safeEnv.OPENCLAW_CONFIG_PATH,
    configValid: true,
    configPort: 19110,
    installPort: 19110,
    lstatSync: (candidate) => ({
      uid: 501,
      isFile: () => candidate.endsWith(".json"),
      isDirectory: () => candidate.endsWith("/state"),
      isSymbolicLink: () => false,
    }),
    realpathSync: (candidate) => candidate,
    getuid: () => 501,
    ...overrides,
  });
}

describe("validateNamedProfileInstallPaths", () => {
  it("accepts an existing owned developer-gitlane config/state pair", () => {
    expect(guard()).toEqual({ ok: true });
  });

  it.each([
    [{ ...safeEnv, OPENCLAW_CONFIG_PATH: "relative/openclaw.json" }],
    [{ ...safeEnv, OPENCLAW_STATE_DIR: "/profiles/developer-gitlane/../other" }],
    [{ ...safeEnv, OPENCLAW_PROFILE: "default" }],
    [{ ...safeEnv, OPENCLAW_STATE_DIR: undefined }],
  ])("refuses ambiguous or unsafe path input", (env) => {
    expect(guard({ env })).toMatchObject({ ok: false });
  });

  it("refuses missing, symlinked, and foreign paths", () => {
    expect(
      guard({
        lstatSync: () => {
          throw new Error("missing");
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      guard({
        lstatSync: () => ({
          uid: 501,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => true,
        }),
      }),
    ).toMatchObject({ ok: false });
    expect(
      guard({
        lstatSync: (candidate) => ({
          uid: 502,
          isFile: () => candidate.endsWith(".json"),
          isDirectory: () => candidate.endsWith("/state"),
          isSymbolicLink: () => false,
        }),
      }),
    ).toMatchObject({ ok: false });
  });

  it("requires the validated config and exact configured port", () => {
    expect(guard({ configValid: false })).toMatchObject({ ok: false });
    expect(guard({ configPath: "/other/openclaw.json" })).toMatchObject({ ok: false });
    expect(guard({ installPort: 19111 })).toMatchObject({ ok: false });
  });

  it("does not place secret values in refusal text", () => {
    const result = guard({ env: { ...safeEnv, OPENCLAW_CONFIG_PATH: "relative/secret-value" } });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.reason).not.toContain("secret-value");
  });
});
