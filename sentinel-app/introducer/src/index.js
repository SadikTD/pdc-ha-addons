// Sentinel introducer: lets the Sentinel app find a Sentinel server that sits behind
// home routers. The server keeps one WebSocket open here (proving it owns its ID with
// its key); the app posts its own addresses and gets the server's back. Video and data
// never pass through here: the two sides then connect to each other directly, and the
// app checks the server's key itself, so this relay can't impersonate a server.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_LENGTH = 12;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function normalizeId(s) {
  let out = "";
  for (let c of s.toUpperCase()) {
    if (c === "O") c = "0";
    if (c === "I" || c === "L") c = "1";
    if (ALPHABET.includes(c)) out += c;
  }
  return out;
}

async function idFromKey(pub) {
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", pub));
  let out = "";
  let acc = 0n;
  let bits = 0;
  let i = 0;
  while (out.length < ID_LENGTH) {
    if (bits < 5) {
      acc = (acc << 8n) | BigInt(sum[i++]);
      bits += 8;
    }
    bits -= 5;
    out += ALPHABET[Number((acc >> BigInt(bits)) & 31n)];
  }
  return out;
}

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/v1\/(host|connect)\/([^/]+)$/);
    if (!m) return new Response("Sentinel introducer\n", { headers: { "content-type": "text/plain" } });
    const id = normalizeId(m[2]);
    if (id.length !== ID_LENGTH) return json({ error: "bad id" }, 400);
    const stub = env.SERVERS.get(env.SERVERS.idFromName(id));
    return stub.fetch(request);
  },
};

// One Durable Object per Sentinel ID. Idle WebSockets hibernate, so an online server
// costs nothing while nobody connects.
export class Server {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = new Map(); // sid -> resolve
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  hosts() {
    return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.authed);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const [, , kind, rawId] = url.pathname.split("/");
    const id = normalizeId(rawId);

    if (kind === "host") {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected a WebSocket" }, 426);
      const pair = new WebSocketPair();
      const nonce = crypto.randomUUID();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ id, nonce, authed: false });
      pair[1].send(JSON.stringify({ t: "challenge", nonce }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // kind === "connect": the app asks for the server's addresses.
    if (request.method !== "POST") return json({ error: "use POST" }, 405);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad request" }, 400);
    }
    const cands = Array.isArray(body.cands) ? body.cands.filter((c) => typeof c === "string" && c.length < 64).slice(0, 8) : [];
    const sid = typeof body.sid === "string" ? body.sid.slice(0, 32) : crypto.randomUUID();
    const host = this.hosts().at(-1);
    if (!host) return json({ error: "offline" }, 404);
    const answer = new Promise((resolve) => {
      this.pending.set(sid, resolve);
      setTimeout(() => resolve(null), 8000);
    });
    host.send(JSON.stringify({ t: "connect", sid, cands }));
    const a = await answer;
    this.pending.delete(sid);
    if (!a) return json({ error: "Sentinel didn't answer" }, 504);
    return json({ cands: a.cands ?? [], name: host.deserializeAttachment().name ?? "" });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== "string") return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() ?? {};
    if (msg.t === "auth" && !att.authed) {
      try {
        const pub = b64(msg.pub);
        if (pub.length !== 32 || (await idFromKey(pub)) !== att.id) throw new Error("key doesn't match the ID");
        const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
        const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, b64(msg.sig), new TextEncoder().encode("sentinel-introducer-v1:" + att.nonce));
        if (!ok) throw new Error("bad signature");
      } catch (e) {
        ws.send(JSON.stringify({ t: "error", error: String(e.message ?? e) }));
        ws.close(4001, "auth failed");
        return;
      }
      // A server that reconnects (e.g. after a router restart) replaces its old socket.
      for (const old of this.hosts()) old.close(4000, "replaced");
      ws.serializeAttachment({ ...att, authed: true, name: String(msg.name ?? "").slice(0, 64), version: String(msg.version ?? "").slice(0, 32) });
      ws.send(JSON.stringify({ t: "ok" }));
      return;
    }
    if (msg.t === "answer" && att.authed) {
      const resolve = this.pending.get(msg.sid);
      if (resolve) resolve({ cands: Array.isArray(msg.cands) ? msg.cands.slice(0, 8) : [] });
    }
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code, "bye");
    } catch {}
  }
}
