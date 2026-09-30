import { useId } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { Heart } from "lucide-react";
import { Logo } from "./Logo";

export const AUTHOR = "Sadik Hossain";

// The author's name in a handwritten script: it writes itself in from left to right, a pen
// stroke underlines it, then its colours drift slowly.
export function Signature({ className, stroke = true }: { className?: string; stroke?: boolean }) {
  const id = useId().replace(/:/g, "");
  return (
    <span className={clsx("relative inline-block leading-none", className)}>
      <span className="signature inline-block pb-[0.18em] pr-[0.08em]">{AUTHOR}</span>
      {stroke && (
        <svg viewBox="0 0 212 14" preserveAspectRatio="none" className="pointer-events-none absolute -bottom-[0.1em] left-[2%] h-[0.32em] w-[96%] overflow-visible" aria-hidden>
          <defs>
            <linearGradient id={`sig-${id}`} x1="0" x2="1">
              <stop offset="0" stopColor="#a78bfa" stopOpacity="0" />
              <stop offset="0.25" stopColor="#a78bfa" />
              <stop offset="0.7" stopColor="#22d3ee" />
              <stop offset="1" stopColor="#f0abfc" stopOpacity="0.2" />
            </linearGradient>
          </defs>
          <path
            d="M2 10 C 38 3, 76 13, 112 7 S 176 3, 210 8"
            fill="none"
            stroke={`url(#sig-${id})`}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray="240"
            strokeDashoffset="240"
            style={{ animation: "sig-stroke 0.9s cubic-bezier(0.65, 0, 0.35, 1) 1.7s forwards" }}
          />
        </svg>
      )}
    </span>
  );
}

// Bottom of the sidebar: a quiet credit that leads to the About card.
export function SidebarCredit() {
  return (
    <Link to="/system#about" title="About Sentinel" className="group mt-3 block rounded-xl px-3 py-2 transition hover:bg-white/[0.03]">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 transition group-hover:text-slate-400">
        Crafted with
        <Heart className="size-3 fill-rose-400/80 text-rose-400/80 animate-pulse-dot" />
        by
      </div>
      <Signature className="mt-1 text-[22px] transition group-hover:drop-shadow-[0_0_12px_rgba(167,139,250,0.55)]" />
    </Link>
  );
}

// The About card: who made Sentinel, over a slowly drifting aurora.
export function AboutCard({ version }: { version: string }) {
  return (
    <motion.section
      id="about"
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="relative mt-8 overflow-hidden rounded-3xl border border-white/[0.08] bg-ink-900/80 p-6 md:p-8"
    >
      {/* Aurora */}
      <div className="pointer-events-none absolute inset-0 opacity-70" aria-hidden>
        <div className="absolute -left-16 -top-24 size-72 rounded-full bg-violet-600/25 blur-3xl" style={{ animation: "sig-drift 14s ease-in-out infinite" }} />
        <div className="absolute -bottom-28 right-0 size-80 rounded-full bg-cyan-500/20 blur-3xl" style={{ animation: "sig-drift 17s ease-in-out -5s infinite reverse" }} />
        <div className="absolute left-1/2 top-1/3 size-56 rounded-full bg-fuchsia-500/10 blur-3xl" style={{ animation: "sig-drift 20s ease-in-out -9s infinite" }} />
      </div>

      <div className="relative flex flex-col items-center gap-6 text-center md:flex-row md:text-left">
        <div className="relative grid size-24 shrink-0 place-items-center">
          <div
            className="absolute inset-0 rounded-full opacity-80 blur-[1px]"
            style={{
              background: "conic-gradient(from 0deg, #8b5cf6, #22d3ee, #f0abfc, #8b5cf6)",
              animation: "sig-spin 8s linear infinite",
              mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1px))",
              WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1px))",
            }}
          />
          <div className="absolute inset-2 rounded-full bg-ink-950/80" />
          <Logo className="relative size-12 drop-shadow-[0_0_18px_rgba(139,92,246,0.5)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">About</div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-white">
            Sentinel <span className="text-base font-medium text-slate-500">v{version}</span>
          </h2>
          <p className="mt-1 text-sm text-slate-400">Watching over home, day and night — recording, recognising and remembering, all on your own hardware.</p>
          <div className="mt-5 flex flex-col items-center gap-1 md:items-start">
            <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">Designed &amp; built by</span>
            <Signature className="text-4xl md:text-5xl" />
          </div>
        </div>
      </div>
    </motion.section>
  );
}
