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
});

describe("resolveResponseUsageLine", () => {
  it("renders full footer fields from reply state even when token usage is zero", () => {
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
        gitBranch: "codex/footer-release-line",
        contextTokenBudget: 272_000,
        contextUsedTokens: 131_000,
        compactionCount: 0,
        identity: { name: "Pulse", emoji: "👑" },
      },
    });

    expect(line).toContain("gpt5.5");
    expect(line).toContain("👑");
    expect(line).toContain("🔑openai:owner@…");
    expect(line).toContain("🌿codex/footer-release-line");
    expect(line).toContain("🧹0");
    expect(line).toContain("272k");
  });
});
