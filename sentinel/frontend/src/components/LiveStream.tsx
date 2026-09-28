import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Loader2, VideoOff } from "lucide-react";

// go2rtc's <video-stream> web component, served through Sentinel's /go2rtc proxy.
let loader: Promise<unknown> | null = null;
const base = () => location.origin + location.pathname;
function loadPlayer() {
  loader ??= import(/* @vite-ignore */ new URL("go2rtc/video-stream.js", base()).href).catch((e) => {
    loader = null;
    throw e;
  });
  return loader;
}

type VideoStreamEl = HTMLElement & { mode: string; media: string; background: boolean; src: string; video?: HTMLVideoElement };

export function LiveStream({
  camera,
  hq = false,
  audio = false,
  cover = false,
  fill = false,
  className,
  onVideo,
  poster,
}: {
  camera: string;
  hq?: boolean;
  audio?: boolean;
  cover?: boolean;
  // Stretch to the box: for substreams whose shape differs from the camera's picture
  // (e.g. 640x480 of a 16:9 camera).
  fill?: boolean;
  className?: string;
  onVideo?: (v: HTMLVideoElement | null) => void;
  poster?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "playing" | "error">("loading");

  useEffect(() => {
    let el: VideoStreamEl | null = null;
    let cancelled = false;
    let stallTimer = 0;
    setState("loading");
    loadPlayer()
      .then(() => {
        if (cancelled || !host.current) return;
        el = document.createElement("video-stream") as VideoStreamEl;
        el.mode = "mse";
        el.media = audio ? "video,audio" : "video";
        el.background = false;
        host.current.appendChild(el);
        const src = new URL(`go2rtc/api/ws?src=${encodeURIComponent(hq ? camera : `${camera}_sub`)}`, base());
        src.protocol = src.protocol === "https:" ? "wss:" : "ws:";
        el.src = src.toString();
        const v = el.video;
        if (v) {
          v.controls = false;
          v.muted = !audio;
          v.playsInline = true;
          v.addEventListener("playing", () => {
            window.clearTimeout(stallTimer);
            setState("playing");
          });
          v.addEventListener("waiting", () => {
            stallTimer = window.setTimeout(() => setState("loading"), 1500);
          });
          onVideo?.(v);
        }
      })
      .catch(() => setState("error"));
    return () => {
      cancelled = true;
      window.clearTimeout(stallTimer);
      onVideo?.(null);
      el?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, hq, audio]);

  return (
    <div className={clsx("relative overflow-hidden bg-black", cover && "cover", fill && "fill", className)}>
      {poster && state !== "playing" && <img src={poster} className={clsx("absolute inset-0 h-full w-full", fill ? "object-fill" : cover ? "object-cover" : "object-contain")} onError={(e) => (e.currentTarget.style.display = "none")} />}
      <div ref={host} className="absolute inset-0" />
      {state !== "playing" && (
        <div className={clsx("absolute inset-0 flex items-center justify-center", !poster && "bg-gradient-to-b from-ink-900/40 to-ink-950/70")}>
          {state === "loading" ? (
            <Loader2 className="size-7 animate-spin text-white/60" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-sm text-slate-400">
              <VideoOff className="size-6" /> Live view unavailable
            </div>
          )}
        </div>
      )}
    </div>
  );
}
