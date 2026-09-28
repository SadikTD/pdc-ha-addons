import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import {
  ArrowLeft, Camera as CamIcon, Download, Expand, Pause, Play, Radio, RotateCcw, RotateCw, Scissors, Volume2, VolumeX, X,
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Zap,
} from "lucide-react";
import { LiveStream } from "../components/LiveStream";
import { VodPlayer, type VodHandle } from "../components/VodPlayer";
import { Timeline } from "../components/Timeline";
import { Button, Card, IconButton, StatePill, recState } from "../components/ui";
import { useStatus } from "../lib/status";
import { useToast } from "../lib/toast";
import { useTimeline } from "../lib/useTimeline";
import { api, exportURL, thumbURL, type SentinelEvent, type Span } from "../lib/api";
import { DAY, HOUR, fmtBitrate, fmtBytes, fmtDay, fmtDuration, fmtTime, fmtTimeSec, startOfDay } from "../lib/format";

const RATES = [1, 2, 4, 8, 16];

function findPlayable(spans: Span[], t: number): number | null {
  for (const s of spans) {
    if (t >= s.s && t < s.e - 1000) return t;
    if (s.s > t) return s.s;
  }
  return null;
}

// Remount per camera / deep link so playback state never leaks between cameras.
export function CameraPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  return <CameraView key={id + ":" + (params.get("t") ?? "")} id={id} initialT={Number(params.get("t")) || 0} />;
}

