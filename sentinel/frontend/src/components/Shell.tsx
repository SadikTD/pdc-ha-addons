import { Link, NavLink, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { LayoutGrid, GanttChart, Zap, Film, HeartPulse, Settings2, Columns2, ArrowLeft, Sparkles, ScanFace } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useStatus } from "../lib/status";

// mobile: false = left out of the phone tab bar (too many tabs; still reachable by link).
const NAV = [
  { to: "/", label: "Live", icon: LayoutGrid },
  { to: "/playback", label: "Playback", icon: Columns2, mobile: false },
  { to: "/timeline", label: "Timeline", icon: GanttChart },
  { to: "/events", label: "Events", icon: Zap },
  { to: "/summary", label: "Summary", icon: Sparkles },
  { to: "/people", label: "People", icon: ScanFace, mobile: false },
  { to: "/clips", label: "Clips", icon: Film },
  { to: "/system", label: "System", icon: HeartPulse },
  { to: "/settings", label: "Settings", icon: Settings2 },
];

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <path d="M32 4 8 13v17c0 15 10.3 26.6 24 30 13.7-3.4 24-15 24-30V13L32 4z" fill="url(#lg)" />
      <circle cx="32" cy="31" r="11" fill="#06080d" />
      <circle cx="32" cy="31" r="5.5" fill="#fff" />
    </svg>
  );
}

function Health() {
  const { status, error } = useStatus();
  if (error && !status) return <span className="text-rose-300">Can't reach Sentinel</span>;
  if (!status) return <span className="text-slate-500">Loading…</span>;
  const recs = status.cameras.filter((c) => c.enabled && c.record && !(c.occasional && c.recorder?.state !== "recording"));
  const ok = recs.filter((c) => c.recorder?.state === "recording").length;
  const all = ok === recs.length;
  return (
    <span className={clsx("flex items-center gap-2", all ? "text-emerald-300" : "text-amber-300")}>
      <span className={clsx("size-2 rounded-full", all ? "bg-emerald-400 animate-pulse-dot" : "bg-amber-400")} />
      {ok}/{recs.length} recording
    </span>
  );
}

// Inside the Home Assistant dashboard card (its iframe is named "sentinel-card").
const inCard = window.name === "sentinel-card";

export function Shell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  // A camera opened from a list (Events, Summary) still counts as being in that list.
  const from = { Events: "/events", Summary: "/summary" }[(loc.state as { from?: string } | null)?.from ?? ""];
  const section = (loc.pathname.startsWith("/camera/") && from) || "/" + (loc.pathname.split("/")[1] ?? "");
  // One scroll area serves every page: a new page starts at its top (the Events list puts
  // itself back where it was left on its own).
  const main = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [loc.pathname]);
  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-white/5 bg-ink-950/60 px-3 py-5 backdrop-blur-xl md:flex">
        <div className="mb-8 flex items-center gap-2.5 px-3">
          <Logo className="size-8" />
          <div>
            <div className="text-lg font-semibold tracking-tight text-white">Sentinel</div>
            <div className="-mt-0.5 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">NVR</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon }) => {
            const active = to === "/" ? section === "/" || section === "/camera" : section === to;
            return (
              <NavLink key={to} to={to} className="relative">
                {active && (
                  <motion.div
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-xl border border-white/10 bg-gradient-to-r from-violet-500/20 to-cyan-500/10"
                    transition={{ type: "spring", stiffness: 500, damping: 38 }}
                  />
                )}
                <span className={clsx("relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors", active ? "text-white" : "text-slate-400 hover:text-slate-200")}>
                  <Icon className={clsx("size-[18px]", active && "text-violet-300")} />
                  {label}
                </span>
              </NavLink>
            );
          })}
        </nav>
        <div className="mt-auto rounded-xl border border-white/5 bg-white/[0.02] px-3 py-3 text-xs font-medium">
          <Health />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header */}
        <header className="flex items-center justify-between border-b border-white/5 px-4 py-3 md:hidden">
          <div className="flex items-center gap-2">
            <Logo className="size-7" />
            <span className="font-semibold text-white">Sentinel</span>
          </div>
          <div className="text-xs font-medium">
            <Health />
          </div>
        </header>
        <main ref={main} className="min-h-0 flex-1 overflow-y-auto">
          {/* Pages only fade in. (Waiting for the old page to animate out could get stuck
              when the new page's code was still loading: the page stayed invisible until
              a second click.) */}
          <motion.div
              key={section}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto w-full max-w-[1600px] px-4 pb-28 pt-5 md:px-8 md:pb-10 md:pt-8"
            >
              {inCard && (
                <Link to="/embed" className="mb-4 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white">
                  <ArrowLeft className="size-3.5" /> Back to the dashboard view
                </Link>
              )}
              {children}
          </motion.div>
        </main>
        {/* Mobile tab bar */}
        <nav className="fixed inset-x-0 bottom-0 z-50 flex border-t border-white/5 bg-ink-950/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
          {NAV.filter((n) => n.mobile !== false).map(({ to, label, icon: Icon }) => {
            const active = to === "/" ? section === "/" || section === "/camera" : section === to;
            return (
              <NavLink key={to} to={to} className={clsx("flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium", active ? "text-white" : "text-slate-500")}>
                <Icon className={clsx("size-5", active && "text-violet-300")} />
                {label}
              </NavLink>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
