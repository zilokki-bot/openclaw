import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  finalizeApprovalBoundMutation,
  releaseApprovalBoundMutation,
  reserveApprovalBoundMutation,
} from "./approval-bound-mutation-store.js";
import { insertOperatorApproval, resolveOperatorApproval } from "./operator-approval-store.js";

const tempDirs: string[] = [];

function databaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-mutation-"));
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function createAllowedApproval(
  options: OpenClawStateDatabaseOptions,
  id: string,
  mutation: {
    pluginId?: string;
    mutationId?: string;
    resourceId?: string;
    expectedRevision?: number;
    bind?: boolean;
  } = {},
): void {
  const pluginId = mutation.pluginId ?? "workboard";
  insertOperatorApproval({
    approval: {
      id,
      kind: "plugin",
      presentation: {
        kind: "plugin",
        title: "Update Workboard card",
        description: "Apply the approved card mutation.",
        severity: "warning",
        pluginId,
        toolName: "workboard.cards.approvalBoundUpdate",
        agentId: "main",
        allowedDecisions: ["allow-once", "deny"],
      },
      requester: {
        deviceId: "device-a",
        clientId: "client-a",
        deviceTokenAuth: true,
      },
      runtimeEpoch: "runtime-a",
      createdAtMs: 1_000,
      expiresAtMs: 20_000,
      ...(mutation.bind === false
        ? {}
        : {
            approvalMutationBinding: {
              pluginId,
              mutationId: mutation.mutationId ?? "mutation-a",
              resourceKind: "workboard-card",
              resourceId: mutation.resourceId ?? "card-a",
              expectedRevision: mutation.expectedRevision ?? 0,
            },
          }),
    },
    databaseOptions: options,
  });
  resolveOperatorApproval({
    id,
    decision: "allow-once",
    resolver: { kind: "device", id: "reviewer" },
    nowMs: 2_000,
    databaseOptions: options,
  });
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "approval-a",
    mutationId: "mutation-a",
    resourceKind: "workboard-card",
    resourceId: "card-a",
    requester: {
      deviceId: "device-a",
      clientId: "client-a",
      deviceTokenAuth: true,
    },
    expectedRevision: 0,
    ...overrides,
  };
}

describe("approval-bound mutation store", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists one immutable binding and rejects cross-client, mutation, and revision replay", () => {
    const options = databaseOptions();
    createAllowedApproval(options, "approval-a");

    expect(
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding(),
        nowMs: 3_000,
        databaseOptions: options,
      }),
    ).toMatchObject({ outcome: "reserved", reservation: { approvalExpiresAtMs: 20_000 } });
    expect(
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding(),
        nowMs: 3_001,
        databaseOptions: options,
      }),
    ).toMatchObject({ outcome: "already-reserved" });

    expect(() =>
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding({ mutationId: "mutation-b" }),
        nowMs: 3_002,
        databaseOptions: options,
      }),
    ).toThrow(/different mutation, requester, resource, or revision/);
    expect(() =>
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding({
          requester: { deviceId: "device-b", clientId: "client-b", deviceTokenAuth: true },
        }),
        nowMs: 3_002,
        databaseOptions: options,
      }),
    ).toThrow(/different mutation, requester, resource, or revision/);
    expect(() =>
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding({ expectedRevision: 1 }),
        nowMs: 3_002,
        databaseOptions: options,
      }),
    ).toThrow(/different mutation, requester, resource, or revision/);

    createAllowedApproval(options, "approval-b", { mutationId: "mutation-b" });
    expect(() =>
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding({ approvalId: "approval-b" }),
        nowMs: 3_003,
        databaseOptions: options,
      }),
    ).toThrow();
  });

  it("rejects allowed approvals bound at request time to another plugin, action, card, or no mutation", () => {
    const options = databaseOptions();
    createAllowedApproval(options, "unbound", { bind: false });
    expect(() =>
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding({ approvalId: "unbound" }),
        nowMs: 3_000,
        databaseOptions: options,
      }),
    ).toThrow(/no immutable mutation binding from request time/);

    createAllowedApproval(options, "other-plugin", {
      pluginId: "other-plugin",
      mutationId: "other-plugin-mutation",
    });
    expect(() =>
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding({
          approvalId: "other-plugin",
          mutationId: "other-plugin-mutation",
        }),
        nowMs: 3_000,
        databaseOptions: options,
      }),
    ).toThrow(/different mutation, requester, resource, or revision/);

    createAllowedApproval(options, "other-action", { mutationId: "other-action-mutation" });
    expect(() =>
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding({ approvalId: "other-action" }),
        nowMs: 3_000,
        databaseOptions: options,
      }),
    ).toThrow(/different mutation, requester, resource, or revision/);

    createAllowedApproval(options, "other-card", {
      mutationId: "other-card-mutation",
      resourceId: "card-b",
    });
    expect(() =>
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding({ approvalId: "other-card", mutationId: "other-card-mutation" }),
        nowMs: 3_000,
        databaseOptions: options,
      }),
    ).toThrow(/different mutation, requester, resource, or revision/);
  });

  it("releases a failed write, recovers the same binding, and finalizes exactly once", () => {
    const options = databaseOptions();
    createAllowedApproval(options, "approval-a");
    reserveApprovalBoundMutation({
      pluginId: "workboard",
      binding: binding(),
      nowMs: 3_000,
      databaseOptions: options,
    });

    expect(
      releaseApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding(),
        nowMs: 3_100,
        databaseOptions: options,
      }),
    ).toMatchObject({ outcome: "released" });
    expect(
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding(),
        nowMs: 3_200,
        databaseOptions: options,
      }),
    ).toMatchObject({ outcome: "reserved", reservation: { status: "reserved" } });
    expect(
      finalizeApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding(),
        nowMs: 3_300,
        databaseOptions: options,
      }),
    ).toMatchObject({ outcome: "finalized", reservation: { status: "finalized" } });
    expect(
      finalizeApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding(),
        nowMs: 3_400,
        databaseOptions: options,
      }),
    ).toMatchObject({ outcome: "already-finalized" });
    expect(
      reserveApprovalBoundMutation({
        pluginId: "workboard",
        binding: binding(),
        nowMs: 3_500,
        databaseOptions: options,
      }),
    ).toMatchObject({ outcome: "already-finalized" });
  });
});
