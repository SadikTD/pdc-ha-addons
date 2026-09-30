import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ScanFace, UserX, X } from "lucide-react";
import { api, faceURL, type FaceInfo, type PersonInfo } from "../lib/api";
import { useToast } from "../lib/toast";
import { FaceViewer } from "./FaceViewer";

// The faces found in the event being watched, with who they are: tap one to see it large
// and name it (or fix a wrong name) without leaving the player.
export function EventPeople({ cam, eventId }: { cam: string; eventId: string | undefined }) {
  const toast = useToast();
  const [faces, setFaces] = useState<FaceInfo[]>([]);
  const [people, setPeople] = useState<PersonInfo[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!eventId) return setFaces([]);
    api.eventFaces(cam, eventId).then(setFaces).catch(() => setFaces([]));
  }, [cam, eventId]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    api.people().then((r) => setPeople(r.people)).catch(() => {});
  }, []);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg, "success");
      load();
      api.people().then((r) => setPeople(r.people)).catch(() => {});
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    }
  };

  // One face per person is enough here: the clearest.
  const shown = faces.filter((f, i) => !f.person || faces.findIndex((x) => x.person === f.person) === i).slice(0, 8);
  const f = open !== null ? shown[open] : undefined;

  return (
    <>
      <AnimatePresence>
        {shown.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="glass flex items-center gap-3 overflow-x-auto rounded-2xl px-3 py-2">
              <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-slate-400">
                <ScanFace className="size-4" /> In this moment
              </span>
              {shown.map((x, i) => (
                <button key={x.id} onClick={() => setOpen(i)} className="flex shrink-0 items-center gap-2 rounded-full bg-white/5 py-1 pl-1 pr-3 transition hover:bg-white/10">
                  <img src={faceURL(x.id)} alt="" className="size-8 rounded-full object-cover" />
                  <span className={x.name ? "text-sm font-medium text-white" : "text-sm text-violet-300"}>{x.name || "Who is this?"}</span>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {f && (
          <FaceViewer
            faces={shown}
            index={open!}
            onIndex={setOpen}
            onClose={() => setOpen(null)}
            people={people}
            onName={(x, p) => run(() => api.nameFaces([x.id], p.person ? { person: p.person } : { name: p.name }), `Named ${p.label}.`).then((ok) => ok && setOpen(null))}
            actions={[
              ...(f.person ? [{ label: `Not ${f.name}`, icon: <UserX className="size-4" />, tone: "danger" as const, onClick: (x: FaceInfo) => run(() => api.notPerson([x.id], x.person!), `Taken out of ${x.name}.`).then((ok) => ok && setOpen(null)) }] : []),
              { label: "Not a face", icon: <X className="size-4" />, tone: "danger" as const, onClick: (x: FaceInfo) => run(() => api.notFaces([x.id]), "Ignored.").then((ok) => ok && setOpen(null)) },
            ]}
          />
        )}
      </AnimatePresence>
    </>
  );
}
