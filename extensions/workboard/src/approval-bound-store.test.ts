// Workboard tests cover approval-bound store behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

describe("WorkboardStore", () => {
  it("increments legacy revision zero and writes the approval receipt atomically", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-cas-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    try {
      const stores = createWorkboardSqliteStores({ dbPath });
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const changes: number[] = [];
      store.subscribeChanges((change) => changes.push(change.revision));
      const card = await store.create({ title: "Approval-bound card" });
      expect(card.revision).toBe(0);

      const result = await store.updateIfRevision({
        id: card.id,
        expectedRevision: 0,
        patch: { notes: "approved" },
        receipt: {
          approvalId: "approval-a",
          mutationId: "mutation-a",
          requesterDeviceId: "device-a",
          requesterClientId: "client-a",
          requesterDeviceTokenAuth: true,
          createdAt: 2_000,
        },
      });
      expect(result).toMatchObject({
        replayed: false,
        card: { revision: 1, notes: "approved" },
        receipt: {
          approvalId: "approval-a",
          cardId: card.id,
          oldRevision: 0,
          newRevision: 1,
        },
      });
      expect(await store.lookupApprovalMutationReceipt("approval-a")).toEqual(result.receipt);
      expect(changes).toEqual([1, 2]);

      await expect(
        store.updateIfRevision({
          id: card.id,
          expectedRevision: 0,
          patch: { notes: "stale" },
          receipt: {
            approvalId: "approval-b",
            mutationId: "mutation-b",
            requesterDeviceId: "device-a",
            requesterClientId: "client-a",
            requesterDeviceTokenAuth: true,
            createdAt: 2_001,
          },
        }),
      ).rejects.toThrow(/revision conflict/);
      expect(await store.lookupApprovalMutationReceipt("approval-b")).toBeUndefined();
      expect(await store.get(card.id)).toMatchObject({ revision: 1, notes: "approved" });
      stores.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
