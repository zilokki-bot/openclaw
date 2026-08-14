// Workboard plugin module implements persistence types behavior.
import type {
  WorkboardAttachment,
  WorkboardBoardMetadata,
  WorkboardCard,
  WorkboardApprovalMutationReceipt,
  WorkboardNotificationSubscription,
} from "./types.js";

/** A proven pre-commit rejection; callers may safely release a reservation. */
export class WorkboardMutationNotCommittedError extends Error {
  override readonly name = "WorkboardMutationNotCommittedError";
}

export type PersistedWorkboardCard = {
  version: 1;
  card: WorkboardCard;
};

export type PersistedWorkboardBoard = {
  version: 1;
  board: WorkboardBoardMetadata;
};

export type PersistedWorkboardNotificationSubscription = {
  version: 1;
  subscription: WorkboardNotificationSubscription;
};

export type PersistedWorkboardAttachment = {
  version: 1;
  attachment: WorkboardAttachment;
  contentBase64: string;
};

export type WorkboardKeyedStore<T = PersistedWorkboardCard> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: T }>>;
};

export type WorkboardRevisionStore = WorkboardKeyedStore<PersistedWorkboardCard> & {
  updateIfRevision(params: {
    key: string;
    expectedRevision: number;
    value: PersistedWorkboardCard;
    receipt: WorkboardApprovalMutationReceipt;
  }): Promise<{ value: PersistedWorkboardCard; replayed: boolean }>;
  lookupApprovalMutationReceipt(
    approvalId: string,
  ): Promise<WorkboardApprovalMutationReceipt | undefined>;
};
