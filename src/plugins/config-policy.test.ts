// Covers plugin config policy validation and ownership decisions.
import { describe, expect, it } from "vitest";
import { hasExplicitPluginConfig, normalizePluginsConfigWithResolver } from "./config-policy.js";

describe("normalizePluginsConfigWithResolver", () => {
  it("uses the provided plugin id resolver for allow deny and entry keys", () => {
    const normalized = normalizePluginsConfigWithResolver(
      {
        allow: [" alpha "],
        deny: [" beta "],
        entries: {
          " gamma ": {
            enabled: true,
          },
        },
      },
      (id) => id.trim().toUpperCase(),
    );

    expect(normalized.allow).toEqual(["ALPHA"]);
    expect(normalized.deny).toEqual(["BETA"]);
    expect(normalized.entries).toHaveProperty("GAMMA");
  });

  it("treats null plugin entries as explicit disabled intent", () => {
    const normalized = normalizePluginsConfigWithResolver({
      entries: {
        "pulse-footer": null,
      } as Record<string, unknown>,
    });

    expect(normalized.entries["pulse-footer"]?.enabled).toBe(false);
  });
});

describe("hasExplicitPluginConfig", () => {
  it("detects explicit config from slots and entry keys", () => {
    expect(hasExplicitPluginConfig({ slots: { memory: "none" } })).toBe(true);
    expect(hasExplicitPluginConfig({ entries: { foo: {} } })).toBe(true);
    expect(hasExplicitPluginConfig({})).toBe(false);
  });
});
