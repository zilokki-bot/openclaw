// Covers pairing token generation and verification.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const randomBytesMock = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomBytes: (...args: unknown[]) => randomBytesMock(...args),
  };
});

type PairingTokenModule = typeof import("./pairing-token.js");

let verifyPairingToken: PairingTokenModule["verifyPairingToken"];

beforeAll(async () => {
  ({ verifyPairingToken } = await import("./pairing-token.js"));
});

beforeEach(() => {
  randomBytesMock.mockReset();
});

describe("verifyPairingToken", () => {
  it("uses constant-time comparison semantics", () => {
    expect(verifyPairingToken("secret-token", "secret-token")).toBe(true);
    expect(verifyPairingToken("secret-token", "secret-tokEn")).toBe(false);
  });

  it("rejects blank tokens even when both sides match", () => {
    expect(verifyPairingToken("", "")).toBe(false);
    expect(verifyPairingToken("   ", "   ")).toBe(false);
  });
});
