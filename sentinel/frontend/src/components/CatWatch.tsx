import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Cat, CheckCircle2, Loader2, MessageCircle, Send, Speaker, Volume2, XCircle } from "lucide-react";
import { Button, Card, Field, SectionTitle, Toggle, inputCls } from "./ui";
import { useToast } from "../lib/toast";
import { api, type AlexaDevice, type Camera, type CatVisit, type CatWatchSettings, type Settings, type WhatsAppInfo } from "../lib/api";
import { fmtDay, fmtTimeSec } from "../lib/format";

type SetFn = <K extends keyof Settings>(k: K, v: Settings[K]) => void;

const DEFAULTS: CatWatchSettings = {
  enabled: false,
  cameras: [],
  min_seconds: 5,
  repeat_seconds: 10,
  hours: "",
  better_detection: true,
  alexa: true,
  alexa_entity: "",
  alexa_volume: 70,
  alexa_message: "There's a cat outside",
  whatsapp: true,
  whatsapp_to: "",
  whatsapp_name: "",
  slow_after_minutes: 5,
  slow_seconds: 60,
};

const secs = (v: number) => (v < 60 ? `${v} s` : v % 60 ? `${Math.floor(v / 60)} min ${v % 60} s` : `${v / 60} min`);
const stay = (ms: number) => secs(Math.max(0, Math.round(ms / 1000)));

