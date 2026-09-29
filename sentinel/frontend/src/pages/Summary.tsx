import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Loader2, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { Card, IconButton, PageHeader } from "../components/ui";
import { api, type DaySummary } from "../lib/api";
import { openEvent } from "../lib/eventNav";
import { DAY, fmtDay, fmtDuration, fmtTime } from "../lib/format";
import { EventPicture, LABELS, LABEL_ORDER, LabelChips, MOTION_COLOR } from "../lib/labels";

const iso = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const parseISO = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};

export function SummaryPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? iso(Date.now());
  const [sum, setSum] = useState<DaySummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const today = iso(Date.now());
  const day = parseISO(date);

  useEffect(() => {
    let alive = true;
    setSum(null);
    setErr(null);
    const load = () =>
      api
        .summary(date)
        .then((s) => alive && setSum(s))
        .catch((e) => alive && setErr((e as Error).message));
    load();
    const t = date === today ? window.setInterval(load, 30_000) : 0;
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [date]);

  const go = (d: number) => setParams({ date: iso(day + d * DAY + 2 * 3_600_000) }, { replace: true });
  const recorded = sum?.cameras.filter((c) => c.recorded > 0) ?? [];
  const worst = recorded.length ? Math.min(...recorded.map((c) => c.recorded)) : null;

  return (
    <>
      <PageHeader
        title={
          <span>
            Daily <span className="text-gradient">summary</span>
          </span>
        }
        sub={date === today ? "Today so far" : fmtDay(day)}
        actions={
          <div className="glass flex items-center gap-1 rounded-xl p-1">
            <IconButton title="Previous day" onClick={() => go(-1)}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <label className="relative flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-white hover:bg-white/5">
              <CalendarDays className="size-4 text-slate-400" />
              {date === today ? "Today" : new Date(day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
              <input type="date" max={today} value={date} onChange={(e) => e.target.value && setParams({ date: e.target.value }, { replace: true })} className="absolute inset-0 cursor-pointer opacity-0 [color-scheme:dark]" />
            </label>
            <IconButton title="Next day" onClick={() => go(1)} disabled={date >= today}>
              <ChevronRight className="size-4" />
            </IconButton>
          </div>
        }
      />

      {err && <Card className="p-5 text-sm text-rose-300">{err}</Card>}
      {!sum && !err && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton h-24 rounded-2xl" />
          ))}
        </div>
      )}
      {sum && (
        <div className="space-y-4">
          {/* In one sentence */}
          <Card className="flex items-start gap-3 p-5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300">
              <Sparkles className="size-5" />
            </span>
            <div>
              <p className="text-[15px] leading-relaxed text-slate-200">{sum.text}</p>
              {sum.pending > 0 && (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                  <Loader2 className="size-3 animate-spin" /> {sum.pending} event{sum.pending === 1 ? " is" : "s are"} still being checked for people and animals.
                </p>
              )}
            </div>
          </Card>

          {/* Totals */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {LABEL_ORDER.map((l) => {
              const L = LABELS[l];
              const n = sum.totals[l] ?? 0;
              return (
                <button
                  key={l}
                  onClick={() => nav(`/events?q=${encodeURIComponent(`${L.plural} ${date === today ? "today" : date}`)}`)}
                  className="glass flex items-center gap-3 rounded-2xl p-4 text-left transition hover:border-white/15"
                >
                  <span className="flex size-10 items-center justify-center rounded-xl" style={{ background: `${L.color}26`, color: L.color }}>
                    <L.icon className="size-5" />
                  </span>
                  <span>
                    <span className="block text-2xl font-semibold tabular-nums text-white">{n}</span>
                    <span className="text-xs text-slate-400">{n === 1 ? L.name : L.plural} seen</span>
                  </span>
                </button>
              );
            })}
            <div className="glass flex items-center gap-3 rounded-2xl p-4">
              <span className="flex size-10 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300">
                <Zap className="size-5" />
              </span>
              <span>
                <span className="block text-2xl font-semibold tabular-nums text-white">{sum.totals.motion ?? 0}</span>
                <span className="text-xs text-slate-400">Motion events</span>
              </span>
            </div>
            <div className="glass col-span-2 flex items-center gap-3 rounded-2xl p-4 lg:col-span-1">
              <span className={clsx("flex size-10 items-center justify-center rounded-xl", worst === null || worst >= 99 ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300")}>
                {worst === null || worst >= 99 ? <ShieldCheck className="size-5" /> : <AlertTriangle className="size-5" />}
              </span>
              <span>
                <span className="block text-2xl font-semibold tabular-nums text-white">{worst === null ? "—" : `${worst >= 99.95 ? 100 : worst.toFixed(1)}%`}</span>
                <span className="text-xs text-slate-400">Recorded (worst camera)</span>
              </span>
            </div>
          </div>

          {/* By hour */}
          <div className="grid gap-4 lg:grid-cols-2">
            <HourChart
              title="People and animals by hour"
              hours={sum.hours}
              series={LABEL_ORDER.map((l, i) => ({ key: l, name: LABELS[l].plural, color: LABELS[l].color, idx: i + 1 }))}
            />
            <HourChart title="Motion events by hour" hours={sum.hours} series={[{ key: "motion", name: "Motion events", color: MOTION_COLOR, idx: 0 }]} />
          </div>

          {/* Highlights */}
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Highlights</h2>
              <span className="text-xs text-slate-500">The clearest sightings of the day</span>
            </div>
            {sum.highlights.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">No people or animals seen{date === today ? " yet today" : " this day"}.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {sum.highlights.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => openEvent(nav, h, sum.highlights, "Summary", `summary:${sum.date}`)}
                    className="group overflow-hidden rounded-xl border border-white/[0.07] bg-ink-850 text-left"
                  >
                    <div className="relative aspect-video">
                      <EventPicture e={h} className="h-full w-full transition duration-500 group-hover:scale-105" />
                      <span className="absolute bottom-2 left-2">
                        <LabelChips e={h} />
                      </span>
                    </div>
                    <div className="flex items-center justify-between px-3 py-2 text-xs">
                      <span className="font-medium text-white">{sum.cameras.find((c) => c.id === h.camera)?.name ?? h.camera}</span>
                      <span className="tabular-nums text-slate-400">{fmtTime(h.start)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>

          {/* Per camera */}
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-white/5 text-left text-xs text-slate-500">
                  <th className="px-5 py-3 font-medium">Camera</th>
                  {LABEL_ORDER.map((l) => (
                    <th key={l} className="px-3 py-3 text-right font-medium">
                      {LABELS[l].plural}
                    </th>
                  ))}
                  <th className="px-3 py-3 text-right font-medium">Motion</th>
                  <th className="px-3 py-3 font-medium">People seen</th>
                  <th className="px-5 py-3 text-right font-medium">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {sum.cameras.map((c) => (
                  <tr key={c.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]">
                    <td className="px-5 py-3 font-medium text-white">
                      <button onClick={() => nav(`/camera/${c.id}?t=${c.last_person ? c.last_person - 3000 : sum.from}`)} className="hover:underline">
                        {c.name}
                      </button>
                    </td>
                    {LABEL_ORDER.map((l) => (
                      <td key={l} className={clsx("px-3 py-3 text-right tabular-nums", c.counts[l] ? "text-white" : "text-slate-600")}>
                        {c.counts[l] ?? 0}
                      </td>
                    ))}
                    <td className="px-3 py-3 text-right tabular-nums text-slate-300">{c.counts.motion ?? 0}</td>
                    <td className="px-3 py-3 text-xs text-slate-400">{c.first_person ? (c.first_person === c.last_person ? fmtTime(c.first_person) : `${fmtTime(c.first_person)} – ${fmtTime(c.last_person!)}`) : "—"}</td>
                    <td className="px-5 py-3 text-right">
                      {c.recorded > 0 ? (
                        <span className={c.recorded >= 99 ? "text-emerald-300" : c.recorded >= 95 ? "text-amber-300" : "text-rose-300"} title={c.missing > 60_000 ? `${fmtDuration(c.missing)} missing` : undefined}>
                          {c.recorded >= 99.95 ? "100" : c.recorded.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </>
  );
}

type Series = { key: string; name: string; color: string; idx: number };

// Events per hour: bars (stacked when there are several kinds), with a tooltip per hour.
function HourChart({ title, hours, series }: { title: string; hours: DaySummary["hours"]; series: Series[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = hours.map((h) => series.reduce((n, s) => n + h[s.idx], 0));
  const max = Math.max(1, ...totals);
  const nice = niceMax(max);
  const H = 132;
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {series.length > 1 && (
          <div className="flex flex-wrap gap-3">
            {series.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5 text-xs text-slate-400">
                <span className="size-2.5 rounded-sm" style={{ background: s.color }} /> {s.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="relative flex gap-2">
        {/* y axis: 0 and the top value only */}
        <div className="flex flex-col justify-between text-right text-[10px] tabular-nums text-slate-500" style={{ height: H }}>
          <span>{nice}</span>
          <span>0</span>
        </div>
        <div className="relative flex-1">
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-white/[0.06]" />
          <div className="absolute inset-x-0 border-t border-white/10" style={{ top: H }} />
          <div className="flex items-end gap-[2px]" style={{ height: H }} onMouseLeave={() => setHover(null)}>
            {hours.map((h, i) => (
              <div key={i} className="relative flex h-full flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
                <div className={clsx("absolute inset-0 rounded-t", hover === i && "bg-white/[0.04]")} />
                <div className="relative flex flex-col-reverse gap-[2px]">
                  {series.map((s, k) => {
                    const v = h[s.idx];
                    if (!v) return null;
                    const top = series.slice(k + 1).every((t) => !h[t.idx]);
                    return <div key={s.key} className={top ? "rounded-t-[4px]" : ""} style={{ height: Math.max(2, (v / nice) * H), background: s.color }} />;
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex text-[10px] tabular-nums text-slate-500">
            {hours.map((_, i) => (
              <span key={i} className="flex-1 text-center">
                {i % 3 === 0 ? String(i).padStart(2, "0") : ""}
              </span>
            ))}
          </div>
          {hover !== null && (
            <div
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-white/10 bg-ink-900 px-2.5 py-1.5 text-xs shadow-xl"
              style={{ left: `${((hover + 0.5) / 24) * 100}%` }}
            >
              <div className="mb-0.5 font-semibold text-white">
                {String(hover).padStart(2, "0")}:00–{String((hover + 1) % 24).padStart(2, "0")}:00
              </div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5 text-slate-300">
                  <span className="size-2 rounded-sm" style={{ background: s.color }} /> {s.name}: <span className="tabular-nums text-white">{hours[hover][s.idx]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return v;
}
