// What a plan change just did to this shop's collections (Update 2):
// "Your plan changed to Starter — Atlas New Arrivals: every 2 hours → daily
// at 14:30; new-arrivals options turned off". Dismissible; the dismissal is
// stored server-side so it doesn't come back on another device.

import { useFetcher } from "react-router";
import { useT } from "../i18n";
import type { PlanNotice } from "../lib/plans.server";
import { describeNoticeSchedule } from "../lib/card-model";
import { planOf } from "../lib/plans";


export function PlanNoticeBanner({ notice }: { notice: PlanNotice }) {
  const t = useT();
  const fetcher = useFetcher();
  // Optimistic: gone the moment it's dismissed.
  if (fetcher.state !== "idle" || fetcher.data) return null;

  const lines = notice.changes.flatMap((c) => {
    const title = c.collectionId ? c.title : t("notice.shopDefault");
    const out: string[] = [];
    if (c.from && c.to) {
      out.push(t("notice.schedule", { title, from: describeNoticeSchedule(c.from, t), to: describeNoticeSchedule(c.to, t) }));
    }
    if (c.reshuffleOnNewOff || c.keepNewOnTopOff) out.push(t("notice.newArrivalsOff", { title }));
    if (c.pinsCleared) out.push(t("notice.pinsCleared", { title }));
    return out;
  });

  return (
    <s-banner
      tone="warning"
      heading={t("notice.title", { plan: planOf(notice.to).name })}
      dismissible
      onDismiss={() => fetcher.submit({ _action: "dismiss-plan-notice" }, { method: "post" })}
    >
      <s-paragraph>{t("notice.body")}</s-paragraph>
      <ul style={{ margin: "4px 0 8px", paddingInlineStart: 20 }}>
        {lines.slice(0, 20).map((line) => (
          <li key={line}>{line}</li>
        ))}
        {lines.length > 20 && <li>…</li>}
      </ul>
      <s-button slot="secondary-actions" href="/app/plan">
        {t("notice.seePlans")}
      </s-button>
    </s-banner>
  );
}
