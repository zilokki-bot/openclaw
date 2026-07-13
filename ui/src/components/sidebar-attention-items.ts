import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import { isCronJobActiveFailure } from "../lib/cron-status.ts";
import { isMonitoredAuthProvider } from "../lib/model-auth.ts";
import type { IconName } from "./icons.ts";

const CRON_OVERDUE_GRACE_MS = 300_000;

type SidebarAttentionItem = {
  severity: "error" | "warning";
  icon: IconName;
  label: string;
  routeId: NavigationRouteId;
};

export function buildSidebarAttentionItems(params: {
  cronJobs: readonly CronJob[];
  modelAuthStatus: ModelAuthStatusResult | null;
  now: number;
}): SidebarAttentionItem[] {
  const items: SidebarAttentionItem[] = [];
  const failedCron = params.cronJobs.filter(isCronJobActiveFailure).length;
  if (failedCron > 0) {
    items.push({
      severity: "error",
      icon: "clock",
      label: t("attention.cronFailed", { count: String(failedCron) }),
      routeId: "cron",
    });
  }
  const overdueCron = params.cronJobs.filter(
    (job) =>
      job.enabled &&
      job.state?.nextRunAtMs != null &&
      params.now - job.state.nextRunAtMs > CRON_OVERDUE_GRACE_MS,
  ).length;
  if (overdueCron > 0) {
    items.push({
      severity: "warning",
      icon: "clock",
      label: t("attention.cronOverdue", { count: String(overdueCron) }),
      routeId: "cron",
    });
  }

  const monitored = (params.modelAuthStatus?.providers ?? []).filter(isMonitoredAuthProvider);
  const expired = monitored.filter(
    (provider) => provider.status === "expired" || provider.status === "missing",
  );
  if (expired.length > 0) {
    items.push({
      severity: "error",
      icon: "plug",
      label: t("attention.modelAuthExpired", {
        providers: expired.map((provider) => provider.displayName).join(", "),
      }),
      routeId: "model-providers",
    });
  }
  const expiring = monitored.filter((provider) => provider.status === "expiring");
  if (expiring.length > 0) {
    items.push({
      severity: "warning",
      icon: "plug",
      label: t("attention.modelAuthExpiring", {
        providers: expiring
          .map((provider) => `${provider.displayName} (${provider.expiry?.label ?? "soon"})`)
          .join(", "),
      }),
      routeId: "model-providers",
    });
  }
  return items;
}
