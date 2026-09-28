import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { Columns2, ExternalLink, Moon, Zap } from "lucide-react";
import { Logo } from "../components/Shell";
import { CameraTile } from "./Live";
import { useStatus } from "../lib/status";
import { api, thumbURL, type SentinelEvent } from "../lib/api";
import { DAY, fmtAgo, fmtTime } from "../lib/format";

const GAP = 10;

// Largest 16:9 tile size that fits n tiles into w×h.
function fit(n: number, w: number, h: number) {
  let best = { cols: 1, tile: 0 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    const tile = Math.min((w - GAP * (cols - 1)) / cols, ((h - GAP * (rows - 1)) / rows) * (16 / 9));
    if (tile > best.tile) best = { cols, tile };
  }
  return best;
}

// The Home Assistant dashboard view (custom:sentinel-card): every camera live, sized to
// fill the card, plus the latest motion. New cameras appear here automatically.
export function EmbedPage() {
  const { status } = useStatus();
  const nav = useNavigate();
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [events, setEvents] = useState<SentinelEvent[]>([]);
  const cams = status?.cameras.filter((c) => c.enabled) ?? [];

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    if (area.current) ro.observe(area.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const load = () => api.events({ from: Date.now() - DAY, limit: 12 }).then(setEvents).catch(() => {});
    load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, []);

  const { cols, tile } = fit(cams.length, size.w, size.h);
  const recs = cams.filter((c) => c.record);
  const ok = recs.filter((c) => c.recorder?.state === "recording").length;
  const names = Object.fromEntries(cams.map((c) => [c.id, c.name]));

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Logo className="size-6" />
          <span className="font-semibold text-white">Sentinel</span>
        </div>
        {status && (
          <span className={clsx("flex items-center gap-1.5 text-xs font-medium", ok === recs.length ? "text-emerald-300" : "text-amber-300")}>
            <span className={clsx("size-2 rounded-full", ok === recs.length ? "animate-pulse-dot bg-emerald-400" : "bg-amber-400")} />
            {ok}/{recs.length} recording
          </span>
        )}
        {status?.alerts.enabled && (
          <span className={clsx("flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", status.alerts.active ? "bg-violet-500/20 text-violet-200" : "text-slate-500")}>
            <Moon className="size-3" /> {status.alerts.active ? "Night alerts on" : "Night alerts armed"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Link to="/playback" className="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white">
            <Columns2 className="size-3.5" /> Playback
          </Link>
          <Link to="/events" className="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white">
            <Zap className="size-3.5" /> Events
          </Link>
          <Link to="/" className="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white">
            <ExternalLink className="size-3.5" /> Full app
          </Link>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div ref={area} className="flex min-h-[40vh] min-w-0 flex-1 items-center justify-center lg:min-h-0">
          <div className="grid" style={{ gap: GAP, gridTemplateColumns: `repeat(${cols}, ${Math.floor(tile)}px)` }}>
            {cams.map((c, i) => (
              <CameraTile key={c.id} cam={c} index={i} />
            ))}
          </div>
        </div>

        <aside className="flex shrink-0 flex-col lg:w-64">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Latest motion</span>
            <Link to="/events" className="text-xs text-violet-300 hover:text-violet-200">
              All
            </Link>
          </div>
          <div className="-mx-1 flex min-h-0 gap-2 overflow-x-auto px-1 pb-1 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden">
            {events.length === 0 && <div className="px-1 py-6 text-xs text-slate-600">No motion in the last 24 hours</div>}
            {events.map((e, i) => (
              <motion.button
                key={e.id}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.03 }}
                onClick={() => nav(`/camera/${e.camera}?t=${e.start - 3000}`)}
                className="flex w-56 shrink-0 items-center gap-2.5 rounded-xl border border-white/[0.06] bg-ink-850 p-1.5 text-left transition hover:border-white/15 lg:w-full"
              >
                <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-ink-800">
                  {e.thumb ? <img src={thumbURL(e)} loading="lazy" className="h-full w-full object-cover" /> : <Zap className="absolute inset-0 m-auto size-4 text-slate-600" />}
                  {!e.end && <span className="absolute right-1 top-1 rounded bg-amber-400 px-1 text-[9px] font-bold text-black">NOW</span>}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-white">{names[e.camera] ?? e.camera}</div>
                  <div className="text-[11px] text-slate-400">{fmtTime(e.start)}</div>
                  <div className="text-[11px] text-slate-600">{fmtAgo(e.start)}</div>
                </div>
              </motion.button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