function CameraView({ id, initialT }: { id: string; initialT: number }) {
  const { status } = useStatus();
  const toast = useToast();
  const cam = status?.cameras.find((c) => c.id === id);

  const [now, setNow] = useState(Date.now());
  const [mode, setMode] = useState<"live" | "playback">(initialT ? "playback" : "live");
  const [seek, setSeek] = useState({ t: initialT, n: 0 });
  const [curT, setCurT] = useState<number | null>(initialT || null);
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(1);
  const [audio, setAudio] = useState(false);
  const [view, setView] = useState(() => {
    const c = initialT || Date.now();
    return initialT ? { start: c - HOUR, end: c + HOUR } : { start: c - 3 * HOUR, end: c + 15 * 60_000 };
  });
  const [follow, setFollow] = useState(!initialT);
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);
  const [events, setEvents] = useState<SentinelEvent[]>([]);
  const vod = useRef<VodHandle>(null);
  const liveVideo = useRef<HTMLVideoElement | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  const lanes = useTimeline(useMemo(() => (cam ? [{ id: cam.id, name: cam.name }] : [{ id, name: id }]), [cam?.id, cam?.name, id]), view.start, view.end);
  const spans = lanes[0]?.spans ?? [];

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Keep the live edge in view while following.
  useEffect(() => {
    if (!follow) return;
    setView((v) => {
      const r = v.end - v.start;
      const end = now + r * 0.08;
      return Math.abs(end - v.end) > r * 0.02 ? { start: end - r, end } : v;
    });
  }, [now, follow]);

  useEffect(() => {
    const from = startOfDay(Math.min(view.start, now)) - DAY;
    api.events({ cameras: [id], from, to: now + HOUR, limit: 300 }).then(setEvents).catch(() => {});
  }, [id, Math.floor(now / 30_000), Math.floor(view.start / DAY)]);

  const goLive = useCallback(() => {
    setMode("live");
    setCurT(null);
    setRate(1);
    setFollow(true);
  }, []);

  const seekTo = useCallback(
    (t: number) => {
      if (t >= Date.now() - 4000) return goLive();
      const p = findPlayable(spans, t);
      if (p === null || p >= Date.now() - 4000) {
        toast("No recording after that point — showing live", "info");
        return goLive();
      }
      if (p !== t) toast(`No footage at ${fmtTime(t)} — jumped to ${fmtTimeSec(p)}`, "info");
      setMode("playback");
      setFollow(false);
      setCurT(p);
      setSeek((s) => ({ t: p, n: s.n + 1 }));
    },
    [spans, goLive, toast],
  );

  const nudge = (sec: number) => {
    if (mode === "live") {
      if (sec < 0) seekTo(Date.now() + sec * 1000);
      return;
    }
    if (curT) seekTo(curT + sec * 1000);
  };

  const togglePlay = () => {
    if (mode === "live") return;
    vod.current?.toggle();
  };

  const snapshot = () => {
    const v = mode === "live" ? liveVideo.current : vod.current?.video;
    if (!v || !v.videoWidth) return toast("No frame to capture yet", "error");
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    const t = mode === "live" ? Date.now() : (curT ?? Date.now());
    c.toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `${id}_${new Date(t).toISOString().replace(/[:.]/g, "-")}.jpg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, "image/jpeg", 0.92);
    toast("Snapshot saved");
  };

  const startClip = () => {
    const c = mode === "live" ? Date.now() - 60_000 : (curT ?? Date.now() - 60_000);
    setSelection({ from: c - 30_000, to: Math.min(Date.now() - 2000, c + 30_000) });
    setFollow(false);
    setView((v) => {
      const r = Math.min(v.end - v.start, 30 * 60_000);
      return { start: c - r / 2, end: c + r / 2 };
    });
  };

  const fullscreen = () => {
    const el = stage.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (e.key === " ") (e.preventDefault(), togglePlay());
      else if (e.key === "ArrowLeft") nudge(e.shiftKey ? -60 : -10);
      else if (e.key === "ArrowRight") nudge(e.shiftKey ? 60 : 10);
      else if (e.key === "l" || e.key === "L") goLive();
      else if (e.key === "f" || e.key === "F") fullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const zoom = (f: number) => {
    const c = curT ?? now;
    const r = Math.max(2 * 60_000, Math.min(7 * DAY, (view.end - view.start) * f));
    setFollow(false);
    setView({ start: c - r / 2, end: c + r / 2 });
  };

  const jumpDay = (d: number) => {
    const s = startOfDay(view.start + (view.end - view.start) / 2) + d * DAY;
    setFollow(false);
    setView({ start: s, end: Math.min(s + DAY, now + HOUR) });
  };

  const dayEvents = events.filter((e) => e.start >= view.start - HOUR && e.start <= view.end + HOUR);

  if (status && !cam) {
    return (
      <div className="py-20 text-center text-slate-400">
        Camera not found. <Link to="/" className="text-violet-300 underline">Back to live view</Link>
      </div>
    );
  }

  const state = cam ? recState(cam.enabled, cam.record, cam.recorder) : "starting";
  const clipSeconds = selection ? (selection.to - selection.from) / 1000 : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex size-9 items-center justify-center rounded-xl bg-white/5 text-slate-300 transition hover:bg-white/10 hover:text-white">
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white md:text-2xl">{cam?.name ?? "…"}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <StatePill state={state} />
              {cam?.recorder?.stream.video_codec && (
                <span>
                  {cam.recorder.stream.width}×{cam.recorder.stream.height} · {cam.recorder.stream.video_codec.toUpperCase()} · {cam.recorder.stream.fps} fps
                </span>
              )}
              {cam?.recorder && cam.recorder.bitrate_kbps > 0 && <span>· {fmtBitrate(cam.recorder.bitrate_kbps)}</span>}
              {cam && <span>· {fmtBytes(cam.storage.bytes)} stored</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* Player stage */}
          <div ref={stage} className="group relative aspect-video overflow-hidden rounded-2xl border border-white/[0.07] bg-black shadow-2xl shadow-black/50">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={mode} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} className="absolute inset-0">
                {mode === "live" ? (
                  <LiveStream camera={id} hq audio={audio} className="h-full w-full" onVideo={(v) => (liveVideo.current = v)} />
                ) : (
                  <VodPlayer
                    ref={vod}
                    camera={id}
                    seek={seek}
                    rate={rate}
                    onTime={setCurT}
                    onPlaying={setPlaying}
                    onCaughtUp={() => {
                      toast("Caught up — back to live", "info");
                      goLive();
                    }}
                    onNoFootage={(t) => {
                      const next = spans.find((s) => s.s > t + 1000);
                      if (next && next.s < Date.now() - 4000) {
                        setSeek((s) => ({ t: next.s, n: s.n + 1 }));
                      } else goLive();
                    }}
                  />
                )}
              </motion.div>
            </AnimatePresence>

            {/* Top overlay */}
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/60 to-transparent p-3">
              <AnimatePresence mode="wait">
                {mode === "live" ? (
                  <motion.span key="live" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-2 rounded-lg bg-rose-500/90 px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-lg">
                    <span className="size-1.5 animate-pulse-dot rounded-full bg-white" /> Live
                  </motion.span>
                ) : (
                  <motion.span key="pb" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="rounded-lg bg-black/60 px-2.5 py-1 font-mono text-sm font-semibold text-white backdrop-blur">
                    {curT ? `${fmtDay(curT)} · ${fmtTimeSec(curT)}` : "…"}
                    {rate !== 1 && <span className="ml-2 text-cyan-300">{rate}×</span>}
                  </motion.span>
                )}
              </AnimatePresence>
              {cam?.motion?.active && mode === "live" && (
                <span className="rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold uppercase text-black">Motion</span>
              )}
            </div>
          </div>

          {/* Controls */}
          <Card className="flex flex-wrap items-center gap-1 p-2">
            <IconButton title="Back 10 s (←)" onClick={() => nudge(-10)}>
              <RotateCcw className="size-4" />
            </IconButton>
            <IconButton title={mode === "live" ? "Live" : playing ? "Pause (space)" : "Play (space)"} onClick={togglePlay} disabled={mode === "live"} className="size-11 bg-white/5">
              {mode === "playback" && !playing ? <Play className="size-5 fill-current" /> : <Pause className="size-5 fill-current" />}
            </IconButton>
            <IconButton title="Forward 10 s (→)" onClick={() => nudge(10)} disabled={mode === "live"}>
              <RotateCw className="size-4" />
            </IconButton>
            <div className="mx-1 flex rounded-xl bg-white/5 p-0.5">
              {RATES.map((r) => (
                <button
                  key={r}
                  disabled={mode === "live"}
                  onClick={() => setRate(r)}
                  className={clsx("rounded-lg px-2 py-1 text-xs font-semibold tabular-nums transition disabled:opacity-30", rate === r && mode === "playback" ? "bg-violet-500 text-white" : "text-slate-400 hover:text-white")}
                >
                  {r}×
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1">
              {mode === "live" && (
                <IconButton title={audio ? "Mute" : "Listen"} onClick={() => setAudio((a) => !a)}>
                  {audio ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
                </IconButton>
              )}
              <IconButton title="Snapshot" onClick={snapshot}>
                <CamIcon className="size-4" />
              </IconButton>
              <IconButton title="Export clip" onClick={startClip}>
                <Scissors className="size-4" />
              </IconButton>
              <IconButton title="Fullscreen (F)" onClick={fullscreen}>
                <Expand className="size-4" />
              </IconButton>
              <Button variant={mode === "live" ? "ghost" : "primary"} size="sm" onClick={goLive} disabled={mode === "live"} className="ml-1">
                <Radio className="size-3.5" /> Live
              </Button>
            </div>
          </Card>

          {/* Timeline */}
          <Card className="p-3 pt-9 md:p-4 md:pt-10">
            <div className="-mt-7 mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <IconButton title="Previous day" onClick={() => jumpDay(-1)} className="size-8">
                  <ChevronLeft className="size-4" />
                </IconButton>
                <span className="min-w-24 text-center text-sm font-semibold text-white">{fmtDay(view.start + (view.end - view.start) / 2)}</span>
                <IconButton title="Next day" onClick={() => jumpDay(1)} className="size-8" disabled={view.end > now}>
                  <ChevronRight className="size-4" />
                </IconButton>
              </div>
              <div className="flex items-center gap-1">
                {[
                  ["1h", HOUR],
                  ["6h", 6 * HOUR],
                  ["24h", DAY],
                ].map(([l, r]) => (
                  <button
                    key={l as string}
                    onClick={() => {
                      const c = curT ?? now;
                      setFollow(mode === "live");
                      setView(mode === "live" ? { start: now - (r as number) * 0.92, end: now + (r as number) * 0.08 } : { start: c - (r as number) / 2, end: c + (r as number) / 2 });
                    }}
                    className="rounded-lg px-2 py-1 text-xs font-medium text-slate-400 transition hover:bg-white/5 hover:text-white"
                  >
                    {l}
                  </button>
                ))}
                <IconButton title="Zoom in" onClick={() => zoom(0.5)} className="size-8">
                  <ZoomIn className="size-4" />
                </IconButton>
                <IconButton title="Zoom out" onClick={() => zoom(2)} className="size-8">
                  <ZoomOut className="size-4" />
                </IconButton>
              </div>
            </div>
            <Timeline
              lanes={lanes}
              start={view.start}
              end={view.end}
              now={now}
              cursor={mode === "live" ? now : curT}
              onView={(s, e) => {
                setFollow(false);
                setView({ start: s, end: e });
              }}
              onSeek={(t) => seekTo(t)}
              selection={selection}
              onSelection={setSelection}
              laneHeight={56}
            />
            <div className="mt-2 flex items-center gap-4 text-[11px] text-slate-500">
              <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-gradient-to-r from-violet-500/70 to-cyan-400/40" /> Recorded</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-1.5 rounded-sm bg-amber-400" /> Motion</span>
              <span className="hidden sm:inline">Drag to pan · scroll to zoom · click to play</span>
            </div>
            <AnimatePresence>
              {selection && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2.5 text-sm">
                    <Scissors className="size-4 text-cyan-300" />
                    <span className="text-slate-200">
                      {fmtTimeSec(selection.from)} → {fmtTimeSec(selection.to)} <span className="text-slate-500">({fmtDuration(clipSeconds * 1000)})</span>
                    </span>
                    <span className="text-xs text-slate-500">Drag the cyan handles to adjust</span>
                    <div className="ml-auto flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
                        <X className="size-3.5" /> Cancel
                      </Button>
                      <a href={exportURL(id, selection.from, selection.to)} download onClick={() => toast("Preparing your clip…", "info")}>
                        <Button size="sm" variant="primary" disabled={clipSeconds > 3 * 3600}>
                          <Download className="size-3.5" /> Download MP4
                        </Button>
                      </a>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </Card>
        </div>

        {/* Events */}
        <Card className="flex max-h-[calc(100vh-10rem)] min-h-64 flex-col overflow-hidden xl:sticky xl:top-4">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-white">
              <Zap className="size-4 text-amber-300" /> Motion events
            </span>
            <span className="text-xs text-slate-500">{dayEvents.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {dayEvents.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-slate-500">No motion in this period</div>
            ) : (
              dayEvents.map((e, i) => (
                <motion.button
                  key={e.id}
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i, 12) * 0.02 }}
                  onClick={() => {
                    seekTo(e.start - 3000);
                    setView({ start: e.start - 30 * 60_000, end: e.start + 30 * 60_000 });
                  }}
                  className={clsx(
                    "flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-white/5",
                    curT && curT >= e.start - 3000 && curT <= (e.end || now) && "bg-violet-500/10 ring-1 ring-violet-400/30",
                  )}
                >
                  <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-ink-800">
                    {e.thumb ? <img src={thumbURL(e)} loading="lazy" className="h-full w-full object-cover" /> : <Zap className="absolute inset-0 m-auto size-4 text-slate-600" />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white">{fmtTimeSec(e.start)}</div>
                    <div className="text-xs text-slate-500">
                      {e.end ? fmtDuration(e.end - e.start) : "ongoing"} · {e.peak.toFixed(1)}% of frame
                    </div>
                  </div>
                </motion.button>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
