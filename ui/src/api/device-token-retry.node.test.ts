import { describe, expect, it } from "vitest";
import { shouldRetryWithDeviceToken } from "./device-token-retry.ts";

type DeviceTokenRetryDecision = Parameters<typeof shouldRetryWithDeviceToken>[0];

const DEVICE_IDENTITY = { deviceId: "device-1" };

function decision(
  url: string,
  overrides: Partial<DeviceTokenRetryDecision> = {},
): DeviceTokenRetryDecision {
  return {
    deviceTokenRetryBudgetUsed: false,
    authDeviceToken: undefined,
    explicitGatewayToken: "shared-auth-token",
    deviceIdentity: DEVICE_IDENTITY,
    storedToken: "stored-device-token",
    canRetryWithDeviceTokenHint: true,
    url,
    ...overrides,
  };
}

describe("shouldRetryWithDeviceToken", () => {
  it.each(["ws://127.0.0.1:18789", "ws://127.255.10.42:18789", "ws://localhost:18789"])(
    "allows one bounded retry for trusted loopback endpoint %s",
    (url) => {
      expect(shouldRetryWithDeviceToken(decision(url), "http://localhost:5173/")).toBe(true);
    },
  );

  it.each(["ws://127.example.invalid:18789", "ws://127.0.0.1.example.invalid:18789"])(
    "blocks DNS host %s that only resembles loopback",
    (url) => {
      expect(shouldRetryWithDeviceToken(decision(url), "http://localhost:5173/")).toBe(false);
    },
  );

  it("blocks retries after the one-shot budget is spent", () => {
    expect(
      shouldRetryWithDeviceToken(
        decision("ws://127.0.0.1:18789", { deviceTokenRetryBudgetUsed: true }),
        "http://localhost:5173/",
      ),
    ).toBe(false);
  });
});
