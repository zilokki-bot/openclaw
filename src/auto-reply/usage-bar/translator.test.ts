import { describe, expect, it } from "vitest";
import { buildUsageContract } from "./contract.js";
import { renderUsageBar, type UsageBarTemplate } from "./translator.js";

const SCALES = {
  braille: "⠐⡀⡄⡆⡇⣇⣧⣷⣿",
  moon: "🌑🌘🌗🌖🌕",
  weather: ["🥶", "☁️", "🌥", "⛅️", "🌤", "☀️"],
  plants: ["🪾", "🍂", "🌱", "☘️", "🍀", "🌿"],
};

function tpl(pieces: unknown[]): UsageBarTemplate {
  return {
    scales: SCALES,
    aliases: { models: { "claude-opus-4-6": "opus46" }, reasoning: { medium: "med" } },
    output: { sep: "", surfaces: { discord: pieces } },
  };
}

function render(pieces: unknown[], contract: Record<string, unknown>): string {
  return renderUsageBar(tpl(pieces), { surface: "discord", ...contract });
}

describe("usage-bar verbs", () => {
  it("num — compact counts", () => {
    expect(render([{ text: "{usage.input_tokens|num}" }], { usage: { input_tokens: 3000 } })).toBe(
      "3.0k",
    );
    expect(render([{ text: "{x|num}" }], { x: 272000 })).toBe("272k");
    expect(render([{ text: "{x|num}" }], { x: 128 })).toBe("128");
  });

  it("fixed — fixed-decimal precision", () => {
    expect(render([{ text: "{cost|fixed:4}" }], { cost: 0.03771985 })).toBe("0.0377");
    expect(render([{ text: "{cost|fixed}" }], { cost: 1.5 })).toBe("1.50");
    expect(render([{ text: "{cost|fixed:0}" }], { cost: 2.7 })).toBe("3");
    expect(render([{ text: "{cost|fixed:4}" }], { cost: "nope" })).toBe("");
  });

  it("dur — seconds to reset", () => {
    expect(render([{ text: "{x|dur}" }], { x: 14820 })).toBe("4h07m");
    expect(render([{ text: "{x|dur}" }], { x: 449280 })).toBe("5.2d");
    expect(render([{ text: "{x|dur}" }], { x: 1980 })).toBe("33m");
  });

  it("pct and inv", () => {
    expect(render([{ text: "{x|pct}" }], { x: 96 })).toBe("96%");
    expect(render([{ text: "{x|inv|pct}" }], { x: 75 })).toBe("25%");
  });

  it("meter — multi-cell braille bar", () => {
    expect(render([{ text: "[{x|meter:5:braille}]" }], { x: 75 })).toBe("[⣿⣿⣿⣧⠐]");
    expect(render([{ text: "[{x|meter:5:braille}]" }], { x: 0 })).toBe("[⠐⠐⠐⠐⠐]");
    expect(render([{ text: "[{x|meter:5:braille}]" }], { x: 100 })).toBe("[⣿⣿⣿⣿⣿]");
  });

  it("meter:1 — single glyph, codepoint-correct for astral scales", () => {
    expect(render([{ text: "{x|meter:1:moon}" }], { x: 0 })).toBe("🌑");
    expect(render([{ text: "{x|meter:1:moon}" }], { x: 50 })).toBe("🌗");
    expect(render([{ text: "{x|meter:1:moon}" }], { x: 100 })).toBe("🌕");
  });

  it("meter — preserves default and supported explicit widths", () => {
    expect(render([{ text: "{x|meter::braille}" }], { x: 75 })).toBe("⣿⣿⣿⣧⠐");
    expect(render([{ text: "{x|meter:   :braille}" }], { x: 75 })).toBe("⣿⣿⣿⣧⠐");
    expect(render([{ text: "{x|meter:+5:braille}" }], { x: 75 })).toBe("⣿⣿⣿⣧⠐");
    expect(render([{ text: "{x|meter: 5 :braille}" }], { x: 75 })).toBe("⣿⣿⣿⣧⠐");
    expect(render([{ text: "{x|meter:100:braille}" }], { x: 50 })).toHaveLength(100);
  });

  it("alias — listed shortens, unlisted echoes through", () => {
    expect(render([{ text: "{m|alias:models}" }], { m: "claude-opus-4-6" })).toBe("opus46");
    expect(render([{ text: "{m|alias:models}" }], { m: "some-new-model" })).toBe("some-new-model");
  });

  it("alias — prototype keys (toString, constructor) do not match inherited properties", () => {
    // When a model is named "toString" or "constructor", the `in` operator
    // would match Object.prototype inherited properties and return
    // Object.prototype.toString (a function) instead of the raw key.
    // After the fix (Object.hasOwn), these should echo through unchanged.
    expect(render([{ text: "{m|alias:models}" }], { m: "toString" })).toBe("toString");
    expect(render([{ text: "{m|alias:models}" }], { m: "constructor" })).toBe("constructor");
    expect(render([{ text: "{m|alias:models}" }], { m: "valueOf" })).toBe("valueOf");
    expect(render([{ text: "{m|alias:models}" }], { m: "__proto__" })).toBe("__proto__");
  });

  it("fallback when path is missing/empty", () => {
    expect(render([{ text: "{identity.emoji|🤖} hi" }], {})).toBe("🤖 hi");
    expect(render([{ text: "{identity.emoji|🤖} hi" }], { identity: { emoji: "🩺" } })).toBe(
      "🩺 hi",
    );
  });
});

