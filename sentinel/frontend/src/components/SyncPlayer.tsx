import { memo, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { Loader2, VideoOff } from "lucide-react";
import { cachingLoader, vodWindow } from "../lib/vodCache";
import { releaseVideo } from "./VodPlayer";

// One camera's recording, kept in step with a shared clock. Every quarter second the
// player compares its position with the clock: small drift is corrected by nudging the
// playback speed, large drift by seeking. Where the camera has no footage it shows a
// placeholder and picks up again when the clock reaches its next recording.

type Frag = { pos: number; dur: number; pdt: number };

function parsePlaylist(text: string): Frag[] {
  const frags: Frag[] = [];
  let pos = 0;
  let pdt = 0;
  let inFile = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      pdt = Date.parse(line.slice(25));
      inFile = 0;
    } else if (line.startsWith("#EXTINF:")) {
      const dur = parseFloat(line.slice(8));
      frags.push({ pos, dur, pdt: pdt + inFile * 1000 });
      pos += dur;
      inFile += dur;
    }
  }
  return frags;
}

// Player position for wall-clock time t, or null when t falls in a gap.
function posAt(frags: Frag[], t: number): number | null {
  let lo = 0;
  let hi = frags.length - 1;
  if (hi < 0 || t < frags[0].pdt) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frags[mid].pdt <= t) lo = mid;
    else hi = mid - 1;
  }
  const f = frags[lo];
  const into = (t - f.pdt) / 1000;
  return into <= f.dur + 0.5 ? f.pos + Math.min(into, f.dur) : null;
}

type Props = {
  camera: string;
  master: () => number;
  playing: boolean;
  rate: number;
  epoch: number; // changes on every user seek
  muted: boolean;
  // Waiting for data for long while the clock runs: the connection can't carry every
  // camera at once.
  onStarved?: (camera: string) => void;
};

