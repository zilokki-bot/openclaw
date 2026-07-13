import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
  readPairingConnectErrorDetails,
} from "../../../packages/gateway-protocol/src/connect-error-details.js";

export function resolveGatewayErrorDetailCode(
  error: { details?: unknown } | null | undefined,
): string | null {
  return readConnectErrorDetailCode(error?.details);
}

function shouldContinueReconnectForPairingRequired(details: unknown): boolean {
  const pairingDetails = readPairingConnectErrorDetails(details);
  return (
    pairingDetails?.pauseReconnect === false ||
    pairingDetails?.recommendedNextStep === "wait_then_retry"
  );
}

/**
 * Connect failures that cannot recover while client and server state stay unchanged.
 * AUTH_TOKEN_MISMATCH stays out: the close handler owns its bounded cached-token retry.
 */
export function isNonRecoverableConnectError(error: { details?: unknown } | undefined): boolean {
  if (!error) {
    return false;
  }
  const code = resolveGatewayErrorDetailCode(error);
  if (
    code === ConnectErrorDetailCodes.PAIRING_REQUIRED &&
    shouldContinueReconnectForPairingRequired(error.details)
  ) {
    return false;
  }
  return (
    code === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    code === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH ||
    code === ConnectErrorDetailCodes.PROTOCOL_MISMATCH ||
    code === ConnectErrorDetailCodes.PAIRING_REQUIRED ||
    code === ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED ||
    code === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED
  );
}
