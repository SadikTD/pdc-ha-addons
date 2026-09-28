import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { Camera as CamIcon, Grid2x2, Grid3x3, Square, Maximize2, HardDrive, Clock3, Activity } from "lucide-react";
import { LiveStream } from "../components/LiveStream";
import { Button, Empty, PageHeader, StatePill, recState } from "../components/ui";
import { useStatus } from "../lib/status";
import { fmtAgo, fmtBitrate, fmtBytes } from "../lib/format";
import type { CameraStatus } from "../lib/api";

const LAYOUTS = [
  { cols: 0, icon: Grid2x2, label: "Auto" },
  { cols: 1, icon: Square, label: "1 column" },
  { cols: 3, icon: Grid3x3, label: "3 columns" },
];

export function LivePage() {
  const { status } = useStatus();
  const [cols, setCols] = useState(() => Number(localStorage.getItem("sentinel.cols") ?? 0));
  const cams = status?.cameras.filter((c) => c.enabled) ?? [];

  const setLayout = (n: number) => {
    setCols(n);
    localStorage.setItem("sentinel.cols", String(n));
  };

  const recording = cams.filter((c) => c.record && c.recorder?.state === "recording").length;
  const motionNow = cams.filter((c) => c.motion?.active).length;

  return (
    <>
      <PageHeader
        title={
          <span>
            Live <span className="text-gradient">view</span>
          </span>
        }
        sub={status ? `${recording} of ${cams.filter((c) => c.record).length} cameras recording${motionNow ? ` · motion on ${motionNow}` : ""}` : "Connecting…"}
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

      {status && <SummaryStrip />}

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
            cols === 1 && "grid-cols-1 max-w-5xl",
            cols === 3 && "grid-cols-2 lg:grid-cols-3",
          )}
        >
          {!status
            ? [0, 1, 2].map((i) => <div key={i} className="skeleton aspect-video rounded-2xl" />)
            : cams.map((c, i) => <CameraTile key={c.id} cam={c} index={i} />)}
        </div>
      )}
    </>
  );
}

function SummaryStrip() {
  const { status } = useStatus();
  if (!status) return null;
  const s = status.storage;
  const clockOk = status.clock.synced && Math.abs(status.clock.offset_ms) < 5000;
  const items = [
    { icon: HardDrive, label: "Storage", value: `${fmtBytes(s.disk.free)} free`, sub: s.capacity_days ? `room for ~${s.capacity_days.toFixed(1)} days` : "measuring…" },
    { icon: Activity, label: "Recorded", value: fmtBytes(s.used), sub: `${fmtBytes(s.rate_bph * 24)}/day` },
    {
      icon: Clock3,
      label: "Clock",
      value: status.clock.synced ? (clockOk ? "In sync" : `Off by ${Math.abs(status.clock.offset_ms / 1000).toFixed(0)}s`) : "Unverified",
      sub: status.clock.synced ? (clockOk ? status.clock.server : "timestamps auto-corrected") : "waiting for internet",
      warn: !clockOk,
    },
  ];
  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
      {items.map(({ icon: I, label, value, sub, warn }, i) => (
        <motion.div
          key={label}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          className="glass flex items-center gap-3 rounded-2xl px-4 py-3"
        >
          <div className={clsx("flex size-10 items-center justify-center rounded-xl", warn ? "bg-amber-500/10 text-amber-300" : "bg-violet-500/10 text-violet-300")}>
            <I className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
            <div className="truncate text-sm font-semibold text-white">{value}</div>
            <div className="truncate text-xs text-slate-500">{sub}</div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function CameraTile({ cam, index }: { cam: CameraStatus; index: number }) {
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
      <LiveStream camera={cam.id} cover className="h-full w-full" />
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
