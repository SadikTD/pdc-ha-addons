// Calls back once an element comes within a screen-ish of being visible in its scroll
// container (the page, or a list that scrolls on its own). The browser's own
// loading="lazy" measures against the window and starts up to 2500 px early, so a grid
// of pictures still loads a hundred at once; over remote access that is megabytes the
// video you then open waits behind.

const observers = new Map<Element | null, IntersectionObserver>();
const callbacks = new WeakMap<Element, () => void>();

function scrollParent(el: Element): Element | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

function observer(root: Element | null) {
  let io = observers.get(root);
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          io!.unobserve(en.target);
          const cb = callbacks.get(en.target);
          callbacks.delete(en.target);
          cb?.();
        }
      },
      { root, rootMargin: "400px 0px" },
    );
    observers.set(root, io);
  }
  return io;
}

export function whenNear(el: Element, cb: () => void): () => void {
  const io = observer(scrollParent(el));
  callbacks.set(el, cb);
  io.observe(el);
  return () => {
    callbacks.delete(el);
    io.unobserve(el);
  };
}
