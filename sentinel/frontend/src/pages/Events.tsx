import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { Play, Zap } from "lucide-react";
import { Empty, PageHeader } from "../components/ui";
import { useStatus } from "../lib/status";
import { api, thumbURL, type SentinelEvent } from "../lib/api";
import { DAY, HOUR, fmtDay, fmtDuration, fmtTimeSec, startOfDay } from "../lib/format";

const RANGES = [
  { label: "Today", from: () => startOfDay(Date.now()) },
  { label: "24 hours", from: () => Date.now() - DAY },
  { label: "7 days", from: () => Date.now() - 7 * DAY },
  { label: "Custom", from: () => 0 },
];
const CUSTOM = 3;

function toLocalInput(ms: number) {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function EventsPage() {
  const { status } = useStatus();
  const nav = useNavigate();
  const [cams, setCams] = useState<string[]>([]);
  const [range, setRange] = useState(1);
  const [minPeak, setMinPeak] = useState(0);
  const [custom, setCustom] = useState(() => ({ from: toLocalInput(startOfDay(Date.now()) - DAY + 22 * HOUR), to: toLocalInput(startOfDay(Date.now()) + 6 * HOUR) }));
  const [events, setEvents] = useState<SentinelEvent[] | null>(null);
  const names = Object.fromEntries((status?.cameras ?? []).map((c) => [c.id, c.name]));

  useEffect(() => {
    let alive = true;
    const from = range === CUSTOM ? new Date(custom.from).getTime() : RANGES[range].from();
    const to = range === CUSTOM ? new Date(custom.to).getTime() : Date.now() + HOUR;
    if (!(from < to)) return setEvents([]);
    const load = () =>
      api
        .events({ cameras: cams, from, to, limit: 2000 })
        .then((e) => alive && setEvents(e))
        .catch(() => {});
    load();
    const t = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [cams.join(), range, custom.from, custom.to]);

  const groups = useMemo(() => {
    const out: { day: number; items: SentinelEvent[] }[] = [];
    for (const e of (events ?? []).filter((e) => e.peak >= minPeak)) {
      const d = startOfDay(e.start);
      if (out.at(-1)?.day !== d) out.push({ day: d, items: [] });
      out.at(-1)!.items.push(e);
    }
    return out;
  }, [events, minPeak]);

  const toggleCam = (id: string) => setCams((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <>
      <PageHeader title="Events" sub={events ? `${total} motion event${total === 1 ? "" : "s"}${range === CUSTOM ? " in this range" : ""}${cams.length ? ` on ${cams.length} camera${cams.length > 1 ? "s" : ""}` : ""}` : "Loading…"} />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="glass flex rounded-xl p-1">
          {RANGES.map((r, i) => (
            <button key={r.label} onClick={() => setRange(i)} className={clsx("rounded-lg px-3 py-1.5 text-xs font-medium transition", range === i ? "bg-white/10 text-white" : "text-slate-400 hover:text-white")}>
              {r.label}
            </button>
          ))}
        </div>
        {(status?.cameras ?? []).map((c) => {
          const on = cams.length === 0 || cams.includes(c.id);
          return (
            <button
              key={c.id}
              onClick={() => toggleCam(c.id)}
              className={clsx("rounded-full border px-3 py-1.5 text-xs font-medium transition", on && cams.length ? "border-violet-400/40 bg-violet-500/15 text-violet-200" : on ? "border-white/10 bg-white/5 text-slate-300" : "border-white/5 text-slate-500")}
            >
              {c.name}
            </button>
          );
        })}
        {range === CUSTOM && (
          <div className="glass flex flex-wrap items-center gap-2 rounded-xl px-2 py-1">
            <input type="datetime-local" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="h-8 rounded-lg border border-white/10 bg-ink-950 px-2 text-xs text-white [color-scheme:dark]" />
            <span className="text-xs text-slate-500">to</span>
            <input type="datetime-local" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="h-8 rounded-lg border border-white/10 bg-ink-950 px-2 text-xs text-white [color-scheme:dark]" />
          </div>
        )}
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
          Min. size
          <input type="range" min={0} max={10} step={0.5} value={minPeak} onChange={(e) => setMinPeak(Number(e.target.value))} className="w-28" />
          <span className="w-8 tabular-nums text-slate-300">{minPeak}%</span>
        </label>
      </div>

      {events && total === 0 ? (
        <Empty icon={<Zap className="size-6" />} title="No motion events" sub="Nothing moved in front of the selected cameras in this period." />
      ) : !events ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="skeleton aspect-video rounded-xl" />
          ))}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.day} className="mb-8">
            <h2 className="sticky top-0 z-10 -mx-1 mb-3 bg-ink-950/80 px-1 py-2 text-sm font-semibold text-slate-300 backdrop-blur">
              {fmtDay(g.day)} <span className="font-normal text-slate-500">· {g.items.length}</span>
            </h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              {g.items.map((e, i) => (
                <motion.button
                  key={e.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i, 15) * 0.02 }}
                  whileHover={{ y: -3 }}
                  onClick={() => nav(`/camera/${e.camera}?t=${e.start - 3000}`)}
                  className="group overflow-hidden rounded-xl border border-white/[0.07] bg-ink-850 text-left shadow-lg shadow-black/30"
                >
                  <div className="relative aspect-video bg-ink-800">
                    {e.thumb ? <img src={thumbURL(e)} loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" /> : <Zap className="absolute inset-0 m-auto size-5 text-slate-600" />}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                      <span className="flex size-11 items-center justify-center rounded-full bg-white/90 text-ink-950">
                        <Play className="ml-0.5 size-5 fill-current" />
                      </span>
                    </div>
                    <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur">{names[e.camera] ?? e.camera}</span>
                    {!e.end && <span className="absolute right-2 top-2 rounded-md bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold text-black">LIVE</span>}
                  </div>
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-sm font-medium text-white">{fmtTimeSec(e.start)}</span>
                    <span className="text-xs text-slate-500">{e.end ? fmtDuration(e.end - e.start) : "now"}</span>
                  </div>
                </motion.button>
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}
