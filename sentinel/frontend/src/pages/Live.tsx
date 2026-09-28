import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { Camera as CamIcon, Grid2x2, Grid3x3, Square, Maximize2, HardDrive, ShieldCheck, Zap, AlertTriangle, ChevronRight } from "lucide-react";
import { LiveStream } from "../components/LiveStream";
import { Button, Empty, PageHeader, StatePill, recState } from "../components/ui";
import { useStatus } from "../lib/status";
import { fmtAgo, fmtBitrate, fmtBytes, fmtTime, startOfDay } from "../lib/format";
import { api, latestFrameURL, thumbURL, type CameraStatus, type SentinelEvent } from "../lib/api";

const LAYOUTS = [
  { cols: 0, icon: Grid2x2, label: "Auto" },
  { cols: 1, icon: Square, label: "1 column" },
  { cols: 3, icon: Grid3x3, label: "3 columns" },
];

// Today's motion events, shared by the summary card and the recent-motion strip.
function useTodayEvents() {
  const [events, setEvents] = useState<SentinelEvent[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .events({ from: startOfDay(Date.now()), limit: 1000 })
        .then((e) => alive && setEvents(e))
        .catch(() => {});
    load();
    const t = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  return events;
}

export function LivePage() {
  const { status } = useStatus();
  const [cols, setCols] = useState(() => Number(localStorage.getItem("sentinel.cols") ?? 0));
  const events = useTodayEvents();
  const cams = status?.cameras.filter((c) => c.enabled) ?? [];

  const setLayout = (n: number) => {
    setCols(n);
    localStorage.setItem("sentinel.cols", String(n));
  };

  const motionNow = cams.filter((c) => c.motion?.active).length;

  return (
    <>
      <PageHeader
        title={
          <span>
            Live <span className="text-gradient">view</span>
          </span>
        }
        sub={status ? `${cams.length} camera${cams.length === 1 ? "" : "s"}${motionNow ? ` · motion on ${motionNow} right now` : ""}` : "Connecting…"}
        actions={
          <div className="glass flex rounded-xl p-1">
            {LAYOUTS.map(({ cols: n, icon: I, label }) => (
              <button
                key={n}
                title={label}
                onClick={() => setLayout(n)}
                className={clsx("rounded-lg p-2 transition", cols === n ? "bg-white/10 text-white" : "text-slate-500 hover:text-slate-300")}
              >
                <I className="size-4" />
              </button>
            ))}
          </div>
        }
      />

      {status && <SummaryCards events={events} />}

      {status && cams.length === 0 ? (
        <Empty
          icon={<CamIcon className="size-6" />}
          title="No cameras yet"
          sub="Add your first camera's RTSP stream in Settings and Sentinel starts recording right away."
          action={
            <Link to="/settings">
              <Button variant="primary">Add a camera</Button>
            </Link>
          }
        />
      ) : (
        <div
          className={clsx(
            "grid gap-4",
            cols === 0 && "grid-cols-1 md:grid-cols-2 2xl:grid-cols-3",
            cols === 1 && "max-w-5xl grid-cols-1",
            cols === 3 && "grid-cols-2 lg:grid-cols-3",
          )}
        >
          {!status
            ? [0, 1, 2].map((i) => <div key={i} className="skeleton aspect-video rounded-2xl" />)
            : cams.map((c, i) => <CameraTile key={c.id} cam={c} index={i} />)}
        </div>
      )}

      {status && events && events.length > 0 && <RecentMotion events={events} />}
    </>
  );
}

function SummaryCards({ events }: { events: SentinelEvent[] | null }) {
  const { status } = useStatus();
  if (!status) return null;
  const recs = status.cameras.filter((c) => c.enabled && c.record);
  const down = recs.filter((c) => c.recorder?.state !== "recording");
  const measured = recs.filter((c) => c.storage.count > 0);
  const uptime = measured.length ? Math.min(...measured.map((c) => c.storage.uptime_24h)) : 100;
  const s = status.storage;
  const last = events?.[0];
  const lastCam = last && status.cameras.find((c) => c.id === last.camera)?.name;
  const oldest = Math.min(...status.cameras.filter((c) => c.storage.oldest).map((c) => c.storage.oldest));

  const cards = [
    {
      to: "/system",
      icon: down.length ? AlertTriangle : ShieldCheck,
      tone: down.length ? "amber" : "emerald",
      label: "Recording",
      value: down.length ? `${down.length} camera${down.length > 1 ? "s" : ""} not recording` : `All ${recs.length} recording`,
      sub: down.length ? down.map((c) => c.name).join(", ") : `${uptime >= 99.95 ? "100" : uptime.toFixed(1)}% recorded in the last 24 h`,
    },
    {
      to: "/events",
      icon: Zap,
      tone: "amber",
      label: "Motion today",
      value: events ? `${events.length} event${events.length === 1 ? "" : "s"}` : "…",
      sub: last ? `Last: ${lastCam ?? last.camera} · ${fmtAgo(last.start)}` : "Nothing yet today",
    },
    {
      to: "/system",
      icon: HardDrive,
      tone: "violet",
      label: "Storage",
      value: `${fmtBytes(s.disk.free)} free`,
      sub: Number.isFinite(oldest) ? `Footage since ${fmtTime(oldest)}${startOfDay(oldest) < startOfDay(Date.now()) ? " yesterday" : ""} · room for ~${s.capacity_days.toFixed(0)} days` : "Measuring…",
    },
  ];
  const tones: Record<string, string> = {
    emerald: "bg-emerald-500/10 text-emerald-300",
    amber: "bg-amber-500/10 text-amber-300",
    violet: "bg-violet-500/10 text-violet-300",
  };
  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
      {cards.map(({ to, icon: I, tone, label, value, sub }, i) => (
        <motion.div key={label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
          <Link to={to} className="glass group flex items-center gap-3 rounded-2xl px-4 py-3 transition hover:border-white/15 hover:bg-white/[0.05]">
            <div className={clsx("flex size-10 shrink-0 items-center justify-center rounded-xl", tones[tone])}>
              <I className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
              <div className="truncate text-sm font-semibold text-white">{value}</div>
              <div className="truncate text-xs text-slate-500">{sub}</div>
            </div>
            <ChevronRight className="size-4 text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-slate-400" />
          </Link>
        </motion.div>
      ))}
    </div>
  );
}

function RecentMotion({ events }: { events: SentinelEvent[] }) {
  const { status } = useStatus();
  const nav = useNavigate();
  const names = Object.fromEntries((status?.cameras ?? []).map((c) => [c.id, c.name]));
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Recent motion</h2>
        <Link to="/events" className="text-xs text-violet-300 hover:text-violet-200">
          See all
        </Link>
      </div>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
        {events.slice(0, 12).map((e, i) => (
          <motion.button
            key={e.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            whileHover={{ y: -3 }}
            onClick={() => nav(`/camera/${e.camera}?t=${e.start - 3000}`)}
            className="w-48 shrink-0 overflow-hidden rounded-xl border border-white/[0.07] bg-ink-850 text-left"
          >
            <div className="relative aspect-video bg-ink-800">
              {e.thumb ? <img src={thumbURL(e)} loading="lazy" className="h-full w-full object-cover" /> : <Zap className="absolute inset-0 m-auto size-4 text-slate-600" />}
              <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">{names[e.camera] ?? e.camera}</span>
            </div>
            <div className="px-2.5 py-1.5 text-xs">
              <span className="font-medium text-white">{fmtTime(e.start)}</span> <span className="text-slate-500">· {fmtAgo(e.start)}</span>
            </div>
          </motion.button>
        ))}
      </div>
    </section>
  );
}

export function CameraTile({ cam, index }: { cam: CameraStatus; index: number }) {
  const nav = useNavigate();
  const state = recState(cam.enabled, cam.record, cam.recorder);
  const motionOn = !!cam.motion?.active;
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97, y: 12 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -3 }}
      onClick={() => nav(`/camera/${cam.id}`)}
      className={clsx(
        "group relative aspect-video cursor-pointer overflow-hidden rounded-2xl border border-white/[0.07] bg-black shadow-xl shadow-black/40 transition-shadow",
        motionOn && "animate-glow",
      )}
    >
      <LiveStream camera={cam.id} cover poster={latestFrameURL(cam.id)} className="h-full w-full" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/70" />
      <div className="absolute inset-x-0 top-0 flex items-center justify-between p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white drop-shadow">{cam.name}</span>
          {motionOn && (
            <motion.span initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="rounded-full bg-amber-400/90 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-black">
              Motion
            </motion.span>
          )}
        </div>
        <StatePill state={state} compact />
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between p-3 text-xs text-white/75">
        <span>{cam.last_event ? `Last motion ${fmtAgo(cam.last_event.start)}` : "No motion yet"}</span>
        <span className="flex items-center gap-2">
          {cam.recorder && cam.recorder.bitrate_kbps > 0 && <span className="tabular-nums">{fmtBitrate(cam.recorder.bitrate_kbps)}</span>}
          <Maximize2 className="size-4 opacity-0 transition group-hover:opacity-100" />
        </span>
      </div>
    </motion.div>
  );
}
