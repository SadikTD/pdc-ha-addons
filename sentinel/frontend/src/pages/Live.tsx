import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { Camera as CamIcon, Grid2x2, Grid3x3, Square, Maximize2, HardDrive, ShieldCheck, Zap, AlertTriangle, ChevronRight, Scan, PowerOff, Volume2, VolumeX } from "lucide-react";
import { fitGrid } from "../lib/layout";
import { LiveStream } from "../components/LiveStream";
import { Empty, PageHeader, StatePill, buttonCls, recState } from "../components/ui";
import { useStatus } from "../lib/status";
import { useSound } from "../lib/sound";
import { fmtAgo, fmtBitrate, fmtBytes, fmtTime, startOfDay } from "../lib/format";
import { api, latestFrameURL, type CameraStatus, type SentinelEvent } from "../lib/api";
import { EventPicture, LabelChips } from "../lib/labels";

const LAYOUTS = [
  { cols: 0, icon: Scan, label: "Fit all cameras on screen" },
  { cols: 1, icon: Square, label: "1 column" },
  { cols: 2, icon: Grid2x2, label: "2 columns" },
  { cols: 3, icon: Grid3x3, label: "3 columns" },
];
const GAP = 8;

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

  // "Fit": size the tiles so every camera is visible without scrolling.
  const area = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 1000, h: 600 });
  useLayoutEffect(() => {
    const measure = () => {
      const el = area.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const bottomNav = window.innerWidth < 768 ? 80 : 0;
      setBox({ w: r.width, h: Math.max(240, window.innerHeight - r.top - 24 - bottomNav) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (area.current) ro.observe(area.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [status === null]);
  const fit = fitGrid(cams.length, box.w, box.h, 280, GAP);

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
            <Link to="/settings" className={buttonCls("primary")}>
              Add a camera
            </Link>
          }
        />
      ) : (
        <div
          ref={area}
          className={clsx("grid", cols === 0 && "justify-center", cols === 1 && "mx-auto max-w-5xl grid-cols-1", cols === 2 && "grid-cols-1 md:grid-cols-2", cols === 3 && "grid-cols-2 lg:grid-cols-3")}
          style={{ gap: GAP, ...(cols === 0 ? { gridTemplateColumns: `repeat(${fit.cols}, ${fit.tile}px)` } : {}) }}
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
  const recs = status.cameras.filter((c) => c.enabled && c.record && !(c.occasional && c.recorder?.state !== "recording"));
  const down = recs.filter((c) => c.recorder?.state !== "recording");
  const measured = recs.filter((c) => c.storage.count > 0);
  const uptime = measured.length ? Math.min(...measured.map((c) => c.storage.uptime_24h)) : 100;
  const s = status.storage;
  const last = events?.[0];
  const lastPerson = events?.find((e) => e.labels?.includes("person"));
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
      to: "/summary",
      icon: Zap,
      tone: "amber",
      label: "Today",
      value: events ? todayLine(events) : "…",
      sub: lastPerson
        ? `Last person: ${status.cameras.find((c) => c.id === lastPerson.camera)?.name ?? lastPerson.camera} · ${fmtAgo(lastPerson.start)}`
        : last
          ? `Last motion: ${lastCam ?? last.camera} · ${fmtAgo(last.start)}`
          : "Nothing yet today",
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
    <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
      {cards.map(({ to, icon: I, tone, label, value, sub }, i) => (
        <motion.div key={label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
          <Link to={to} className="glass group flex items-center gap-3 rounded-2xl px-3.5 py-2.5 transition hover:border-white/15 hover:bg-white/[0.05]">
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
            onClick={() => nav(`/camera/${e.camera}?t=${(e.objects?.[0]?.t ?? e.start) - 3000}`)}
            className="w-48 shrink-0 overflow-hidden rounded-xl border border-white/[0.07] bg-ink-850 text-left"
          >
            <div className="relative aspect-video">
              <EventPicture e={e} className="h-full w-full" boxes={false} />
              <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">{names[e.camera] ?? e.camera}</span>
              <span className="absolute bottom-1.5 left-1.5">
                <LabelChips e={e} size="xs" />
              </span>
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
  const off = cam.occasional && state !== "recording";
  // The substream is often 4:3 (640x480) even when the camera's picture is 16:9: stretch it
  // back to the real shape instead of cropping or letterboxing.
  const s = cam.recorder?.stream;
  const wide = !s?.width || Math.abs(s.width / s.height - 16 / 9) < 0.08;
  const [sound, setSound] = useSound(cam.id);
  const [hasAudio, setHasAudio] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: Math.min(index, 8) * 0.04, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      onClick={() => nav(`/camera/${cam.id}`)}
      className={clsx(
        "group relative aspect-video cursor-pointer overflow-hidden rounded-xl border bg-black shadow-lg shadow-black/40 transition-[border-color]",
        motionOn ? "animate-glow border-amber-400/70" : "border-white/[0.07] hover:border-white/25",
      )}
    >
      {off ? (
        <div className="flex h-full flex-col items-center justify-center gap-1.5 bg-ink-900 text-sm text-slate-500">
          <PowerOff className="size-5" /> Camera is switched off
          <span className="text-xs text-slate-600">Recording starts by itself when it's on</span>
        </div>
      ) : (
        <LiveStream
          camera={cam.id}
          fill={wide}
          poster={latestFrameURL(cam.id)}
          muted={!sound}
          onMutedByBrowser={() => setSound(false)}
          onHasAudio={setHasAudio}
          className="h-full w-full"
        />
      )}
      {/* Small labels only: nothing darkens the picture. */}
      <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5">
        <span className="rounded-md bg-black/55 px-2 py-0.5 text-xs font-semibold text-white backdrop-blur-sm">{cam.name}</span>
        {motionOn && <span className="rounded-md bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold uppercase text-black">Motion</span>}
      </div>
      {!off && (
        <div className="absolute right-2 top-2 flex items-center gap-1.5">
          {hasAudio && (
            <button
              type="button"
              title={sound ? `Mute ${cam.name}` : `Listen to ${cam.name}`}
              aria-label={sound ? `Mute ${cam.name}` : `Listen to ${cam.name}`}
              aria-pressed={sound}
              onClick={(e) => {
                e.stopPropagation(); // don't open the camera
                setSound(!sound);
              }}
              className={clsx(
                "flex size-7 items-center justify-center rounded-md backdrop-blur-sm transition",
                sound ? "bg-emerald-500/90 text-white shadow-lg shadow-emerald-500/30" : "bg-black/55 text-white/80 hover:bg-black/75 hover:text-white",
              )}
            >
              {sound ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            </button>
          )}
          <span className="pointer-events-none">
            <StatePill state={state} compact />
          </span>
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between opacity-0 transition group-hover:opacity-100">
        <span className="rounded-md bg-black/55 px-2 py-0.5 text-[11px] text-white/85 backdrop-blur-sm">{cam.last_event ? `Last motion ${fmtAgo(cam.last_event.start)}` : "No motion yet"}</span>
        <span className="flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-0.5 text-[11px] text-white/85 backdrop-blur-sm">
          {cam.recorder && cam.recorder.bitrate_kbps > 0 && <span className="tabular-nums">{fmtBitrate(cam.recorder.bitrate_kbps)}</span>}
          <Maximize2 className="size-3.5" />
        </span>
      </div>
    </motion.div>
  );
}

// "3 people · 1 cat · 120 motion", leaving out what wasn't seen.
function todayLine(events: SentinelEvent[]) {
  const n = { person: 0, cat: 0, dog: 0 };
  for (const e of events) for (const l of e.labels ?? []) n[l]++;
  const parts = [
    n.person && `${n.person} ${n.person === 1 ? "person" : "people"}`,
    n.cat && `${n.cat} cat${n.cat === 1 ? "" : "s"}`,
    n.dog && `${n.dog} dog${n.dog === 1 ? "" : "s"}`,
    `${events.length} motion`,
  ].filter(Boolean);
  return parts.join(" · ");
}
