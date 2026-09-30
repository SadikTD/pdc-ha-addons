import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Clock3, HardDrive, Info, RefreshCw, ShieldCheck, Wifi, XCircle, Radio } from "lucide-react";
import { AboutCard } from "../components/MadeBy";
import { Button, Card, PageHeader, SectionTitle, Stat, StatePill, recState } from "../components/ui";
import { useStatus } from "../lib/status";
import { useToast } from "../lib/toast";
import { api, type Incident } from "../lib/api";
import { fmtAgo, fmtBitrate, fmtBytes, fmtDuration, fmtTimeSec, fmtDay } from "../lib/format";

export function SystemPage() {
  const { status, refresh } = useStatus();
  const toast = useToast();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const { hash } = useLocation();
  const loaded = !!status;
  // Opened from the sidebar's credit: go to the About card.
  useEffect(() => {
    if (hash === "#about" && loaded) document.getElementById("about")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hash, loaded]);

  useEffect(() => {
    const load = () => api.incidents(200).then(setIncidents).catch(() => {});
    load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, []);

  if (!status) return <div className="skeleton h-64 rounded-2xl" />;

  const recs = status.cameras.filter((c) => c.enabled && c.record && !(c.occasional && c.recorder?.state !== "recording"));
  const bad = recs.filter((c) => c.recorder?.state !== "recording");
  const s = status.storage;
  const total = s.disk.total || 1; // not measured yet
  const sentinelPct = Math.min(100, (s.used / total) * 100);
  const otherPct = Math.max(0, Math.min(100 - sentinelPct, ((s.disk.used - s.used) / total) * 100));
  const clock = status.clock;
  const clockOk = clock.synced && Math.abs(clock.offset_ms) < 5000;

  return (
    <>
      <PageHeader title="System" sub={`Sentinel ${status.version} · up ${fmtDuration(status.uptime_ms)}`} />

      <Card
        className={clsx(
          "relative mb-6 overflow-hidden p-6",
          bad.length === 0 ? "border-emerald-400/20" : "border-amber-400/25",
        )}
      >
        <div className={clsx("pointer-events-none absolute -right-16 -top-16 size-64 rounded-full blur-3xl", bad.length === 0 ? "bg-emerald-500/15" : "bg-amber-500/15")} />
        <div className="relative flex items-center gap-4">
          <motion.div
            initial={{ scale: 0.6, rotate: -10 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 18 }}
            className={clsx("flex size-14 items-center justify-center rounded-2xl", bad.length === 0 ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300")}
          >
            {bad.length === 0 ? <ShieldCheck className="size-7" /> : <AlertTriangle className="size-7" />}
          </motion.div>
          <div>
            <div className="text-lg font-semibold text-white">
              {bad.length === 0 ? "All cameras are recording" : `${bad.length} camera${bad.length > 1 ? "s" : ""} not recording`}
            </div>
            <div className="text-sm text-slate-400">
              {bad.length === 0
                ? "Every recorder is writing footage. The watchdog restarts any stream that stalls within 20 seconds."
                : bad.map((c) => `${c.name}: ${c.recorder?.last_error || c.recorder?.state || "starting"}`).join(" · ")}
            </div>
          </div>
        </div>
      </Card>

      <SectionTitle>Cameras</SectionTitle>
      <div className="mb-8 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {status.cameras.map((c) => {
          const r = c.recorder;
          return (
            <Card key={c.id} className="p-5">
              <div className="mb-4 flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-white">{c.name}</div>
                  <div className="text-xs text-slate-500">
                    {r?.stream.video_codec ? `${r.stream.width}×${r.stream.height} ${r.stream.video_codec.toUpperCase()} · ${r.stream.fps} fps${r.stream.audio_codec ? ` · audio ${r.audio ? "on" : "off"}` : ""}` : "probing stream…"}
                  </div>
                </div>
                <StatePill state={recState(c.enabled, c.record, r)} />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Bitrate" value={r?.bitrate_kbps ? fmtBitrate(r.bitrate_kbps) : "—"} />
                <Stat label="Last write" value={r?.last_write ? fmtAgo(r.last_write) : "—"} accent={r?.last_write && Date.now() - r.last_write > 15000 ? "text-amber-300" : undefined} />
                <Stat label="Restarts 24h" value={r?.restarts_24h ?? 0} accent={r && r.restarts_24h > 10 ? "text-amber-300" : undefined} />
                <Stat label="Stored" value={fmtBytes(c.storage.bytes)} sub={c.storage.oldest ? `since ${fmtDay(c.storage.oldest)} ${fmtTimeSec(c.storage.oldest)}` : undefined} />
                <Stat label="Keep" value={`${c.retain_days} day${c.retain_days > 1 ? "s" : ""}`} />
                <Stat label="Motion" value={c.motion ? (c.motion.active ? "Active" : c.motion.state === "running" ? "Watching" : c.motion.state) : "Off"} accent={c.motion?.active ? "text-amber-300" : undefined} />
              </div>
              {r?.last_error && r.state !== "recording" && <div className="mt-4 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{r.last_error}</div>}
              {r && (
                <div className="mt-4 flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await api.restartCamera(c.id);
                        toast(`Reconnecting ${c.name}…`, "info");
                        refresh();
                      } catch (e) {
                        toast((e as Error).message, "error");
                      }
                    }}
                  >
                    <RefreshCw className="size-3.5" /> Reconnect
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <div className="mb-8 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <SectionTitle sub={`Oldest recordings are removed automatically to keep ${s.min_free_gb} GB free`}>
            <span className="flex items-center gap-2"><HardDrive className="size-4" /> Storage</span>
          </SectionTitle>
          <div className="mb-3 flex h-3 overflow-hidden rounded-full bg-white/5">
            <motion.div initial={{ width: 0 }} animate={{ width: `${sentinelPct}%` }} transition={{ duration: 1, ease: "easeOut" }} className="bg-gradient-to-r from-violet-500 to-cyan-400" />
            <motion.div initial={{ width: 0 }} animate={{ width: `${otherPct}%` }} transition={{ duration: 1, ease: "easeOut", delay: 0.2 }} className="bg-slate-600" />
          </div>
          <div className="mb-5 flex flex-wrap gap-4 text-xs text-slate-400">
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-violet-400" /> Sentinel {fmtBytes(s.used)}</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-slate-500" /> Other {fmtBytes(Math.max(0, s.disk.used - s.used))}</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-white/10" /> Free {fmtBytes(s.disk.free)}</span>
          </div>
          {s.breakdown && (
            <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                ["recordings", "Recordings", "Deleted after each camera's retention"],
                ["previews", "Timeline previews", "Same retention as recordings"],
                ["events", "Motion events", "Same retention as recordings"],
                ["activity", "Motion heatmap", "Same retention as recordings"],
                ["exports", "Saved clips", "Kept until they expire or you delete them"],
              ].map(([k, label, hint]) => (
                <div key={k} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2" title={hint}>
                  <div className="text-[11px] text-slate-500">{label}</div>
                  <div className="text-sm font-semibold tabular-nums text-white">{fmtBytes(s.breakdown?.[k] ?? 0)}</div>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Write rate" value={`${fmtBytes(s.rate_bph * 24)}/day`} />
            <Stat label="Capacity" value={s.capacity_days ? `${s.capacity_days.toFixed(1)} days` : "—"} sub="at current rate" />
            <Stat label="Disk" value={fmtBytes(s.disk.total)} />
            <Stat label="Recordings" value={status.cameras.reduce((n, c) => n + c.storage.count, 0).toLocaleString()} sub="1-minute files" />
          </div>
          {s.orphans && s.orphans.length > 0 && (
            <div className="mt-4 rounded-xl border border-white/5 bg-white/[0.02] p-3 text-xs text-slate-400">
              Footage from removed cameras ({s.orphans.map((o) => `${o.id}: ${fmtBytes(o.bytes)}`).join(", ")}) is kept until it ages out.
            </div>
          )}
        </Card>

        <Card className="p-5">
          <SectionTitle>
            <span className="flex items-center gap-2"><Clock3 className="size-4" /> Clock & services</span>
          </SectionTitle>
          <ul className="space-y-3 text-sm">
            <Row ok={clockOk} warn={clock.synced && !clockOk} label="Time" detail={clock.synced ? (clockOk ? `In sync with ${clock.server}` : `Host clock off by ${(clock.offset_ms / 1000).toFixed(1)} s — Sentinel corrects timestamps automatically`) : clock.error || "Waiting for an NTP server"} />
            <Row ok={status.live} label="Live view" icon={Radio} detail={status.live ? "Running" : "Restarting…"} />
            <Row ok={status.mqtt.connected} warn={!status.mqtt.connected} label="Home Assistant (MQTT)" icon={Wifi} detail={status.mqtt.connected ? "Connected — sensors & snapshots published" : status.mqtt.error || "Connecting…"} />
            {status.detection && (
              <Row
                ok={status.detection.enabled && !status.detection.error}
                warn={!!status.detection.error}
                label="People & animals"
                detail={
                  !status.detection.enabled
                    ? "Object detection isn't available"
                    : `${status.detection.backlog > 0 ? `Checking older events (${status.detection.backlog} left) · ` : "Up to date · "}${status.detection.scanned} checked since start${status.detection.avg_ms ? `, ${(status.detection.avg_ms / 1000).toFixed(1)} s each` : ""}${status.detection.error ? ` · last problem: ${status.detection.error}` : ""}`
                }
              />
            )}
            <Row ok={status.health} label="Watchdog" detail={status.health ? "All recorder loops healthy" : "A recorder loop is stuck — Supervisor will restart Sentinel"} />
          </ul>
        </Card>
      </div>

      <SectionTitle sub="Reconnects, stalls, clock corrections and cleanups">Activity log</SectionTitle>
      <Card className="divide-y divide-white/5">
        {incidents.length === 0 && <div className="p-6 text-center text-sm text-slate-500">Nothing to report</div>}
        {incidents.slice(0, 120).map((i, n) => {
          const I = i.level === "error" ? XCircle : i.level === "warn" ? AlertTriangle : Info;
          const color = i.level === "error" ? "text-rose-400" : i.level === "warn" ? "text-amber-300" : "text-slate-500";
          const name = status.cameras.find((c) => c.id === i.camera)?.name ?? i.camera;
          return (
            <div key={`${i.t}-${n}`} className="flex items-start gap-3 px-4 py-3 text-sm">
              <I className={clsx("mt-0.5 size-4 shrink-0", color)} />
              <div className="min-w-0 flex-1">
                {name && <span className="mr-2 font-medium text-white">{name}</span>}
                <span className="text-slate-300">{i.message}</span>
              </div>
              <span className="shrink-0 text-xs tabular-nums text-slate-500" title={new Date(i.t).toLocaleString()}>
                {fmtDay(i.t)} {fmtTimeSec(i.t)}
              </span>
            </div>
          );
        })}
      </Card>

      <AboutCard version={status.version} />
    </>
  );
}

function Row({ ok, warn, label, detail, icon: Icon }: { ok: boolean; warn?: boolean; label: string; detail: string; icon?: typeof Info }) {
  const I = Icon ?? (ok ? CheckCircle2 : warn ? AlertTriangle : XCircle);
  return (
    <li className="flex items-start gap-3">
      <I className={clsx("mt-0.5 size-4 shrink-0", ok ? "text-emerald-400" : warn ? "text-amber-300" : "text-rose-400")} />
      <div>
        <div className="font-medium text-white">{label}</div>
        <div className="text-xs text-slate-400">{detail}</div>
      </div>
    </li>
  );
}
