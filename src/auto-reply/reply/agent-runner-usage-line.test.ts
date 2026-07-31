// Tests usage-line formatting for agent runner completion summaries.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";

describe("appendUsageLine", () => {
  it("preserves reply payload metadata when appending usage text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );

    const [updated] = appendUsageLine([payload], "Usage: 12 in / 3 out");

    expect(updated).toEqual({ text: "message tool reply\nUsage: 12 in / 3 out" });
    expect(getReplyPayloadMetadata(expectDefined(updated, "updated test invariant"))).toMatchObject(
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          idempotencyKey: "run-1:internal-source-reply:0",
          text: "message tool reply\nUsage: 12 in / 3 out",
        },
      },
    );
  });

  it("does not append duplicate usage text", () => {
    const payload = { text: "message tool reply\nUsage: 12 in / 3 out" };

    expect(appendUsageLine([payload], "Usage: 12 in / 3 out")).toEqual([payload]);
  });

  it("removes model-authored legacy footer text before appending the native usage footer", () => {
    const payload = {
      text:
        "На месте 👑\n" +
        "⚙️ Pulse main | deepseek/deepseek-v4-flash | 355K/131K (100%+) | компактов вкл | 23:33 UTC",
    };

    expect(appendUsageLine([payload], "👑 Пульс · DeepSeek Flash 🌘 · ⟦⣿⡇⠐⠐⠐⟧ · $0.0082")).toEqual([
      {
        text: "На месте 👑\n👑 Пульс · DeepSeek Flash 🌘 · ⟦⣿⡇⠐⠐⠐⟧ · $0.0082",
      },
    ]);
  });

  it("removes a trailing manual usage footer without depending on Pulse identity", () => {
    const payload = {
      text: "Готово\n" + "🧪 Responder qa | openai/gpt-5.5 | 12K/272K | compactions on | 20:00 UTC",
    };

    expect(appendUsageLine([payload], "👑 Пульс · GPT-5.5 🌘 · ⟦⣿⡇⠐⠐⠐⟧ · $0.0082")).toEqual([
      {
        text: "Готово\n👑 Пульс · GPT-5.5 🌘 · ⟦⣿⡇⠐⠐⠐⟧ · $0.0082",
      },
    ]);
  });

  it("does not remove manual usage-looking text from the middle of a reply", () => {
    const payload = {
      text:
        "До\n" +
        "🧪 Responder qa | openai/gpt-5.5 | 12K/272K | compactions on | 20:00 UTC\n" +
        "После",
    };

    expect(appendUsageLine([payload], "Usage: 12 in / 3 out")).toEqual([
      {
        text:
          "До\n" +
          "🧪 Responder qa | openai/gpt-5.5 | 12K/272K | compactions on | 20:00 UTC\n" +
          "После\n" +
          "Usage: 12 in / 3 out",
      },
    ]);
  });
});

describe("resolveResponseUsageLine", () => {
  it("renders the full usage footer from reply state even when token usage is zero", () => {
    const line = resolveResponseUsageLine({
      config: {
        messages: {
          responseUsage: "full",
        },
      },
      channel: "telegram",
      usage: { input: 0, output: 0 },
      replyUsageState: {
        provider: "openai",
        model: "gpt-5.5",
        reasoningEffort: "medium",
        authProfileId: "openai:owner@example.com",
        contextTokenBudget: 272_000,
        contextUsedTokens: 131_000,
        compactionCount: 2,
        identity: { name: "Pulse", emoji: "👑" },
      },
    });

    expect(line).toContain("gpt5.5");
    expect(line).toContain("👑");
    expect(line).toContain("🔑openai:owner@…");
    expect(line).toContain("272k");
    expect(line).toContain("🧹2");
  });

  it("keeps token-only usage footer silent when token usage is missing", () => {
    const line = resolveResponseUsageLine({
      config: {
        messages: {
          responseUsage: "tokens",
        },
      },
      channel: "telegram",
      usage: { input: 0, output: 0 },
    });

    expect(line).toBeUndefined();
  });
});