export const SyncPlayer = memo(function SyncPlayer({ camera, master, playing, rate, epoch, muted, onStarved }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const win = useRef<{ from: number; to: number; frags: Frag[] } | null>(null);
  const busy = useRef(false);
  // Whether the stream has started downloading: not while the clock is in a gap (that
  // would buffer footage from minutes later, taking bandwidth from the tiles playing).
  const started = useRef(true);
  const seq = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const [state, setState] = useState<"loading" | "playing" | "gap" | "error">("loading");
  const live = useRef({ playing, rate, onStarved });
  live.current = { playing, rate, onStarved };
  // Time spent waiting for data while the clock runs, slowly forgotten while playing: a
  // tile that keeps stalling now and then adds up just like one that never starts.
  const stalled = useRef(0);

  const load = async (t: number) => {
    const v = video.current;
    if (!v) return;
    const n = ++seq.current;
    pending.current?.abort();
    pending.current = null;
    busy.current = true;
    setState("loading");
    hls.current?.destroy();
    hls.current = null;
    const { from, to, url } = vodWindow(camera, t);
    const stale = () => n !== seq.current;
    const gap = () => {
      win.current = { from, to, frags: [] };
      v.removeAttribute("src");
      busy.current = false;
      setState("gap");
    };

    if (Hls.isSupported()) {
      // hls.js fetches the playlist itself (once) and we read the times from it.
      const h = new Hls({ loader: cachingLoader, autoStartLoad: false, testBandwidth: false, maxBufferLength: 12, maxMaxBufferLength: 30, backBufferLength: 10, enableWorker: true });
      hls.current = h;
      h.once(Hls.Events.LEVEL_LOADED, (_e, data) => {
        if (stale()) return;
        const frags = data.details.fragments.map((f) => ({ pos: f.start, dur: f.duration, pdt: f.programDateTime ?? 0 }));
        if (!frags.length) return gap();
        win.current = { from, to, frags };
        busy.current = false;
        started.current = false;
        startSoon();
      });
      h.on(Hls.Events.ERROR, (_e, data) => {
        if (stale()) return;
        if (data.details === Hls.ErrorDetails.LEVEL_EMPTY_ERROR) {
          h.destroy();
          if (hls.current === h) hls.current = null;
          return gap();
        }
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return h.recoverMediaError();
        // The playlist didn't arrive, a file is gone (removed by retention since) or the
        // connection dropped: start over with a fresh playlist.
        h.destroy();
        if (hls.current === h) hls.current = null;
        window.setTimeout(() => !stale() && load(master()), data.response?.code === 404 ? 0 : 2000);
      });
      h.attachMedia(v);
      h.loadSource(url);
      return;
    }

    // Safari: native HLS, and the playlist read here for the times.
    const ac = new AbortController();
    pending.current = ac;
    let frags: Frag[] = [];
    try {
      frags = parsePlaylist(await (await fetch(url, { cache: "no-store", signal: ac.signal })).text());
    } catch {
      if (!stale() && !ac.signal.aborted) {
        busy.current = false;
        setState("error");
      }
      return;
    }
    if (stale() || ac.signal.aborted) return;
    if (!frags.length) return gap();
    win.current = { from, to, frags };
    const pos = posAt(frags, t) ?? 0;
    v.src = url;
    v.addEventListener(
      "loadedmetadata",
      () => {
        v.currentTime = pos;
        busy.current = false;
      },
      { once: true },
    );
  };

  // Start downloading once the clock is at (or a few seconds from) this camera's footage.
  const startSoon = () => {
    const h = hls.current;
    const w = win.current;
    if (started.current || !h || !w) return;
    const now = master();
    const pos = posAt(w.frags, now) ?? posAt(w.frags, now + 8000);
    if (pos === null) return;
    started.current = true;
    h.startLoad(pos);
  };

  useEffect(() => {
    load(master());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, epoch]);

  // Closing the tile stops the pending load, the stream and the element.
  useEffect(() => {
    const v = video.current;
    return () => {
      seq.current++;
      pending.current?.abort();
      hls.current?.destroy();
      hls.current = null;
      releaseVideo(v);
    };
  }, []);

  useEffect(() => {
    if (video.current) video.current.muted = muted;
  }, [muted]);

  // Keep in step with the shared clock.
  useEffect(() => {
    const id = window.setInterval(() => {
      const v = video.current;
      const w = win.current;
      if (!v || !w || busy.current) return;
      const t = master();
      const { playing, rate } = live.current;
      if ((t < w.from + 2000 || t > w.to - 5000) && t < Date.now() - 5000) {
        load(t);
        return;
      }
      startSoon();
      const pos = posAt(w.frags, t);
      if (pos === null) {
        if (!v.paused) v.pause();
        setState("gap");
        return;
      }
      const drift = v.currentTime - pos;
      if (Math.abs(drift) > (playing ? 1.5 : 0.15)) {
        v.currentTime = pos;
      } else if (playing) {
        // Ahead: slow down a little; behind: speed up a little.
        v.playbackRate = rate * (1 - Math.max(-0.12, Math.min(0.12, drift * 0.25)));
      }
      if (playing && v.paused) v.play().catch(() => {});
      if (!playing && !v.paused) v.pause();
      const ready = v.readyState >= 2;
      setState(ready ? "playing" : "loading");
      if (!playing) stalled.current = 0;
      else if (ready) stalled.current = Math.max(0, stalled.current - 80);
      else if ((stalled.current += 250) > 4000) {
        stalled.current = 0;
        live.current.onStarved?.(camera);
      }
    }, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, master]);

  return (
    <div className="relative h-full w-full bg-black">
      <video ref={video} className="h-full w-full object-contain" playsInline muted={muted} />
      {state === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-7 animate-spin text-white/60" />
        </div>
      )}
      {(state === "gap" || state === "error") && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-950/80 text-sm text-slate-400">
          <VideoOff className="size-6" />
          {state === "gap" ? "No recording at this moment" : "Couldn't load the recording"}
        </div>
      )}
    </div>
  );
});