describe("usage-bar segment forms", () => {
  it("when drops on null/false/empty, keeps on 0", () => {
    const seg = [{ when: "u.cache_hit_pct", text: "🗄 {u.cache_hit_pct|pct}" }];
    expect(render(seg, { u: {} })).toBe("");
    expect(render(seg, { u: { cache_hit_pct: 0 } })).toBe("🗄 0%");
  });

  it("map resolves enum/bool, drops on no match", () => {
    const seg = [{ map: "state.fast_mode", cases: { true: "⚡", false: "🐌" } }];
    expect(render(seg, { state: { fast_mode: true } })).toBe("⚡");
    expect(render(seg, { state: { fast_mode: false } })).toBe("🐌");
    expect(render(seg, { state: {} })).toBe("");
  });

  it("map — prototype keys (toString, constructor) do not match inherited properties", () => {
    // When the map key is "toString" or "constructor", the `in` operator
    // would incorrectly match Object.prototype inherited properties and
    // return undefined (Object.prototype.toString is a function, not a
    // string case value) instead of falling through to _default.
    const seg = [
      { map: "state.mode", cases: { toString: "should-not-match", _default: "fallback" } },
    ];
    expect(render(seg, { state: { mode: "toString" } })).toBe("should-not-match");
    expect(render(seg, { state: { mode: "constructor" } })).toBe("fallback");
  });

  it("each with item_scales picks a scale per window by position", () => {
    const seg = [
      {
        text: "W",
        each: "windows",
        item: "{pct_left|meter:1:*}{resets_in_s|dur}",
        item_scales: ["weather", "plants"],
      },
    ];
    const out = render(seg, {
      windows: [
        { pct_left: 92, resets_in_s: 17100 },
        { pct_left: 70, resets_in_s: 570240 },
      ],
    });
    expect(out).toBe("W ☀️4h45m 🍀6.6d");
  });

  it("each drops the whole segment when the array is empty", () => {
    expect(render([{ text: "W", each: "windows", item: "{x}" }], {})).toBe("");
  });
});

