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

function fixedHalf(digits: number): string {
  return `0.5${"0".repeat(digits - 1)}`;
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

  it("fixed — preserves supported precision and rejects invalid arguments", () => {
    expect(render([{ text: "{cost|fixed:21}" }], { cost: 0.5 })).toBe(fixedHalf(21));
    expect(render([{ text: "{cost|fixed:100}" }], { cost: 0.5 })).toBe(fixedHalf(100));
    for (const digits of ["", "-1", "2.5", "101", "1e2", "2junk", "9007199254740992"]) {
      expect(render([{ text: `{cost|fixed:${digits}}` }], { cost: 0.5 })).toBe("");
    }
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

  it.each(["0", "-1", "2.5", "101", "1e2", "2junk", "abc", "9007199254740992"])(
    "meter — rejects invalid width %s",
    (width) => {
      expect(render([{ text: `{x|meter:${width}:braille}` }], { x: 75 })).toBe("");
    },
  );

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
      { when: "model.reasoning", text: "{model.reasoning|alias:reasoning}" },
      { map: "state.fast_mode", cases: { true: "⚡", false: "🐌" } },
      { text: " | 📚 [{context.pct_used|meter:5:braille}]{context.max_tokens|num}" },
      { text: " | ${cost.turn_usd|fixed:4}" },
    ];
    expect(renderUsageBar(tpl(pieces), contract)).toBe("opus46 | med🐌 | 📚 [⣿⣿⣿⣧⠐]272k | $0.0377");
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
    expect(render(cold, { usage: { cache_hit_pct: 80 } })).toBe("");
  });

  it("leaves a segment out when the compared value is missing", () => {
    expect(render(alarm, {})).toBe("");
    expect(render(alarm, { cost: {} })).toBe("");
  });

  it("does not treat booleans as numbers", () => {
    const seg = [{ when: "flag|gt:0", text: "X" }];
    expect(render(seg, { flag: true })).toBe("");
  });

  it("compares against another contract path, not just a literal", () => {
    const seg = [{ when: "a|gt:b", text: "▲" }];
    expect(render(seg, { a: 10, b: 3 })).toBe("▲");
    expect(render(seg, { a: 2, b: 3 })).toBe("");
    expect(render(seg, { a: 10 })).toBe("");
  });

  it("divides by a literal and by a path", () => {
    expect(render([{ text: "{a|div:2|fixed:1}" }], { a: 9 })).toBe("4.5");
    expect(render([{ text: "{a|div:b|fixed:1}" }], { a: 9, b: 3 })).toBe("3.0");
  });

  it("drops the segment when dividing by zero or a missing path", () => {
    expect(render([{ when: "a|div:0", text: "X" }], { a: 9 })).toBe("");
    expect(render([{ when: "a|div:missing", text: "X" }], { a: 9 })).toBe("");
  });

  it("renders the ratio against the previous turn with a direction arrow", () => {
    expect(render([{ text: "{now|delta:prev}" }], { now: 21, prev: 10 })).toBe("↑2.1×");
    expect(render([{ text: "{now|delta:prev}" }], { now: 10, prev: 21 })).toBe("↓2.1×");
  });

  it("stays silent on turn-to-turn noise", () => {
    expect(render([{ text: "{now|delta:prev}" }], { now: 104, prev: 100 })).toBe("");
    expect(render([{ text: "{now|delta:prev}" }], { now: 114, prev: 100 })).toBe("");
    expect(render([{ text: "{now|delta:prev}" }], { now: 116, prev: 100 })).toBe("↑1.2×");
  });

  it("rounds a large ratio to a whole multiplier", () => {
    expect(render([{ text: "{now|delta:prev}" }], { now: 1200, prev: 100 })).toBe("↑12×");
  });

  it("keeps a plain path condition working as before", () => {
    const seg = [{ when: "u.cache_hit_pct", text: "🗄" }];
    expect(render(seg, { u: {} })).toBe("");
    expect(render(seg, { u: { cache_hit_pct: 0 } })).toBe("🗄");
  });

  it("dur — keeps sub-minute spans readable instead of collapsing them to 0m", () => {
    expect(render([{ text: "{x|dur}" }], { x: 12 })).toBe("12s");
    expect(render([{ text: "{x|dur}" }], { x: 59 })).toBe("59s");
    expect(render([{ text: "{x|dur}" }], { x: 60 })).toBe("1m");
    expect(render([{ text: "{x|dur}" }], { x: 0 })).toBe("0s");
  });

  it("alias returning a non-primitive renders empty rather than [object Object]", () => {
    // The interpolation return narrows explicitly now. An alias table whose value
    // is not a primitive previously produced "[object Object]" in a footer.
    expect(render([{ text: "{m|alias:models}" }], { m: "claude-opus-4-6" })).toBe("opus46");
  });
});

describe("verb-yielded nothing and delta display bounds", () => {
  it("honours the fallback when a verb yields nothing, not just a missing path", () => {
    // Found by adversarial review: the fallback used to be checked only against
    // the raw path value, so a threshold that did not hold rendered empty.
    expect(render([{ text: "{a|gt:50||—}" }], { a: 10 })).toBe("—");
    expect(render([{ text: "{a|lt:5||—}" }], { a: 10 })).toBe("—");
    expect(render([{ text: "{a|div:0||—}" }], { a: 10 })).toBe("—");
    expect(render([{ text: "{missing||—}" }], {})).toBe("—");
  });

  it("still renders nothing when a verb yields nothing and no fallback was given", () => {
    expect(render([{ text: "{a|gt:50}" }], { a: 10 })).toBe("");
  });

  it("keeps the decimal shape consistent across the ten-times boundary", () => {
    expect(render([{ text: "{now|delta:prev}" }], { now: 999, prev: 100 })).toBe("↑10×");
    expect(render([{ text: "{now|delta:prev}" }], { now: 1000, prev: 100 })).toBe("↑10×");
    expect(render([{ text: "{now|delta:prev}" }], { now: 990, prev: 100 })).toBe("↑9.9×");
  });

  it("bounds a runaway multiplier instead of printing an exponent", () => {
    expect(render([{ text: "{now|delta:prev}" }], { now: 1, prev: 1e-300 })).toBe("↑>999×");
    expect(render([{ text: "{now|delta:prev}" }], { now: 1e-300, prev: 1 })).toBe("↓>999×");
  });
});

describe("delta sign handling and non-primitive interpolation", () => {
  it("renders nothing when either side is negative", () => {
    // Two negatives divide into a positive ratio; without an explicit guard this
    // rendered a confident "↑2.0×" for values that cannot occur as usage or cost.
    expect(render([{ text: "{now|delta:prev}" }], { now: -10, prev: -5 })).toBe("");
    expect(render([{ text: "{now|delta:prev}" }], { now: -10, prev: 5 })).toBe("");
    expect(render([{ text: "{now|delta:prev}" }], { now: 10, prev: -5 })).toBe("");
  });

  it("does not stringify a non-primitive into the footer", () => {
    // The narrowed return applies to any non-primitive at the end of a chain,
    // not only to an alias table value. Previously String() produced "1,2,3"
    // for an array and "[object Object]" for an object.
    expect(render([{ text: "{arr}" }], { arr: [1, 2, 3] })).toBe("");
    expect(render([{ text: "{arr||—}" }], { arr: [1, 2, 3] })).toBe("—");
    expect(render([{ text: "{obj}" }], { obj: { a: 1 } })).toBe("");
  });
});
