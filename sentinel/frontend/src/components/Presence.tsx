import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { Bell, DoorOpen, Home, Loader2, LogIn, LogOut, Save, Settings2, Shirt, UserRound } from "lucide-react";
import { Button, Card, Empty, Toggle } from "./ui";
import { useStatus } from "../lib/status";
import { useToast } from "../lib/toast";
import { api, faceURL, type PersonInfo, type PresenceEntry, type PresenceNow, type PresenceSettings } from "../lib/api";
import { DAY, fmtDay, fmtDuration, fmtTime, startOfDay } from "../lib/format";

// Comings and goings: when the people named came home and went out, and who is home now.
// Everything about how it's worked out can be changed under Customize.

const RANGES: [string, number][] = [["Today", 0], ["3 days", 3], ["7 days", 7], ["30 days", 30]];
const AWAY = [15, 30, 45, 60, 90, 120, 180, 240];

const defaults: PresenceSettings = {
  enabled: false, entrances: [], away_minutes: 45, arrive_on: "any", people: [], clothing: true,
  notify: true, notify_arrive: true, notify_leave: true, notify_people: [], quiet: "", home_assistant: true,
};

export function ComingsAndGoings({ people }: { people: PersonInfo[] }) {
  const toast = useToast();
  const nav = useNavigate();
  const { status } = useStatus();
  const [days, setDays] = useState(3);
  const [who, setWho] = useState<string | null>(null);
  const [data, setData] = useState<{ enabled: boolean; entries: PresenceEntry[]; now: PresenceNow[] } | null>(null);
  const [custom, setCustom] = useState(false);

  const load = useCallback(async () => {
    const to = Date.now();
    const from = days === 0 ? startOfDay(to) : to - days * DAY;
    try {
      setData(await api.presence(from, to));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [days, toast]);
  useEffect(() => {
    load();
    const t = window.setInterval(() => !document.hidden && load(), 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  const cover = (id: string) => people.find((p) => p.id === id)?.cover;
  const camName = (id: string) => status?.cameras.find((c) => c.id === id)?.name ?? id;
  const entries = (data?.entries ?? []).filter((e) => !who || e.person === who);
  const byDay = useMemo(() => {
    const m = new Map<number, PresenceEntry[]>();
    for (const e of entries) {
      const d = startOfDay(e.t);
      m.set(d, [...(m.get(d) ?? []), e]);
    }
    return [...m.entries()];
  }, [entries]);

  if (!data) return <div className="skeleton h-64 rounded-2xl" />;

  return (
    <div className="flex flex-col gap-5">
      {/* Who is home now */}
      {data.enabled && data.now.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.now.map((n) => (
            <button
              key={n.person}
              onClick={() => setWho(who === n.person ? null : n.person)}
              className={clsx(
                "glass flex items-center gap-2.5 rounded-2xl py-1.5 pl-1.5 pr-3.5 text-left transition",
                who === n.person ? "ring-2 ring-violet-400/60" : "hover:bg-white/[0.06]",
              )}
            >
              <Avatar id={cover(n.person)} />
              <span>
                <span className="block text-sm font-medium text-white">{n.name}</span>
                <span className="flex items-center gap-1.5 text-[11px]">
                  <span className={clsx("size-1.5 rounded-full", n.state === "home" ? "bg-emerald-400" : n.state === "away" ? "bg-amber-400" : "bg-slate-500")} />
                  <span className={n.state === "home" ? "text-emerald-300" : n.state === "away" ? "text-amber-200" : "text-slate-500"}>
                    {n.state === "home" ? "Home" : n.state === "away" ? "Out" : "Not seen lately"}
                    {n.since ? ` since ${fmtDay(n.since) === "Today" ? "" : fmtDay(n.since) + " "}${fmtTime(n.since)}` : ""}
                  </span>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="glass flex rounded-xl p-1">
          {RANGES.map(([l, d]) => (
            <button key={l} onClick={() => setDays(d)} className={clsx("rounded-lg px-3 py-1.5 text-sm font-medium transition", days === d ? "bg-white/10 text-white" : "text-slate-400 hover:text-white")}>
              {l}
            </button>
          ))}
        </div>
        {who && (
          <button onClick={() => setWho(null)} className="rounded-lg bg-violet-500/15 px-3 py-1.5 text-xs text-violet-100">
            Only {data.now.find((n) => n.person === who)?.name} · show everyone
          </button>
        )}
        <Button className="ml-auto" onClick={() => setCustom((c) => !c)}>
          <Settings2 className="size-4" /> Customize
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {(custom || !data.enabled) && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <PresenceSettingsCard
              people={people}
              onSaved={() => {
                setCustom(false);
                load();
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {data.enabled &&
        (byDay.length === 0 ? (
          <Empty icon={<DoorOpen className="size-6" />} title="No comings or goings yet" sub="They appear here as the people you named are seen leaving through, and coming back past, the entrance cameras." />
        ) : (
          byDay.map(([day, list]) => (
            <section key={day}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">{fmtDay(day)}</h3>
              <Card className="divide-y divide-white/5 p-0">
                {list.map((e) => {
                  const inn = e.kind === "arrived";
                  return (
                    <button
                      key={`${e.person}-${e.kind}-${e.t}`}
                      onClick={() => nav(`/camera/${e.cam}?t=${e.t - 5000}&ev=${encodeURIComponent(e.event)}`)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.03]"
                    >
                      <span className={clsx("flex size-9 shrink-0 items-center justify-center rounded-xl", inn ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-200")}>
                        {inn ? <LogIn className="size-4" /> : <LogOut className="size-4" />}
                      </span>
                      <Avatar id={cover(e.person)} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-white">
                          <b className="font-semibold">{e.name}</b> {inn ? "came home" : "went out"}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                          {inn ? "Seen" : "Last seen"} on {camName(e.cam)}
                          {inn && e.for ? <span>· out for {fmtDuration(e.for)}</span> : null}
                          {e.by === "clothing" && (
                            <span className="flex items-center gap-1 text-slate-500" title="Recognised by clothing (face not seen)">
                              <Shirt className="size-3" /> by clothes
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm tabular-nums text-slate-300">{fmtTime(e.t)}</span>
                    </button>
                  );
                })}
              </Card>
            </section>
          ))
        ))}
    </div>
  );
}

function Avatar({ id }: { id?: string }) {
  return id ? (
    <img src={faceURL(id)} className="size-9 shrink-0 rounded-xl object-cover" loading="lazy" />
  ) : (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/5 text-slate-500">
      <UserRound className="size-4" />
    </span>
  );
}

function Chips({ items, value, onChange, all }: { items: { id: string; name: string }[]; value: string[]; onChange: (v: string[]) => void; all?: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {all && (
        <button
          onClick={() => onChange([])}
          className={clsx("rounded-full border px-3 py-1 text-xs font-medium transition", value.length === 0 ? "border-violet-400/40 bg-violet-500/15 text-violet-100" : "border-white/5 text-slate-400 hover:text-white")}
        >
          {all}
        </button>
      )}
      {items.map((it) => {
        const on = value.includes(it.id);
        return (
          <button
            key={it.id}
            onClick={() => onChange(on ? value.filter((x) => x !== it.id) : [...value, it.id])}
            className={clsx("rounded-full border px-3 py-1 text-xs font-medium transition", on ? "border-violet-400/40 bg-violet-500/15 text-violet-100" : "border-white/5 text-slate-400 hover:text-white")}
          >
            {it.name}
          </button>
        );
      })}
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 py-3 md:grid-cols-[240px_1fr] md:gap-6">
      <div>
        <div className="text-sm font-medium text-slate-200">{title}</div>
        {hint && <div className="text-xs text-slate-500">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function PresenceSettingsCard({ people, onSaved }: { people: PersonInfo[]; onSaved: () => void }) {
  const toast = useToast();
  const { status } = useStatus();
  const [p, setP] = useState<PresenceSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.settings().then((s) => setP({ ...defaults, ...s.presence })).catch((e) => toast((e as Error).message, "error"));
  }, [toast]);
  if (!p) return <div className="skeleton h-40 rounded-2xl" />;

  const set = (patch: Partial<PresenceSettings>) => setP({ ...p, ...patch });
  const cams = (status?.cameras ?? []).filter((c) => c.enabled).map((c) => ({ id: c.id, name: c.name + (c.motion ? "" : " (no detection)") }));
  const named = people.map((x) => ({ id: x.id, name: x.name }));
  const [qFrom, qTo] = p.quiet ? p.quiet.split("-") : ["", ""];

  const save = async () => {
    if (p.enabled && p.entrances.length === 0) return toast("Choose at least one entrance camera", "error");
    setSaving(true);
    try {
      const s = await api.settings();
      await api.saveSettings({ ...s, presence: p });
      toast(p.enabled ? "Comings and goings saved" : "Comings and goings turned off", "success");
      onSaved();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div>
          <h3 className="font-semibold text-white">Comings and goings</h3>
          <p className="text-xs text-slate-500">A log of when the people you named come home and go out, worked out from where Sentinel sees them.</p>
        </div>
        <Toggle checked={p.enabled} onChange={(v) => set({ enabled: v })} />
      </div>
      <div className="divide-y divide-white/5">
        <Row title="Entrance cameras" hint="The cameras at your way in and out. Someone last seen here, then nowhere for a while, has gone out.">
          <Chips items={cams} value={p.entrances} onChange={(v) => set({ entrances: v })} />
        </Row>
        <Row title="Gone out after" hint="How long someone last seen at an entrance must go unseen to count as out.">
          <div className="flex flex-wrap gap-1.5">
            {AWAY.map((m) => (
              <button
                key={m}
                onClick={() => set({ away_minutes: m })}
                className={clsx("rounded-lg px-3 py-1.5 text-xs font-medium tabular-nums transition", p.away_minutes === m ? "bg-violet-500 text-white" : "bg-white/5 text-slate-400 hover:text-white")}
              >
                {m < 60 ? `${m} min` : `${m / 60} h`}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Back home when seen" hint="After being out, which sighting counts as coming home.">
          <div className="glass inline-flex rounded-xl p-1">
            {(
              [
                ["any", "On any camera"],
                ["entrance", "At an entrance"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} onClick={() => set({ arrive_on: k })} className={clsx("rounded-lg px-3 py-1.5 text-xs font-medium transition", p.arrive_on === k ? "bg-white/10 text-white" : "text-slate-400 hover:text-white")}>
                {l}
              </button>
            ))}
          </div>
        </Row>
        <Row title="People" hint="Who is logged.">
          <Chips items={named} value={p.people} onChange={(v) => set({ people: v })} all="Everyone named" />
        </Row>
        <Row title="Recognised by clothes" hint="Also count sightings where the face wasn't seen but the clothes matched the same day.">
          <Toggle checked={p.clothing} onChange={(v) => set({ clothing: v })} />
        </Row>
        <Row title="Phone notifications" hint="On the phones with the Sentinel app (each phone can also turn them off).">
          <div className="flex flex-col gap-1">
            <Toggle checked={p.notify} onChange={(v) => set({ notify: v })} label={<span className="flex items-center gap-2"><Bell className="size-3.5" /> Notify</span>} />
            {p.notify && (
              <div className="mt-1 flex flex-col gap-3 border-l border-white/10 pl-4">
                <Toggle checked={p.notify_arrive} onChange={(v) => set({ notify_arrive: v })} label="When someone comes home" />
                <Toggle checked={p.notify_leave} onChange={(v) => set({ notify_leave: v })} label="When someone goes out" />
                <div>
                  <div className="mb-1.5 text-xs text-slate-400">About</div>
                  <Chips items={named.filter((x) => p.people.length === 0 || p.people.includes(x.id))} value={p.notify_people} onChange={(v) => set({ notify_people: v })} all="Everyone logged" />
                </div>
                <div>
                  <Toggle checked={!!p.quiet} onChange={(v) => set({ quiet: v ? "23:00-06:00" : "" })} label="Quiet hours" hint="No notifications then; the log still records." />
                  {p.quiet && (
                    <div className="mt-2 flex items-center gap-2 text-sm text-slate-400">
                      <input type="time" value={qFrom} onChange={(e) => set({ quiet: `${e.target.value}-${qTo}` })} className="h-9 rounded-lg border border-white/10 bg-ink-900/80 px-2 text-white" />
                      to
                      <input type="time" value={qTo} onChange={(e) => set({ quiet: `${qFrom}-${e.target.value}` })} className="h-9 rounded-lg border border-white/10 bg-ink-900/80 px-2 text-white" />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Row>
        <Row title="Home Assistant" hint="A home/away tracker per person (device_tracker.sentinel_person_…), for automations like “when everyone has gone out”.">
          <Toggle checked={p.home_assistant} onChange={(v) => set({ home_assistant: v })} label={<span className="flex items-center gap-2"><Home className="size-3.5" /> Home/away trackers</span>} />
        </Row>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
        </Button>
      </div>
    </Card>
  );
}
