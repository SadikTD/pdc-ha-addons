import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, GanttChart } from "lucide-react";
import { Timeline } from "../components/Timeline";
import { Card, Empty, IconButton, PageHeader } from "../components/ui";
import { useStatus } from "../lib/status";
import { useTimeline } from "../lib/useTimeline";
import { DAY, HOUR, fmtDay, fmtDuration, startOfDay } from "../lib/format";

export function TimelinePage() {
  const { status } = useStatus();
  const nav = useNavigate();
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState(() => ({ start: Date.now() - 12 * HOUR, end: Date.now() + HOUR / 2 }));
  const cams = useMemo(() => (status?.cameras ?? []).filter((c) => c.enabled || c.storage.count > 0).map((c) => ({ id: c.id, name: c.name })), [status?.cameras.map((c) => c.id).join()]);
  const lanes = useTimeline(cams, view.start, view.end);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);

  const jumpDay = (d: number) => {
    const s = startOfDay(view.start + (view.end - view.start) / 2) + d * DAY;
    setView({ start: s, end: Math.min(s + DAY, now + HOUR) });
  };

  // Recorded vs. elapsed time in view, per camera.
  const uptime = lanes.map((l) => {
    const a = view.start;
    const b = Math.min(view.end, now);
    let rec = 0;
    for (const s of l.spans) rec += Math.max(0, Math.min(s.e, b) - Math.max(s.s, a));
    return { id: l.id, pct: b > a ? (rec / (b - a)) * 100 : 0, gap: Math.max(0, b - a - rec) };
  });

  return (
    <>
      <PageHeader title="Timeline" sub="Every camera on one timeline. Click anywhere to play from that moment." />
      {status && cams.length === 0 ? (
        <Empty icon={<GanttChart className="size-6" />} title="Nothing recorded yet" />
      ) : (
        <Card className="p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <IconButton title="Previous day" onClick={() => jumpDay(-1)}>
                <ChevronLeft className="size-4" />
              </IconButton>
              <span className="min-w-28 text-center font-semibold text-white">{fmtDay(view.start + (view.end - view.start) / 2)}</span>
              <IconButton title="Next day" onClick={() => jumpDay(1)} disabled={view.end > now}>
                <ChevronRight className="size-4" />
              </IconButton>
            </div>
            <div className="flex gap-1">
              {[
                ["3h", 3 * HOUR],
                ["12h", 12 * HOUR],
                ["24h", DAY],
                ["2d", 2 * DAY],
              ].map(([l, r]) => (
                <button
                  key={l as string}
                  onClick={() => setView({ start: now - (r as number), end: now + (r as number) * 0.04 })}
                  className="rounded-lg px-2.5 py-1 text-xs font-medium text-slate-400 transition hover:bg-white/5 hover:text-white"
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <Timeline
            lanes={lanes}
            start={view.start}
            end={view.end}
            now={now}
            cursor={null}
            onView={(s, e) => setView({ start: s, end: e })}
            onSeek={(t, lane) => lane && nav(`/camera/${lane}?t=${Math.round(t)}`)}
            laneHeight={44}
          />
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {uptime.map((u) => {
              const name = cams.find((c) => c.id === u.id)?.name ?? u.id;
              return (
                <div key={u.id} className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-white">{name}</span>
                    <span className={u.pct > 99 ? "text-emerald-300" : u.pct > 95 ? "text-amber-300" : "text-rose-300"}>{u.pct.toFixed(u.pct > 99.9 ? 0 : 1)}%</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
                    <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all duration-700" style={{ width: `${u.pct}%` }} />
                  </div>
                  <div className="mt-1.5 text-xs text-slate-500">{u.gap > 5000 ? `${fmtDuration(u.gap)} missing in view` : "No gaps in view"}</div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}