export function CatWatchCard({ draft, set, cameras }: { draft: Settings; set: SetFn; cameras: Camera[] }) {
  const toast = useToast();
  const c = { ...DEFAULTS, ...draft.cat_watch };
  const setC = (patch: Partial<CatWatchSettings>) => set("cat_watch", { ...c, ...patch });
  const [echos, setEchos] = useState<AlexaDevice[] | null>(null);
  const [wa, setWa] = useState<WhatsAppInfo | null>(null);
  const [visits, setVisits] = useState<CatVisit[]>([]);
  const [checking, setChecking] = useState<string[]>([]);
  const [testing, setTesting] = useState<"" | "alexa" | "whatsapp">("");

  const load = useCallback(
    () =>
      api
        .catWatch()
        .then((r) => {
          setVisits(r.visits);
          setChecking(r.checking);
        })
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    api.alexaDevices().then(setEchos).catch(() => setEchos([]));
    api.whatsapp().then(setWa).catch(() => {});
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [load]);

  const test = async (what: "alexa" | "whatsapp") => {
    setTesting(what);
    try {
      await api.testCatWatch(what);
      toast(what === "alexa" ? "Alexa should be speaking now" : "Test picture sent to WhatsApp");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setTesting("");
      load();
    }
  };

  const [from, to] = c.hours ? c.hours.split("-") : ["", ""];
  const chats = wa?.chats;
  // Where pictures go when no chat is chosen: the night alerts' chat for cats.
  const fallback = draft.whatsapp.animals_to || draft.whatsapp.to;
  const fallbackName = draft.whatsapp.animals_to ? draft.whatsapp.animals_to_name : draft.whatsapp.to_name;
  const options = chats ? [{ id: chats.recipient, name: `${chats.recipient} (direct message)` }, ...chats.groups.map((g) => ({ id: g.id, name: `${g.name} (group)` }))] : [];
  if (c.whatsapp_to && !options.some((o) => o.id === c.whatsapp_to)) options.unshift({ id: c.whatsapp_to, name: c.whatsapp_name || c.whatsapp_to });
  const watchedNames = cameras.filter((x) => c.cameras.includes(x.id)).map((x) => x.name);
  const ongoing = visits.find((v) => v.ongoing && v.alerted);

  return (
    <Card className="p-5">
      <SectionTitle sub="When a cat stays on a camera where it shouldn't be (shut outside the door), Alexa says so and WhatsApp pictures follow until it has gone.">
        <span className="flex items-center gap-2"><Cat className="size-4" /> Cat watch</span>
      </SectionTitle>
      <div className="space-y-5">
        <Toggle
          checked={c.enabled}
          onChange={(v) => setC({ enabled: v })}
          label="Watch for cats"
          hint={
            !c.enabled
              ? "Off"
              : ongoing
                ? `A cat is on ${ongoing.camera_name} now (${stay(ongoing.to - ongoing.from)})`
                : checking.length
                  ? `Looking for a cat on ${cameras.filter((x) => checking.includes(x.id)).map((x) => x.name).join(", ")} now`
                  : `Watching ${watchedNames.join(", ") || "no camera"}${c.hours ? `, ${from}–${to}` : ", all day"}`
          }
        />

        <div className={clsx("space-y-5 transition", !c.enabled && "pointer-events-none opacity-40")}>
          <div>
            <div className="mb-1.5 text-xs font-medium text-slate-400">Cameras</div>
            <div className="flex flex-wrap gap-2">
              {cameras.map((cam) => {
                const on = c.cameras.includes(cam.id);
                return (
                  <button
                    type="button"
                    key={cam.id}
                    onClick={() => setC({ cameras: on ? c.cameras.filter((x) => x !== cam.id) : [...c.cameras, cam.id] })}
                    className={clsx("rounded-full border px-3 py-1.5 text-xs font-medium transition", on ? "border-violet-400/40 bg-violet-500/15 text-violet-100" : "border-white/10 text-slate-400 hover:text-white")}
                  >
                    {cam.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 rounded-xl border border-white/5 bg-white/[0.02] p-4 sm:grid-cols-2">
            <Field label="Alert when a cat stays for" hint={c.min_seconds ? "Cats only walking past don't count." : "Any cat seen alerts at once, even one walking past."}>
              <div className="flex h-10 items-center gap-3">
                <input type="range" min={0} max={60} value={c.min_seconds} onChange={(e) => setC({ min_seconds: Number(e.target.value) })} className="flex-1" />
                <span className="w-14 text-right text-sm tabular-nums text-white">{c.min_seconds ? `${c.min_seconds} s` : "at once"}</span>
              </div>
            </Field>
            <Field label="While it's still there, repeat every" hint="Alexa speaks and a WhatsApp picture is sent each time.">
              <select value={c.repeat_seconds} onChange={(e) => setC({ repeat_seconds: Number(e.target.value) })} className={inputCls}>
                {[...new Set([10, 15, 20, 30, 60, 120, 300, c.repeat_seconds])].sort((a, b) => a - b).map((v) => (
                  <option key={v} value={v}>
                    {secs(v)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Toggle
                checked={!c.hours}
                onChange={(v) => setC({ hours: v ? "" : "18:00-08:00" })}
                label="All day"
                hint={c.hours ? "Only between the hours below" : "Any time of day or night"}
              />
              {c.hours && (
                <div className="mt-2 flex flex-wrap items-end gap-3">
                  <Field label="From">
                    <input type="time" value={from} onChange={(e) => setC({ hours: `${e.target.value || "00:00"}-${to}` })} className={clsx(inputCls, "w-32 [color-scheme:dark]")} />
                  </Field>
                  <Field label="Until">
                    <input type="time" value={to} onChange={(e) => setC({ hours: `${from}-${e.target.value || "00:00"}` })} className={clsx(inputCls, "w-32 [color-scheme:dark]")} />
                  </Field>
                </div>
              )}
            </div>
            <div className="sm:col-span-2">
              <Toggle
                checked={c.better_detection}
                onChange={(v) => setC({ better_detection: v })}
                label="Look harder for cats on these cameras"
                hint="Zoomed-in looks at every part of the picture, so small, distant and sitting cats are found. Also used for these cameras' event labels. Uses a little more CPU."
              />
            </div>
          </div>

          {/* Alexa */}
          <div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.03] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-semibold text-white">
                <Speaker className="size-4 text-cyan-300" /> Alexa
              </span>
              <span className="text-xs text-slate-500">via Alexa Media Player in Home Assistant</span>
            </div>
            <Toggle checked={c.alexa} onChange={(v) => setC({ alexa: v })} label="Make Alexa say it" hint="The volume goes up while the cat is there, and back to what it was once it has gone." />
            {c.alexa && (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Echo">
                  {echos === null ? (
                    <Loader2 className="size-4 animate-spin text-slate-500" />
                  ) : (
                    <select value={c.alexa_entity} onChange={(e) => setC({ alexa_entity: e.target.value })} className={inputCls}>
                      <option value="">Choose an Echo…</option>
                      {[...(c.alexa_entity && !echos.some((d) => d.id === c.alexa_entity) ? [{ id: c.alexa_entity, name: c.alexa_entity }] : []), ...echos].map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="Volume while the cat is there">
                  <div className="flex h-10 items-center gap-3">
                    <Volume2 className="size-4 text-slate-500" />
                    <input type="range" min={10} max={100} step={5} value={c.alexa_volume} onChange={(e) => setC({ alexa_volume: Number(e.target.value) })} className="flex-1" />
                    <span className="w-12 text-right text-sm tabular-nums text-white">{c.alexa_volume}%</span>
                  </div>
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Alexa says">
                    <input className={inputCls} value={c.alexa_message} maxLength={300} onChange={(e) => setC({ alexa_message: e.target.value })} placeholder="There's a cat outside" />
                  </Field>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                  <Button size="sm" type="button" onClick={() => test("alexa")} disabled={!!testing || !c.alexa_entity}>
                    {testing === "alexa" ? <Loader2 className="size-3.5 animate-spin" /> : <Speaker className="size-3.5" />} Test Alexa
                  </Button>
                  <span className="text-xs text-slate-500">Save settings first. Alexa won't speak with Do Not Disturb on.</span>
                </div>
              </div>
            )}
          </div>

          {/* WhatsApp */}
          <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.03] p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
              <MessageCircle className="size-4 text-emerald-300" /> WhatsApp
            </div>
            <Toggle checked={c.whatsapp} onChange={(v) => setC({ whatsapp: v })} label="Send pictures" hint="A picture of the cat each time, and a message when it has gone." />
            {c.whatsapp && (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Send to" hint={!c.whatsapp_to && fallback ? `Now: ${fallbackName || fallback}` : undefined}>
                  <select
                    value={c.whatsapp_to}
                    onChange={(e) => setC({ whatsapp_to: e.target.value, whatsapp_name: options.find((o) => o.id === e.target.value)?.name.replace(/ \((direct message|group)\)$/, "") ?? "" })}
                    className={inputCls}
                  >
                    <option value="">Same as night alerts about cats</option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Safety cap" hint="Lots of messages in a row can get a WhatsApp number banned. Alexa keeps its pace.">
                  <select
                    value={c.slow_after_minutes ? `${c.slow_after_minutes}/${c.slow_seconds}` : "0"}
                    onChange={(e) => {
                      const [m, s] = e.target.value.split("/").map(Number);
                      setC({ slow_after_minutes: m, slow_seconds: s || c.slow_seconds });
                    }}
                    className={inputCls}
                  >
                    {[...new Set(["2/60", "5/60", "5/120", "10/60", "10/300", `${c.slow_after_minutes}/${c.slow_seconds}`])]
                      .filter((v) => !v.startsWith("0/"))
                      .map((v) => {
                        const [m, s] = v.split("/").map(Number);
                        return (
                          <option key={v} value={v}>
                            After {m} min, one picture every {secs(s)}
                          </option>
                        );
                      })}
                    <option value="0">No cap: every {secs(c.repeat_seconds)}</option>
                  </select>
                </Field>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                  <Button size="sm" type="button" onClick={() => test("whatsapp")} disabled={!!testing || c.cameras.length === 0}>
                    {testing === "whatsapp" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Send a test picture
                  </Button>
                  <span className="text-xs text-slate-500">Save settings first.</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {visits.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-medium text-slate-400">Recent cats</div>
            <div className="divide-y divide-white/5 rounded-xl border border-white/5">
              {visits.slice(0, 10).map((v) => (
                <div key={v.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                  {v.ongoing ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-amber-300" />
                  ) : v.error ? (
                    <XCircle className="size-4 shrink-0 text-rose-400" />
                  ) : v.alerted || v.test ? (
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                  ) : (
                    <Cat className="size-4 shrink-0 text-slate-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-white">{v.camera_name}</span>
                    {v.test && <span className="ml-1.5 rounded bg-white/10 px-1 text-[10px] text-slate-300">TEST</span>}
                    {v.replay && <span className="ml-1.5 rounded bg-amber-400/15 px-1 text-[10px] text-amber-200">REPLAY</span>}
                    <span className="ml-2 text-slate-400">
                      {v.test
                        ? ""
                        : v.alerted
                          ? `${v.ongoing ? "here for" : "stayed"} ${stay(v.to - v.from)} · Alexa ${v.alexa}× · ${v.pictures} picture${v.pictures === 1 ? "" : "s"}`
                          : `passed by (${stay(v.to - v.from)}), no alert`}
                    </span>
                    {v.error && <div className="truncate text-rose-300" title={v.error}>{v.error}</div>}
                  </div>
                  <span className="shrink-0 tabular-nums text-slate-500" title={new Date(v.from).toLocaleString()}>
                    {fmtDay(v.from)} {fmtTimeSec(v.from)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
