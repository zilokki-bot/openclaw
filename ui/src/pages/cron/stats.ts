import { html } from "lit";
import type { CronJob, CronStatus } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatNextRun } from "../../lib/presenter.ts";

export function renderCronStats(props: {
  status: CronStatus | null;
  failingCount: number | null;
  agentScoped: boolean;
  scopedTotal: number | null;
  scopedNextWakeAtMs: number | null;
  jobs: CronJob[];
  jobsTotal: number;
}) {
  // Scoped summaries use dedicated unfiltered queries; the visible jobs array
  // may hold only one filtered page and cannot represent global totals.
  const total = props.agentScoped
    ? (props.scopedTotal ?? t("common.na"))
    : (props.status?.jobs ?? Math.max(props.jobsTotal, props.jobs.length));
  const nextWakeAtMs = props.agentScoped
    ? props.scopedNextWakeAtMs
    : (props.status?.nextWakeAtMs ?? null);
  const failing = props.failingCount;
  return html`
    <div class="cron-stats">
      <div class="cron-stat card">
        <span class="cron-stat__label">${t("cron.stats.tasks")}</span>
        <span class="cron-stat__value">${total}</span>
      </div>
      <div class="cron-stat card">
        <span class="cron-stat__label">${t("cron.stats.failing")}</span>
        <span
          class="cron-stat__value ${typeof failing === "number" && failing > 0
            ? "cron-stat__value--danger"
            : ""}"
        >
          ${failing ?? t("common.na")}
        </span>
      </div>
      <div class="cron-stat card">
        <span class="cron-stat__label">${t("cron.stats.scheduler")}</span>
        <span class="cron-stat__value cron-stat__value--chip">
          ${props.status
            ? props.status.enabled
              ? html`<span class="chip chip-ok">${t("common.enabled")}</span>`
              : html`<span class="chip chip-danger">${t("cron.list.schedulerOff")}</span>`
            : t("common.na")}
        </span>
      </div>
      <div class="cron-stat card">
        <span class="cron-stat__label">${t("cron.stats.nextWake")}</span>
        <span class="cron-stat__value cron-stat__value--time">
          ${formatNextRun(nextWakeAtMs)}
        </span>
      </div>
    </div>
  `;
}
