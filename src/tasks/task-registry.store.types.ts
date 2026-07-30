// Defines storage contracts for task registry records and observer events.
import type {
  TaskDeliveryState,
  TaskRecord,
  TaskRuntime,
  TaskStatus,
} from "./task-registry.types.js";

/** Full task registry snapshot used for persistence restore and replacement writes. */
export type TaskRegistryStoreSnapshot = {
  tasks: Map<string, TaskRecord>;
  deliveryStates: Map<string, TaskDeliveryState>;
};

export type TaskRecordPageParams = {
  runtime?: TaskRuntime;
  statuses?: readonly TaskStatus[];
  limit: number;
  cursor?: number;
};

export type TaskRecordPage = {
  tasks: TaskRecord[];
  nextCursor?: string;
};