describe("usage-bar end-to-end with buildUsageContract", () => {
  it("renders a full footer from a reply usage snapshot", () => {
    const contract = buildUsageContract(
      {
        provider: "openai",
        model: "claude-opus-4-6",
        reasoningEffort: "medium",
        fastMode: false,
        fallbackUsed: false,
        authProfileId: "openai:owner@example.com",
        gitBranch: "codex/usage-footer-auth-profile-20260730",
        compactionCount: 3,
        contextTokenBudget: 272000,
        contextUsedTokens: 204000,
        usage: { input: 204000, output: 15, cacheRead: 0, cacheWrite: 0, total: 204015 },
        turnUsd: 0.03771985,
      },
      "discord",
    );
    const pieces = [
      { text: "{model.display_name|alias:models}" },
      { map: "model.is_fallback", cases: { true: "🔄" } },
      { text: " | " },
      { when: "runtime.branch", text: "🌿{runtime.branch} | " },
      { when: "model.auth_profile", text: "🔑{model.auth_profile} | " },
      { when: "model.reasoning", text: "{model.reasoning|alias:reasoning}" },
      { map: "state.fast_mode", cases: { true: "⚡", false: "🐌" } },
      { when: "state.compactions", text: "🧹{state.compactions}" },
      { text: " | 📚 [{context.pct_used|meter:5:braille}]{context.max_tokens|num}" },
      { text: " | ${cost.turn_usd|fixed:4}" },
    ];
    expect(renderUsageBar(tpl(pieces), contract)).toBe(
      "opus46 | 🌿codex/usage-footer-auth-profi… | 🔑openai:owner@… | med🐌🧹3 | 📚 [⣿⣿⣿⣧⠐]272k | $0.0377",
    );
  });

  it("keeps mainline branches in the footer contract", () => {
    // Inverted deliberately. This test previously asserted that main/master/HEAD
    // were hidden. Hiding them also hid the signal that an agent had been sitting
    // on mainline for weeks, so the contract now surfaces every branch and lets a
    // template gate on the value if it only wants non-mainline ones.
    const pieces = [{ when: "runtime.branch", text: "🌿{runtime.branch}" }];

    for (const branch of ["main", "master", "HEAD"]) {
      const contract = buildUsageContract(
        { provider: "openai", model: "gpt-5.5", gitBranch: branch },
        "discord",
      );

      expect(renderUsageBar(tpl(pieces), contract)).toBe(`🌿${branch}`);
    }
  });

  it("still omits the branch segment when there is no branch at all", () => {
    const pieces = [{ when: "runtime.branch", text: "🌿{runtime.branch}" }];

    for (const branch of [undefined, "", "   "]) {
      const contract = buildUsageContract(
        {
          provider: "openai",
          model: "gpt-5.5",
          ...(branch === undefined ? {} : { gitBranch: branch }),
        },
        "discord",
      );

      expect(renderUsageBar(tpl(pieces), contract)).toBe("");
    }
  });

  it("keeps non-mainline branches in the footer contract", () => {
    const contract = buildUsageContract(
      { provider: "openai", model: "gpt-5.5", gitBranch: "fix/usage-footer" },
      "discord",
    );

    expect(
      renderUsageBar(tpl([{ when: "runtime.branch", text: "🌿{runtime.branch}" }]), contract),
    ).toBe("🌿fix/usage-footer");
  });

  it("omits the compaction marker when nothing was compacted", () => {
    const pieces = [{ when: "state.compactions", text: "🧹{state.compactions}" }];

    for (const compactionCount of [0, undefined]) {
      const contract = buildUsageContract(
        { provider: "openai", model: "gpt-5.5", compactionCount },
        "discord",
      );

      expect(renderUsageBar(tpl(pieces), contract)).toBe("");
    }
  });

  it("shows the compaction marker once compactions happened", () => {
    const contract = buildUsageContract(
      { provider: "openai", model: "gpt-5.5", compactionCount: 1 },
      "discord",
    );

    expect(
      renderUsageBar(tpl([{ when: "state.compactions", text: "🧹{state.compactions}" }]), contract),
    ).toBe("🧹1");
  });
});

