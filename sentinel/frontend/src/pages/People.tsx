import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { ArrowLeft, Check, CheckCheck, ChevronDown, Eye, EyeOff, Expand, HelpCircle, Loader2, Pencil, ScanFace, Sparkles, Trash2, UserRound, UserX, Users, X } from "lucide-react";
import { Button, Empty, PageHeader } from "../components/ui";
import { FaceViewer, type ViewerAction } from "../components/FaceViewer";
import { NamePicker, type Pick } from "../components/NamePicker";
import { useStatus } from "../lib/status";
import { useToast } from "../lib/toast";
import { api, faceURL, type FaceGroup, type FaceInfo, type FaceStatus, type PersonInfo, type SentinelEvent } from "../lib/api";
import { fmtDay, fmtTime } from "../lib/format";
import { EventPicture, LabelChips } from "../lib/labels";
import { openEvent } from "../lib/eventNav";

// People: who Sentinel recognises, and faces it has seen but can't put a name to yet.
// Tap a face to see it in full quality (and name it there); tick faces to act on several.

type Data = { people: PersonInfo[]; status: FaceStatus; groups: FaceGroup[] };

function usePeopleData() {
  const toast = useToast();
  const [data, setData] = useState<Data | null>(null);
  const load = useCallback(async () => {
    try {
      const [p, groups] = await Promise.all([api.people(), api.unknownFaces()]);
      setData({ people: p.people, status: p.status, groups });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);
  useEffect(() => {
    load();
    const t = window.setInterval(() => !document.hidden && load(), 30_000);
    return () => window.clearInterval(t);
  }, [load]);
  return { data, load, setData };
}

// Name faces, with a message; returns whether it worked.
function useFaceActions(reload: () => void) {
  const toast = useToast();
  const run = async (fn: () => Promise<unknown>, msg: string, undo?: string[]) => {
    try {
      await fn();
      toast(
        msg,
        "success",
        undo && {
          label: "Undo",
          onClick: () =>
            api
              .restoreFaces(undo)
              .then(() => (toast("Undone", "info"), reload()))
              .catch((e) => toast((e as Error).message, "error")),
        },
      );
      reload();
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    }
  };
  const plural = (n: number) => `${n} face${n === 1 ? "" : "s"}`;
  return {
    name: (ids: string[], p: Pick) => run(() => api.nameFaces(ids, p.person ? { person: p.person } : { name: p.name }), `${plural(ids.length)} named ${p.label}. Sentinel will recognise them from now on.`, ids),
    junk: (ids: string[]) => run(() => api.notFaces(ids), `${plural(ids.length)} ignored. Similar ones won't show up again.`, ids),
    hide: (ids: string[]) => run(() => api.hideFaces(ids), `${plural(ids.length)} hidden. Faces like them won't be asked about; their events stay “Person”.`, ids),
    stranger: (ids: string[]) => run(() => api.strangerFaces(ids), `Kept as an unknown person. Sentinel will tell you when they come back.`, ids),
    not: (ids: string[], person: PersonInfo | { id: string; name: string }) => run(() => api.notPerson(ids, person.id), `Taken out of ${person.name}. Sentinel learns from it.`),
  };
}

export function PeoplePage() {
  const { id } = useParams();
  return id ? <PersonPage id={id} /> : <PeopleList />;
}

function PeopleList() {
  const { data, load } = usePeopleData();
  const [params, setParams] = useSearchParams();
  const groups = data?.groups ?? [];
  const toName = groups.reduce((n, g) => n + g.size, 0);
  const tab = params.get("tab") ?? (data && data.people.length > 0 && toName === 0 ? "known" : "name");
  const status = data?.status;

  return (
    <>
      <PageHeader
        title="People"
        sub="Sentinel recognises the people you name: by face on any camera, and on the same day by their clothes when a camera only sees them from above. Everything stays on this Pi."
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="glass flex rounded-xl p-1">
          {(
            [
              ["name", "To name", toName, ScanFace],
              ["known", "Known people", data?.people.length ?? 0, Users],
            ] as const
          ).map(([k, label, n, Icon]) => (
            <button
              key={k}
              onClick={() => setParams(k === "name" ? {} : { tab: k }, { replace: true })}
              className={clsx("flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition", tab === k ? "bg-white/10 text-white" : "text-slate-400 hover:text-white")}
            >
              <Icon className="size-4" /> {label}
              <span className={clsx("rounded-full px-1.5 text-xs tabular-nums", tab === k ? "bg-violet-500 text-white" : "bg-white/10 text-slate-400")}>{data ? n : "…"}</span>
            </button>
          ))}
        </div>
        {status && !status.enabled && (
          <span className="rounded-lg bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200">
            {status.error ? `Face recognition isn't working: ${status.error}` : "Face recognition is off (Settings → Alerts)"}
          </span>
        )}
        {status?.enabled && status.backlog > 0 && (
          <span className="flex items-center gap-2 text-xs text-slate-400">
            <Loader2 className="size-3.5 animate-spin" /> Looking for faces in {status.backlog} earlier event{status.backlog === 1 ? "" : "s"}…
          </span>
        )}
      </div>
      {!data ? (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6 xl:grid-cols-10">
          {Array.from({ length: 20 }, (_, i) => (
            <div key={i} className="skeleton aspect-square rounded-2xl" />
          ))}
        </div>
      ) : tab === "known" ? (
        <Known people={data.people} onName={() => setParams({}, { replace: true })} />
      ) : (
        <ToName data={data} reload={load} />
      )}
    </>
  );
}

// ---- To name ----

function ToName({ data, reload }: { data: Data; reload: () => void }) {
  const acts = useFaceActions(reload);
  const groups = data.groups.filter((g) => g.size > 1);
  const maybe = data.groups.filter((g) => g.size === 1 && g.suggest);
  const once = data.groups.filter((g) => g.size === 1 && !g.suggest).flatMap((g) => g.faces);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<{ faces: FaceInfo[]; index: number; group?: FaceGroup } | null>(null);
  const [out, setOut] = useState<Set<string>>(new Set()); // faces taken out of their group

  // Faces that got a name vanish from the page on reload; drop them from the selection.
  const all = useMemo(() => new Set(data.groups.flatMap((g) => g.ids)), [data.groups]);
  useEffect(() => setPicked((s) => new Set([...s].filter((id) => all.has(id)))), [all]);

  if (data.groups.length === 0)
    return (
      <Empty
        icon={<CheckCheck className="size-6" />}
        title="Everyone has a name"
        sub={data.status.faces ? "New faces show up here as people walk past the cameras." : "Faces show up here as people walk past the cameras facing them. Cameras looking straight down rarely see one."}
      />
    );

  const toggle = (id: string) => setPicked((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set(s).add(id)));
  const viewerActions = (g?: FaceGroup): ViewerAction[] => [
    ...(() => {
      const f = viewer?.faces[viewer.index];
      const m = f && data.groups.find((x) => x.size === 1 && x.suggest && x.ids[0] === f.id);
      if (!m) return [];
      const s = m.suggest!;
      return [
        { label: `Yes, this is ${s.name}`, icon: <Check className="size-4" />, onClick: (x: FaceInfo) => acts.name([x.id], { person: s.person, label: s.name }).then((ok) => ok && next()) },
        { label: `No, not ${s.name}`, icon: <UserX className="size-4" />, onClick: (x: FaceInfo) => acts.not([x.id], { id: s.person, name: s.name }).then((ok) => ok && next()) },
      ] as ViewerAction[];
    })(),
    ...(g && g.size > 1
      ? [{ label: out.has(viewer?.faces[viewer.index]?.id ?? "") ? "Put back in this group" : "Not the same person as the others", icon: <UserX className="size-4" />, onClick: (f: FaceInfo) => setOut((s) => (s.has(f.id) ? new Set([...s].filter((x) => x !== f.id)) : new Set(s).add(f.id))) }]
      : []),
    { label: "Someone I don't know", icon: <HelpCircle className="size-4" />, onClick: (f) => acts.stranger([f.id]).then((ok) => ok && next()) },
    { label: "Don't name (hide)", icon: <EyeOff className="size-4" />, onClick: (f) => acts.hide([f.id]).then((ok) => ok && next()) },
    { label: "Not a face", icon: <X className="size-4" />, tone: "danger", onClick: (f) => acts.junk([f.id]).then((ok) => ok && next()) },
  ];
  const next = () => setViewer((v) => (v && v.faces.length > 1 ? { ...v, faces: v.faces.filter((_, i) => i !== v.index), index: Math.min(v.index, v.faces.length - 2) } : null));

  return (
    <div className="flex flex-col gap-4 pb-24">
      {groups.map((g) => (
        <GroupCard key={g.ids[0]} g={g} people={data.people} out={out} setOut={setOut} acts={acts} onView={(i) => setViewer({ faces: g.faces, index: i, group: g })} />
      ))}
      {maybe.length > 0 && (
        <section className="glass rounded-2xl p-4 md:p-5">
          <h2 className="text-base font-semibold text-white">Might be someone you know · {maybe.length}</h2>
          <p className="mb-3 text-xs text-slate-400">Each looks like someone you named, but not enough to be sure. Confirm or say no; open a face to see it large.</p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
            {maybe.map((g) => (
              <div key={g.ids[0]} className="overflow-hidden rounded-2xl border border-white/[0.07] bg-ink-850">
                <FaceTile f={g.faces[0]} onOpen={() => setViewer({ faces: maybe.map((m) => m.faces[0]), index: maybe.indexOf(g) })} />
                <div className="p-2">
                  <div className="truncate text-center text-sm font-medium text-white">{g.suggest!.name}?</div>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => acts.name(g.ids, { person: g.suggest!.person, label: g.suggest!.name })}
                      title={`Yes, this is ${g.suggest!.name}`}
                      className="flex h-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300 transition hover:bg-emerald-500/25"
                    >
                      <Check className="size-4" />
                    </button>
                    <button
                      onClick={() => acts.not(g.ids, { id: g.suggest!.person, name: g.suggest!.name })}
                      title={`No, not ${g.suggest!.name}`}
                      className="flex h-8 items-center justify-center rounded-lg bg-white/5 text-slate-300 transition hover:bg-rose-500/15 hover:text-rose-200"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {once.length > 0 && (
        <section className="glass rounded-2xl p-4 md:p-5">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-white">Seen once · {once.length}</h2>
              <p className="text-xs text-slate-400">Tap a face to see it large. Tick the ones of one person (the same person can look different from another angle), then name them together.</p>
            </div>
            {picked.size > 0 && (
              <button onClick={() => setPicked(new Set())} className="text-xs text-slate-400 hover:text-white">
                Clear selection
              </button>
            )}
          </div>
          <FaceGrid faces={once} picked={picked} onToggle={toggle} onOpen={(i) => setViewer({ faces: once, index: i })} />
        </section>
      )}

      <HiddenFaces reload={reload} />

      {/* Selection bar */}
      <AnimatePresence>
        {picked.size > 0 && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            className="fixed inset-x-3 bottom-20 z-40 mx-auto flex max-w-3xl flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-ink-900/95 p-3 shadow-2xl shadow-black/60 backdrop-blur md:bottom-6"
          >
            <div className="flex -space-x-3">
              {[...picked].slice(0, 4).map((id) => (
                <img key={id} src={faceURL(id)} alt="" className="size-9 rounded-full object-cover ring-2 ring-ink-900" />
              ))}
            </div>
            <span className="text-sm font-medium text-white">{picked.size} selected</span>
            <NamePicker className="min-w-56 flex-1" people={data.people} placeholder="Name them…" dropUp onPick={(p) => acts.name([...picked], p).then((ok) => ok && setPicked(new Set()))} />
            <Button size="sm" variant="ghost" title="Someone you don't know: kept as “Unknown person”, recognised when they come back" onClick={() => acts.stranger([...picked]).then((ok) => ok && setPicked(new Set()))}>
              <HelpCircle className="size-3.5" /> Don't know
            </Button>
            <Button size="sm" variant="ghost" title="Don't name them: hidden, with faces like them" onClick={() => acts.hide([...picked]).then((ok) => ok && setPicked(new Set()))}>
              <EyeOff className="size-3.5" /> Hide
            </Button>
            <Button size="sm" variant="ghost" onClick={() => acts.junk([...picked]).then((ok) => ok && setPicked(new Set()))}>
              Not faces
            </Button>
            <button onClick={() => setPicked(new Set())} title="Clear" className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white">
              <X className="size-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {viewer && (
          <FaceViewer
            faces={viewer.faces}
            index={viewer.index}
            onIndex={(i) => setViewer((v) => v && { ...v, index: i })}
            onClose={() => setViewer(null)}
            people={data.people}
            title={viewer.group ? `Likely the same person · ${viewer.group.size} faces` : undefined}
            onName={(f, p) => acts.name([f.id], p).then((ok) => ok && next())}
            actions={viewerActions(viewer.group)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function FaceTile({ f, picked, dim, onToggle, onOpen, size = "md", ring = true }: { f: FaceInfo; picked?: boolean; dim?: boolean; onToggle?: () => void; onOpen: () => void; size?: "md" | "lg"; ring?: boolean }) {
  const { status } = useStatus();
  const cam = status?.cameras.find((c) => c.id === f.cam)?.name ?? f.cam;
  return (
    <div className={clsx("group relative aspect-square overflow-hidden rounded-2xl bg-ink-850 ring-1 transition", picked && ring ? "ring-2 ring-violet-400" : "ring-white/10 hover:ring-white/30", size === "lg" && "rounded-3xl")}>
      <button type="button" onClick={onOpen} title={`${cam}, ${fmtDay(f.t)} ${fmtTime(f.t)}: open`} className="absolute inset-0">
        <img src={faceURL(f.id)} alt="" loading="lazy" className={clsx("h-full w-full object-cover transition duration-300 group-hover:scale-105", dim && "opacity-30 grayscale")} />
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-4 text-left text-[10px] font-medium leading-tight text-white/85 opacity-0 transition group-hover:opacity-100">
          {cam}
          <br />
          {fmtDay(f.t)} {fmtTime(f.t)}
        </span>
        <Expand className="absolute right-2 top-2 size-6 rounded-lg bg-black/50 p-1 text-white opacity-0 transition group-hover:opacity-100" />
      </button>
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          title={picked ? "Unselect" : "Select"}
          className={clsx(
            "absolute left-2 top-2 flex size-6 items-center justify-center rounded-full border-2 transition",
            picked ? "border-violet-400 bg-violet-500 text-white" : "border-white/80 bg-black/30 text-transparent opacity-0 hover:text-white/70 group-hover:opacity-100 max-md:opacity-100",
          )}
        >
          <Check className="size-3.5" strokeWidth={3} />
        </button>
      )}
      {dim && <span className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[10px] font-semibold uppercase tracking-wide text-white">Left out</span>}
    </div>
  );
}

function FaceGrid({ faces, picked, onToggle, onOpen, dim, ring }: { faces: FaceInfo[]; picked?: Set<string>; onToggle?: (id: string) => void; onOpen: (i: number) => void; dim?: Set<string>; ring?: boolean }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(104px,1fr))]">
      {faces.map((f, i) => (
        <FaceTile key={f.id} f={f} picked={picked?.has(f.id)} dim={dim?.has(f.id)} ring={ring} onToggle={onToggle && (() => onToggle(f.id))} onOpen={() => onOpen(i)} />
      ))}
    </div>
  );
}

function GroupCard({
  g,
  people,
  out,
  setOut,
  acts,
  onView,
}: {
  g: FaceGroup;
  people: PersonInfo[];
  out: Set<string>;
  setOut: (fn: (s: Set<string>) => Set<string>) => void;
  acts: ReturnType<typeof useFaceActions>;
  onView: (i: number) => void;
}) {
  const { status } = useStatus();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = g.ids.filter((id) => !out.has(id));
  const shown = all ? g.faces : g.faces.slice(0, 14);
  const cams = g.cams.map((c) => status?.cameras.find((x) => x.id === c)?.name ?? c).join(", ");
  const act = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  const toggleOut = (id: string) => setOut((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set(s).add(id)));

  return (
    <motion.section layout className="glass rounded-2xl p-4 md:p-5">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <img src={faceURL(g.faces[0].id)} alt="" className="size-14 rounded-2xl object-cover ring-1 ring-white/10" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-white">{g.size > 1 ? `Likely the same person · ${g.size} faces` : "One face"}</h2>
          <p className="text-xs text-slate-400">
            {cams} · last seen {fmtDay(g.last)} {fmtTime(g.last)}
            {out.size > 0 && ids.length < g.size && ` · ${g.size - ids.length} left out`}
          </p>
        </div>
      </div>
      <FaceGrid
        faces={shown}
        onOpen={onView}
        dim={out}
        picked={new Set(g.size > 1 ? ids : [])}
        onToggle={g.size > 1 ? toggleOut : undefined}
        ring={false}
      />
      {g.faces.length > shown.length && (
        <button onClick={() => setAll(true)} className="mt-2 flex items-center gap-1 text-xs font-medium text-violet-300 hover:text-violet-200">
          <ChevronDown className="size-3.5" /> Show all {g.faces.length}
        </button>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {g.suggest && (
          <Button variant="primary" size="sm" disabled={busy || ids.length === 0} onClick={() => act(() => acts.name(ids, { person: g.suggest!.person, label: g.suggest!.name }))}>
            <Sparkles className="size-3.5" /> This is {g.suggest.name}
          </Button>
        )}
        <NamePicker className="min-w-56 flex-1" people={people} placeholder={g.suggest ? "Or someone else…" : `Who is this? (${ids.length} face${ids.length === 1 ? "" : "s"})`} disabled={busy || ids.length === 0} onPick={(p) => act(() => acts.name(ids, p))} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="ghost" disabled={busy || ids.length === 0} title="Kept as “Unknown person”: recognised when they come back, and you can name them later" onClick={() => act(() => acts.stranger(ids))}>
          <HelpCircle className="size-3.5" /> Someone I don't know
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || ids.length === 0} title="Hidden, with faces like them; their events stay “Person”" onClick={() => act(() => acts.hide(ids))}>
          <EyeOff className="size-3.5" /> Don't name
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || ids.length === 0} onClick={() => act(() => acts.junk(ids))}>
          <X className="size-3.5" /> Not faces
        </Button>
      </div>
      {g.size > 1 && <p className="mt-2 text-[11px] text-slate-500">Untick a face that isn't the same person (or open it and say so); it stays to be named on its own.</p>}
    </motion.section>
  );
}

// ---- Known people ----

function Known({ people, onName }: { people: PersonInfo[]; onName: () => void }) {
  const named = people.filter((p) => !p.unnamed);
  const strangers = people.filter((p) => p.unnamed);
  if (people.length === 0)
    return (
      <Empty
        icon={<UserRound className="size-6" />}
        title="Nobody named yet"
        sub="Name a face under “To name” and Sentinel starts recognising that person."
        action={<Button onClick={onName}>Name faces</Button>}
      />
    );
  return (
    <div className="flex flex-col gap-8">
      {named.length > 0 && <PeopleGrid people={named} />}
      {strangers.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-slate-400">Unknown people · {strangers.length}</h2>
          <p className="mb-3 text-xs text-slate-500">People you don't know, recognised when they come back. Open one to give them a name if you find out who they are.</p>
          <PeopleGrid people={strangers} />
        </section>
      )}
    </div>
  );
}

function PeopleGrid({ people }: { people: PersonInfo[] }) {
  const { status } = useStatus();
  if (people.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
      {people.map((p, i) => {
        const cam = status?.cameras.find((c) => c.id === p.last?.cam)?.name ?? p.last?.cam;
        return (
          <motion.div key={p.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.03 }}>
            <Link to={`/people/${p.id}`} className="group block overflow-hidden rounded-3xl border border-white/[0.07] bg-ink-850 transition hover:-translate-y-0.5 hover:border-white/20">
              <div className="relative aspect-square">
                {p.cover ? <img src={faceURL(p.cover)} alt="" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" /> : <UserRound className="h-full w-full p-10 text-slate-600" />}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3 pt-10">
                  <div className="truncate text-lg font-semibold text-white">{p.name}</div>
                  <div className="text-xs text-white/70">
                    {p.sightings} event{p.sightings === 1 ? "" : "s"} this week
                  </div>
                </div>
              </div>
              <div className="px-3 py-2.5 text-xs text-slate-400">{p.last ? <>Last seen: {cam}, {fmtDay(p.last.t)} {fmtTime(p.last.t)}</> : "Not seen this week"}</div>
            </Link>
          </motion.div>
        );
      })}
    </div>
  );
}

// ---- One person ----

function PersonPage({ id }: { id: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const { data, load } = usePeopleData();
  const p = data?.people.find((x) => x.id === id);
  const [faces, setFaces] = useState<FaceInfo[] | null>(null);
  const [events, setEvents] = useState<SentinelEvent[] | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const { status } = useStatus();
  const names = Object.fromEntries((status?.cameras ?? []).map((c) => [c.id, c.name]));

  const loadMine = useCallback(() => {
    api.personFaces(id, 300).then(setFaces).catch(() => setFaces([]));
    api.events({ person: id, limit: 60 }).then(setEvents).catch(() => setEvents([]));
  }, [id]);
  useEffect(() => loadMine(), [loadMine]);
  const reload = () => {
    load();
    loadMine();
  };
  const acts = useFaceActions(reload);

  if (data && !p)
    return (
      <Empty icon={<UserRound className="size-6" />} title="Not found" sub="This person was forgotten." action={<Button onClick={() => nav("/people?tab=known")}>Back to People</Button>} />
    );

  const rename = async () => {
    try {
      await api.renamePerson(id, name);
      setEditing(false);
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const forget = async () => {
    if (!p || !confirm(`Forget ${p.name}? Their faces go back to “To name”; nothing else is deleted.`)) return;
    try {
      await api.forgetPerson(id);
      nav("/people?tab=known");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const mine = faces ?? [];
  return (
    <div className="pb-10">
      <Link to="/people?tab=known" className="mb-4 inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white">
        <ArrowLeft className="size-4" /> People
      </Link>
      <div className="mb-8 flex flex-wrap items-center gap-5">
        {p?.cover ? <img src={faceURL(p.cover)} alt="" className="size-28 rounded-3xl object-cover ring-1 ring-white/10" /> : <div className="skeleton size-28 rounded-3xl" />}
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex max-w-md items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                rename();
              }}
            >
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-11 flex-1 rounded-xl border border-white/10 bg-ink-950 px-3 text-xl font-semibold text-white" />
              <Button type="submit" variant="primary">
                Save
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-white md:text-3xl">
              {p?.name ?? "…"}
              <button
                onClick={() => {
                  setName(p?.name ?? "");
                  setEditing(true);
                }}
                title="Rename"
                className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-white"
              >
                <Pencil className="size-4" />
              </button>
            </h1>
          )}
          <p className="mt-1 text-sm text-slate-400">
            {p && (
              <>
                {p.sightings} event{p.sightings === 1 ? "" : "s"} this week · {p.faces} known face{p.faces === 1 ? "" : "s"}
                {p.last && ` · last seen on ${names[p.last.cam] ?? p.last.cam}, ${fmtDay(p.last.t)} ${fmtTime(p.last.t)}`}
              </>
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => nav(`/events?who=${id}`)}>
              All events with {p?.name ?? "them"}
            </Button>
            <Button size="sm" variant="ghost" onClick={forget}>
              <Trash2 className="size-3.5" /> Forget
            </Button>
          </div>
        </div>
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">Recent sightings</h2>
      {!events ? (
        <div className="skeleton mb-8 h-32 rounded-2xl" />
      ) : events.length === 0 ? (
        <p className="mb-8 text-sm text-slate-500">No events with {p?.name} this week.</p>
      ) : (
        <div className="-mx-1 mb-8 flex gap-3 overflow-x-auto px-1 pb-2">
          {events.map((e) => (
            <button
              key={e.id}
              onClick={() => openEvent(nav, e, events, p?.name ?? "People", `person:${id}`)}
              className="w-52 shrink-0 overflow-hidden rounded-2xl border border-white/[0.07] bg-ink-850 text-left transition hover:-translate-y-0.5 hover:border-white/20"
            >
              <div className="relative aspect-video">
                <EventPicture e={e} className="h-full w-full" />
                <span className="absolute bottom-1.5 left-1.5">
                  <LabelChips e={e} size="xs" />
                </span>
              </div>
              <div className="px-3 py-2 text-xs">
                <div className="font-medium text-white">{names[e.camera] ?? e.camera}</div>
                <div className="text-slate-400">
                  {fmtDay(e.start)} · {fmtTime(e.start)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="mb-3 flex items-end justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Faces · {mine.length}</h2>
        <span className="text-xs text-slate-500">Open a face to check it; take out any that isn't {p?.name ?? "them"}.</span>
      </div>
      {!faces ? (
        <div className="skeleton h-40 rounded-2xl" />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(104px,1fr))]">
          {mine.map((f, i) => (
            <div key={f.id} className="relative">
              <FaceTile f={f} onOpen={() => setViewer(i)} />
              <span className={clsx("pointer-events-none absolute bottom-1.5 right-1.5 rounded-md px-1.5 py-0.5 text-[9px] font-semibold", f.by === "you" ? "bg-emerald-500/90 text-white" : "bg-black/60 text-white/80")}>
                {f.by === "you" ? "Named" : `${Math.round((f.sim ?? 0) * 100)}%`}
              </span>
            </div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {viewer !== null && p && mine[viewer] && (
          <FaceViewer
            faces={mine}
            index={viewer}
            onIndex={setViewer}
            onClose={() => setViewer(null)}
            people={data?.people ?? []}
            title={p.name}
            onName={(f, pick) => acts.name([f.id], pick).then((ok) => ok && pick.person !== id && setViewer(null))}
            actions={[{ label: `Not ${p.name}`, icon: <UserX className="size-4" />, tone: "danger", onClick: (f) => acts.not([f.id], p).then((ok) => ok && setViewer(null)) }]}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// Faces the user hid or said aren't faces: shown on request, each can be brought back.
function HiddenFaces({ reload }: { reload: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [faces, setFaces] = useState<FaceInfo[] | null>(null);
  const load = useCallback(() => api.hiddenFaces().then(setFaces).catch(() => setFaces([])), []);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  const back = async (ids: string[]) => {
    try {
      await api.restoreFaces(ids);
      toast(`${ids.length} face${ids.length === 1 ? "" : "s"} back under “To name”.`, "success");
      load();
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <section className="rounded-2xl border border-white/[0.06] p-4">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left text-sm font-medium text-slate-400 hover:text-white">
        <EyeOff className="size-4" /> Hidden and “not a face”
        <ChevronDown className={clsx("ml-auto size-4 transition", open && "rotate-180")} />
      </button>
      {open &&
        (!faces ? (
          <Loader2 className="mt-3 size-4 animate-spin text-slate-500" />
        ) : faces.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">Nothing hidden.</p>
        ) : (
          <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
            {faces.map((f) => (
              <div key={f.id} className="overflow-hidden rounded-2xl border border-white/[0.07] bg-ink-850">
                <img src={faceURL(f.id)} alt="" loading="lazy" className="aspect-square w-full object-cover opacity-70" />
                <div className="px-2 pt-1 text-center text-[10px] text-slate-500">{f.by === "hidden" ? "Hidden" : "Not a face"}</div>
                <button onClick={() => back([f.id])} className="flex w-full items-center justify-center gap-1 py-1.5 text-xs font-medium text-violet-300 hover:bg-white/5">
                  <Eye className="size-3.5" /> Show again
                </button>
              </div>
            ))}
          </div>
        ))}
    </section>
  );
}
