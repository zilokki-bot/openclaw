import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWithOwnedSessionTranscriptWriteLock,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import type { NormalizedOutboundPayload } from "./payloads.js";

const appendFreshTranscript = vi.fn(async () => ({
  ok: true as const,
  target: {
    sessionId: "session-1",
    sessionKey: "agent:developer:telegram:developer:direct:163844254",
    storePath: "/tmp/sessions.sqlite",
  },
  messageId: "mirror-1",
}));

vi.mock("../../config/sessions/transcript.runtime.js", () => ({
  appendAssistantMessageToSessionTranscript: async (params: { sessionKey: string }) =>
    await runWithOwnedSessionTranscriptWriteLock(
      { sessionKey: params.sessionKey },
      appendFreshTranscript,
    ),
}));

import { mirrorDeliveredPayloads } from "./deliver-transcript.js";

describe("outbound transcript mirror lifecycle", () => {
  beforeEach(() => {
    appendFreshTranscript.mockClear();
  });

  it("detaches post-send mirroring from a disposed attempt-owned transcript lock", async () => {
    const sessionKey = "agent:developer:telegram:developer:direct:163844254";
    const staleWriteLock = vi.fn(async () => {
      throw new Error("attempt disposed before transcript write");
    });

    await withOwnedSessionTranscriptWrites(
      {
        sessionKey,
        withSessionWriteLock: staleWriteLock,
      },
      async () => {
        await mirrorDeliveredPayloads({
          delivery: {
            cfg: {},
            channel: "telegram",
            to: "163844254",
            payloads: [],
            mirror: {
              sessionKey,
              agentId: "developer",
              expectedSessionId: "session-1",
              idempotencyKey: "yield-final-1",
            },
          } as DeliverOutboundPayloadsCoreParams,
          payloads: [{ text: "final", mediaUrls: [] }] satisfies NormalizedOutboundPayload[],
          channel: "telegram",
          to: "163844254",
        });
      },
    );

    expect(staleWriteLock).not.toHaveBeenCalled();
    expect(appendFreshTranscript).toHaveBeenCalledOnce();
  });
});