describe("threshold, ratio and division verbs", () => {
  const alarm = [{ when: "cost.turn_usd|gt:0.5", text: "💸" }];

  it("gates a segment on a value crossing the threshold", () => {
    expect(render(alarm, { cost: { turn_usd: 0.6568 } })).toBe("💸");
    expect(render(alarm, { cost: { turn_usd: 0.5 } })).toBe("");
    expect(render(alarm, { cost: { turn_usd: 0.02 } })).toBe("");
  });

  it("gates on a value falling below the threshold", () => {
    const cold = [{ when: "usage.cache_hit_pct|lt:50", text: "🥶" }];
    expect(render(cold, { usage: { cache_hit_pct: 12 } })).toBe("🥶");
    expect(render(cold, { usage: { cache_hit_pct: 94 } })).toBe("");
  });

  it("leaves a segment out when the compared value is missing", () => {
    expect(render(alarm, {})).toBe("");
    expect(render(alarm, { cost: { turn_usd: null } })).toBe("");
  });

  it("does not treat booleans as numbers", () => {
    expect(
      render([{ when: "state.fast_mode|gt:0", text: "!" }], { state: { fast_mode: true } }),
    ).toBe("");
  });

  it("compares against another contract path, not just a literal", () => {
    const overBudget = [{ when: "usage.total_tokens|gt:context.max_tokens", text: "🪫" }];
    expect(render(overBudget, { usage: { total_tokens: 300 }, context: { max_tokens: 200 } })).toBe(
      "🪫",
    );
    expect(render(overBudget, { usage: { total_tokens: 100 }, context: { max_tokens: 200 } })).toBe(
      "",
    );
  });

  it("divides by a literal and by a path", () => {
    expect(
      render([{ text: "{usage.total_tokens|div:1000|fixed:1}k" }], {
        usage: { total_tokens: 4200 },
      }),
    ).toBe("4.2k");
    expect(
      render([{ text: "{usage.output_tokens|div:timing.duration_ms|fixed:2}/ms" }], {
        usage: { output_tokens: 120 },
        timing: { duration_ms: 400 },
      }),
    ).toBe("0.30/ms");
  });

  it("drops the segment when dividing by zero or a missing path", () => {
    expect(render([{ text: "{a|div:b}" }], { a: 10, b: 0 })).toBe("");
    expect(render([{ text: "{a|div:missing}" }], { a: 10 })).toBe("");
  });

  it("renders the ratio against the previous turn with a direction arrow", () => {
    const trend = [{ text: "{usage.total_tokens|delta:usage.last.total_tokens}" }];
    expect(render(trend, { usage: { total_tokens: 2100, last: { total_tokens: 1000 } } })).toBe(
      "↑2.1×",
    );
    expect(render(trend, { usage: { total_tokens: 500, last: { total_tokens: 1000 } } })).toBe(
      "↓2.0×",
    );
    expect(render(trend, { usage: { total_tokens: 1000, last: { total_tokens: 1000 } } })).toBe("");
    expect(render(trend, { usage: { total_tokens: 1000 } })).toBe("");
  });

  it("stays silent on turn-to-turn noise", () => {
    const trend = [{ text: "{a|delta:b}" }];
    for (const [a, b] of [
      [1040, 1000],
      [1000, 1040],
      [1140, 1000],
    ]) {
      expect(render(trend, { a, b })).toBe("");
    }
    expect(render(trend, { a: 1160, b: 1000 })).toBe("↑1.2×");
  });

  it("rounds a large ratio to a whole multiplier", () => {
    expect(render([{ text: "{a|delta:b}" }], { a: 1200, b: 100 })).toBe("↑12×");
  });

  it("keeps a plain path condition working as before", () => {
    expect(
      render([{ when: "runtime.branch", text: "🌿{runtime.branch}" }], {
        runtime: { branch: "fix/thing" },
      }),
    ).toBe("🌿fix/thing");
    expect(render([{ when: "runtime.branch", text: "🌿" }], {})).toBe("");
  });

  it("dur — keeps sub-minute spans readable instead of collapsing them to 0m", () => {
    expect(render([{ text: "{x|dur}" }], { x: 12 })).toBe("12s");
    expect(render([{ text: "{x|dur}" }], { x: 59 })).toBe("59s");
    expect(render([{ text: "{x|dur}" }], { x: 60 })).toBe("1m");
    expect(render([{ text: "{x|dur}" }], { x: 0 })).toBe("0s");
  });
});

describe("footer contract fields", () => {
  it("keeps mainline and detached branches visible", () => {
    for (const branch of ["main", "master", "HEAD", "fix/thing"]) {
      const contract = buildUsageContract({
        provider: "openai",
        model: "gpt-5.5",
        gitBranch: branch,
      });
      expect(
        renderUsageBar(tpl([{ when: "runtime.branch", text: "🌿{runtime.branch}" }]), {
          ...contract,
          surface: "discord",
        }),
      ).toBe(`🌿${branch}`);
    }
  });

  it("truncates a very long branch name", () => {
    const contract = buildUsageContract({
      provider: "openai",
      model: "gpt-5.5",
      gitBranch: "codex/some-extremely-long-branch-name-that-keeps-going",
    });
    expect(
      renderUsageBar(tpl([{ text: "{runtime.branch}" }]), { ...contract, surface: "discord" }),
    ).toBe("codex/some-extremely-long-bra…");
  });
});
