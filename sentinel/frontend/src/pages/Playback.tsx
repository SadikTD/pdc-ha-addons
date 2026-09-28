import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { Columns2, Expand, Maximize2, Minimize2, Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { SyncPlayer } from "../components/SyncPlayer";
import { Timeline } from "../components/Timeline";
import { JumpTo } from "../components/JumpTo";
import { Card, Empty, IconButton, PageHeader } from "../components/ui";
import { useStatus } from "../lib/status";
import { useToast } from "../lib/toast";
import { useTimeline } from "../lib/useTimeline";
import { api, type SentinelEvent } from "../lib/api";
import { HOUR, fmtDay, fmtTimeSec } from "../lib/format";

const RATES = [1, 2, 4, 8];

// Every camera playing the same moment side by side, on one clock.
export function PlaybackPage() {
  const { status } = useStatus();
  const toast = useToast();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const initial = Math.min(Number(params.get("t")) || Date.now() - 5 * 60_000, Date.now() - 30_000);

  const all = useMemo(
    () => (status?.cameras ?? []).filter((c) => c.enabled || c.storage.count > 0).map((c) => ({ id: c.id, name: c.name })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status?.cameras.map((c) => c.id + c.name).join()],
  );
  const [hidden, setHidden] = useState<string[]>(() => JSON.parse(localStorage.getItem("sentinel.playback.hidden") ?? "[]"));
  const cams = all.filter((c) => !hidden.includes(c.id));

  // Shared clock: base time at a performance.now() instant, advancing at `rate` while playing.
  const clock = useRef({ base: initial, at: performance.now(), rate: 1, playing: true });
  const master = useCallback(() => {
    const c = clock.current;
    return c.playing ? c.base + (performance.now() - c.at) * c.rate : c.base;
  }, []);
  const [t, setT] = useState(initial);
  const [epoch, setEpoch] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(1);
  const [focus, setFocus] = useState<string | null>(null);
  const [audio, setAudio] = useState<string | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [view, setView] = useState({ start: initial - HOUR / 2, end: initial + HOUR / 2 });
  const [events, setEvents] = useState<SentinelEvent[]>([]);
  const stage = useRef<HTMLDivElement>(null);

  const rebase = (patch: Partial<typeof clock.current>) => {
    clock.current = { ...clock.current, base: master(), at: performance.now(), ...patch };
  };
  const seek = useCallback((to: number) => {
    const v = Math.min(to, Date.now() - 5000);
    clock.current = { ...clock.current, base: v, at: performance.now() };
    setT(v);
    setEpoch((e) => e + 1);
  }, []);
  const setPlay = (p: boolean) => {
    rebase({ playing: p });
    setPlaying(p);
  };

  useEffect(() => {
    const id = window.setInterval(() => {
      const m = master();
      if (clock.current.playing && m > Date.now() - 4000) {
        rebase({ base: Date.now() - 4000, playing: false });
        setPlaying(false);
        toast("Caught up with the present", "info");
      }
      setT(master());
    }, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the playhead while playing and after a jump (when paused, the timeline can be
  // panned freely).
  const lastEpoch = useRef(epoch);
  useEffect(() => {
    const jumped = lastEpoch.current !== epoch;
    lastEpoch.current = epoch;
    if (!playing && !jumped) return;
    const span = view.end - view.start;
    if (t < view.start + span * 0.05 || t > view.end - span * 0.1) setView({ start: t - span / 2, end: t + span / 2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, epoch]);

  const lanes = useTimeline(cams, view.start, view.end);

  const hourBucket = Math.floor(t / HOUR);
  useEffect(() => {
    api
      .events({ cameras: cams.map((c) => c.id), from: t - 12 * HOUR, to: t + 12 * HOUR, limit: 2000 })
      .then(setEvents)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hourBucket, cams.map((c) => c.id).join()]);

  const jumpEvent = (dir: -1 | 1) => {
    const sorted = [...events].sort((a, b) => a.start - b.start);
    const e = dir < 0 ? [...sorted].reverse().find((x) => x.start < t - 6000) : sorted.find((x) => x.start > t + 1000);
    if (!e) return toast(dir < 0 ? "No earlier motion" : "No later motion", "info");
    seek(e.start - 3000);
  };

  const setRateTo = (r: number) => {
    rebase({ rate: r });
    setRate(r);
  };

  const toggleHidden = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
    setHidden(next);
    localStorage.setItem("sentinel.playback.hidden", JSON.stringify(next));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (e.key === " ") (e.preventDefault(), setPlay(!clock.current.playing));
      else if (e.key === "ArrowLeft") seek(master() - (e.shiftKey ? 60_000 : 10_000));
      else if (e.key === "ArrowRight") seek(master() + (e.shiftKey ? 60_000 : 10_000));
      else if (e.key === "[") jumpEvent(-1);
      else if (e.key === "]") jumpEvent(1);
      else if (e.key === "g" || e.key === "G") (e.preventDefault(), setJumpOpen(true));
      else if (e.key === "Escape") setFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const shown = focus ? [cams.find((c) => c.id === focus)!, ...cams.filter((c) => c.id !== focus)].filter(Boolean) : cams;
  const n = cams.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const oldest = Math.min(...(status?.cameras ?? []).filter((c) => c.storage.oldest).map((c) => c.storage.oldest));

  return (
    <>
      <PageHeader
        title="Playback"
        sub="All cameras at the same moment — follow someone from one camera to the next."
        actions={<JumpTo onJump={seek} oldest={Number.isFinite(oldest) ? oldest : undefined} open={jumpOpen} setOpen={setJumpOpen} />}
      />
      {status && all.length === 0 ? (
        <Empty icon={<Columns2 className="size-6" />} title="No cameras yet" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {all.map((c) => {
              const on = !hidden.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggleHidden(c.id)}
                  className={clsx("rounded-full border px-3 py-1.5 text-xs font-medium transition", on ? "border-violet-400/40 bg-violet-500/15 text-violet-100" : "border-white/5 text-slate-500 hover:text-slate-300")}
                >
                  {c.name}
                </button>
              );
            })}
          </div>

          <div ref={stage} className={clsx("grid gap-2 rounded-2xl bg-black/40", focus ? "grid-cols-4" : "")} style={focus ? undefined : { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {shown.map((c, i) => {
              const big = focus === c.id;
              return (
                <motion.div
                  layout
                  key={c.id}
                  transition={{ type: "spring", stiffness: 400, damping: 40 }}
                  className={clsx("group relative aspect-video overflow-hidden rounded-xl border border-white/[0.07] bg-black", big && "col-span-4", focus && !big && i > 4 && "hidden")}
                  onDoubleClick={() => nav(`/camera/${c.id}?t=${Math.round(master())}`)}
                >
                  <SyncPlayer camera={c.id} master={master} playing={playing} rate={rate} epoch={epoch} muted={audio !== c.id} />
                  <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/60 to-transparent p-2.5">
                    <span className="text-sm font-semibold text-white drop-shadow">{c.name}</span>
                  </div>
                  <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                    <IconButton title={audio === c.id ? "Mute" : "Listen to this camera"} onClick={() => setAudio(audio === c.id ? null : c.id)} className="size-8 bg-black/50">
                      {audio === c.id ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
                    </IconButton>
                    <IconButton title={big ? "Back to grid (Esc)" : "Enlarge"} onClick={() => setFocus(big ? null : c.id)} className="size-8 bg-black/50">
                      {big ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                    </IconButton>
                  </div>
                </motion.div>
              );
            })}
          </div>

          <Card className="flex flex-wrap items-center gap-1 p-2">
            <IconButton title="Previous motion on any camera ( [ )" onClick={() => jumpEvent(-1)}>
              <SkipBack className="size-4" />
            </IconButton>
            <IconButton title="Back 10 s (←)" onClick={() => seek(master() - 10_000)}>
              <RotateCcw className="size-4" />
            </IconButton>
            <IconButton title={playing ? "Pause (space)" : "Play (space)"} onClick={() => setPlay(!playing)} className="size-11 bg-white/5">
              {playing ? <Pause className="size-5 fill-current" /> : <Play className="size-5 fill-current" />}
            </IconButton>
            <IconButton title="Forward 10 s (→)" onClick={() => seek(master() + 10_000)}>
              <RotateCw className="size-4" />
            </IconButton>
            <IconButton title="Next motion on any camera ( ] )" onClick={() => jumpEvent(1)}>
              <SkipForward className="size-4" />
            </IconButton>
            <div className="mx-1 flex rounded-xl bg-white/5 p-0.5">
              {RATES.map((r) => (
                <button key={r} onClick={() => setRateTo(r)} className={clsx("rounded-lg px-2 py-1 text-xs font-semibold tabular-nums transition", rate === r ? "bg-violet-500 text-white" : "text-slate-400 hover:text-white")}>
                  {r}×
                </button>
              ))}
            </div>
            <div className="ml-2 font-mono text-sm font-semibold text-white">
              {fmtDay(t)} · {fmtTimeSec(t)}
            </div>
            <IconButton
              title="Fullscreen"
              className="ml-auto"
              onClick={() => (document.fullscreenElement ? document.exitFullscreen() : stage.current?.requestFullscreen?.())}
            >
              <Expand className="size-4" />
            </IconButton>
          </Card>

          <Card className="p-3">
            <Timeline
              lanes={lanes}
              start={view.start}
              end={view.end}
              now={Date.now()}
              cursor={t}
              onView={(s, e) => setView({ start: s, end: e })}
              onSeek={(to) => seek(to)}
              laneHeight={30}
            />
            <div className="mt-2 text-[11px] text-slate-500">
              Click the timeline to move every camera there · drag to pan · scroll to zoom · double-click a video to open that camera · <kbd>G</kbd> go to a time
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
