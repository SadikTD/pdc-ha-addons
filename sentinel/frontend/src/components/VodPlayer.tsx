import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import Hls from "hls.js";
import { Loader2 } from "lucide-react";
import { vodURL } from "../lib/api";

// Plays recordings as HLS. The playlist carries EXT-X-PROGRAM-DATE-TIME for every file, which
// we parse ourselves to map player position <-> wall-clock time (gaps are skipped over).

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

function posToTime(frags: Frag[], pos: number) {
  let lo = 0;
  let hi = frags.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frags[mid].pos <= pos) lo = mid;
    else hi = mid - 1;
  }
  const f = frags[lo];
  return f ? f.pdt + (pos - f.pos) * 1000 : 0;
}

function timeToPos(frags: Frag[], t: number) {
  for (const f of frags) {
    if (t < f.pdt) return f.pos; // in a gap: jump to the next recording
    if (t < f.pdt + f.dur * 1000) return f.pos + (t - f.pdt) / 1000;
  }
  return null;
}

// Stops a video element for good and lets the browser free its decoder and buffers.
export function releaseVideo(v: HTMLVideoElement | null) {
  if (!v) return;
  v.pause();
  v.removeAttribute("src");
  v.load();
}

export type VodHandle = { video: HTMLVideoElement | null; toggle: () => void };

type Props = {
  camera: string;
  seek: { t: number; n: number }; // n changes to force a seek to the same time
  rate: number;
  onTime: (t: number) => void;
  onPlaying: (p: boolean) => void;
  onCaughtUp: () => void;
  onNoFootage: (t: number) => void;
};

export const VodPlayer = forwardRef<VodHandle, Props>(function VodPlayer({ camera, seek, rate, onTime, onPlaying, onCaughtUp, onNoFootage }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const win = useRef<{ from: number; to: number; frags: Frag[] } | null>(null);
  const loadSeq = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(true);
  const cb = useRef({ onTime, onPlaying, onCaughtUp, onNoFootage });
  cb.current = { onTime, onPlaying, onCaughtUp, onNoFootage };

  useImperativeHandle(ref, () => ({
    video: video.current,
    toggle: () => {
      const v = video.current;
      if (!v) return;
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    },
  }));

  // Load a window of recordings around time t and start playing at t.
  const load = async (t: number) => {
    const v = video.current;
    if (!v) return;
    const seq = ++loadSeq.current;
    pending.current?.abort();
    const ac = new AbortController();
    pending.current = ac;
    setLoading(true);
    const now = Date.now();
    const from = t - 2 * 60_000;
    const to = Math.min(now + 60_000, t + 60 * 60_000);
    const url = vodURL(camera, from, to);
    let frags: Frag[];
    try {
      frags = parsePlaylist(await (await fetch(url, { cache: "no-store", signal: ac.signal })).text());
    } catch {
      frags = [];
    }
    // A newer load, or the player was closed while this one was on its way.
    if (seq !== loadSeq.current || ac.signal.aborted) return;
    const pos = timeToPos(frags, t);
    if (!frags.length || pos === null) {
      setLoading(false);
      cb.current.onNoFootage(t);
      return;
    }
    win.current = { from, to, frags };
    const start = () => {
      v.currentTime = pos;
      v.playbackRate = rate;
      v.play().catch(() => {});
    };
    if (Hls.isSupported()) {
      hls.current?.destroy();
      const h = new Hls({ maxBufferLength: 20, backBufferLength: 30, startPosition: pos, enableWorker: true });
      hls.current = h;
      h.on(Hls.Events.MANIFEST_PARSED, () => {
        v.playbackRate = rate;
        v.play().catch(() => {});
      });
      h.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
      });
      h.loadSource(url);
      h.attachMedia(v);
    } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
      v.src = url;
      v.addEventListener("loadedmetadata", start, { once: true });
    }
  };

  // Seek requests: stay in the loaded window when possible.
  useEffect(() => {
    const w = win.current;
    const v = video.current;
    if (w && v && seek.t >= w.from + 60_000 && seek.t < w.to - 60_000) {
      const pos = timeToPos(w.frags, seek.t);
      if (pos !== null && pos < (w.frags.at(-1)!.pos + w.frags.at(-1)!.dur)) {
        v.currentTime = pos;
        v.play().catch(() => {});
        return;
      }
    }
    load(seek.t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek.t, seek.n, camera]);

  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
  }, [rate]);

  // Closing the player stops everything: the pending load, the stream and the element
  // itself, so nothing keeps playing (or downloading) in the background.
  useEffect(() => {
    const v = video.current;
    return () => {
      loadSeq.current++;
      pending.current?.abort();
      hls.current?.destroy();
      hls.current = null;
      releaseVideo(v);
    };
  }, []);

  const onTimeUpdate = () => {
    const v = video.current;
    const w = win.current;
    if (!v || !w || !w.frags.length) return;
    cb.current.onTime(posToTime(w.frags, v.currentTime));
  };

  const onEnded = () => {
    const w = win.current;
    if (!w) return;
    const last = w.frags.at(-1)!;
    const endT = last.pdt + last.dur * 1000;
    if (Date.now() - endT < 20_000) cb.current.onCaughtUp();
    else load(endT + 100);
  };

  return (
    <div className="relative h-full w-full bg-black">
      <video
        ref={video}
        className="h-full w-full object-contain"
        playsInline
        muted={false}
        onTimeUpdate={onTimeUpdate}
        onPlaying={() => {
          setLoading(false);
          cb.current.onPlaying(true);
        }}
        onPause={() => cb.current.onPlaying(false)}
        onWaiting={() => setLoading(true)}
        onSeeked={() => setLoading(false)}
        onEnded={onEnded}
      />
      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-8 animate-spin text-white/70" />
        </div>
      )}
    </div>
  );
});
