type DeviceTokenRetryDecision = {
  deviceTokenRetryBudgetUsed: boolean;
  authDeviceToken?: string;
  explicitGatewayToken?: string;
  deviceIdentity: object | null;
  storedToken?: string;
  canRetryWithDeviceTokenHint: boolean;
  url: string;
};

function isLoopbackIPv4Host(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4 || octets[0] !== "127") {
    return false;
  }
  return octets.every((octet) => {
    if (!/^\d+$/.test(octet)) {
      return false;
    }
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

export function isTrustedDeviceTokenRetryEndpoint(url: string, pageUrl: string): boolean {
  try {
    const gatewayUrl = new URL(url, pageUrl);
    const host = gatewayUrl.hostname.trim().toLowerCase();
    const isLoopbackHost = host === "localhost" || host === "::1" || host === "[::1]";
    if (isLoopbackHost || isLoopbackIPv4Host(host)) {
      return true;
    }
    return gatewayUrl.host === new URL(pageUrl).host;
  } catch {
    return false;
  }
}

export function shouldRetryWithDeviceToken(
  params: DeviceTokenRetryDecision,
  pageUrl: string,
): boolean {
  return (
    !params.deviceTokenRetryBudgetUsed &&
    !params.authDeviceToken &&
    Boolean(params.explicitGatewayToken) &&
    Boolean(params.deviceIdentity) &&
    Boolean(params.storedToken) &&
    params.canRetryWithDeviceTokenHint &&
    isTrustedDeviceTokenRetryEndpoint(params.url, pageUrl)
  );
}
