// Entry point: Baileys session + HTTP endpoint. Pure request logic lives in bridge.mjs.
import http from 'node:http';
import { rm, mkdir } from 'node:fs/promises';
import makeWASocket, { DisconnectReason, Browsers, fetchLatestBaileysVersion } from 'baileys';
import pino from 'pino';
import { DATA, loadOptions, createLedger, createHandler, log } from './bridge.mjs';
import { useAtomicAuthState } from './auth-state.mjs';

const AUTH_DIR = `${DATA}/auth`;
const PORT = Number(process.env.PORT || 8787);
const OFFLINE_NOTIFY_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Home Assistant notifications (Settings sidebar bell), so a broken link is
// noticed without reading the add-on log. Needs homeassistant_api in config.
// ---------------------------------------------------------------------------
async function haNotify(message) {
  if (!process.env.SUPERVISOR_TOKEN) return;
  const service = message ? 'create' : 'dismiss';
  const body = { notification_id: 'pdc_whatsapp_bridge', ...(message ? { title: 'PDC WhatsApp Bridge', message } : {}) };
  try {
    await fetch(`http://supervisor/core/api/services/persistent_notification/${service}`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) { log('Could not update Home Assistant notification:', e?.message || e); }
}

// ---------------------------------------------------------------------------
// Baileys connection with pairing-code login and automatic reconnects.
// ---------------------------------------------------------------------------
export function startWhatsApp(options) {
  // Baileys warns about app-state sync (chat mutes, pins) it can't decrypt on a fresh link.
  // Sending doesn't use that data, so only real errors are logged.
  const logger = pino({ level: 'error' });
  let sock = null, auth = null, connected = false, accountOk = false, paired = false;
  let retry = 0, reconnectTimer = null, offlineSince = Date.now(), notified = false, stopping = false;

  const schedule = delay => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect().catch(e => {
      log('Connect failed:', e?.message || e);
      if (/Unreadable session file/.test(e?.message)) {
        haNotify('The saved WhatsApp session is damaged. Stop the add-on, then start it again to get a new pairing code if this keeps happening.');
      }
      schedule(30000);
    }), delay);
  };

  // Warn in Home Assistant if WhatsApp has been unreachable for a while.
  setInterval(() => {
    if (!connected && !notified && Date.now() - offlineSince > OFFLINE_NOTIFY_MS) {
      notified = true;
      haNotify(paired
        ? 'WhatsApp has been disconnected for over 10 minutes. Pitch alerts are queued and will send once it reconnects. Check the add-on log.'
        : 'WhatsApp is not linked. Open the add-on log, then enter the pairing code on the sender phone under Linked devices.');
    }
  }, 60000).unref();

  async function connect() {
    if (stopping) return;
    await mkdir(AUTH_DIR, { recursive: true });
    auth ||= await useAtomicAuthState(AUTH_DIR);
    const { state, saveCreds } = auth;
    paired = Boolean(state.creds.registered);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
    const current = sock = makeWASocket({
      auth: state, logger, browser: Browsers.macOS('Chrome'), // WhatsApp rejects phone-number pairing for unknown client names
      markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
      ...(version ? { version } : {}),
    });
    current.ev.on('creds.update', saveCreds);
    let pairingRequested = false;

    current.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (current !== sock) return; // events from a replaced socket
      if (qr && !state.creds.registered && !pairingRequested) {
        pairingRequested = true;
        try {
          const code = await current.requestPairingCode(options.sender);
          log('==============================================================');
          log(`PAIRING CODE for +${options.sender}:  ${code.slice(0, 4)}-${code.slice(4)}`);
          log('On that phone: WhatsApp > Settings > Linked devices > Link a device');
          log('> "Link with phone number instead", then enter the code above.');
          log('==============================================================');
        } catch (e) { log('Could not request pairing code:', e?.message || e); }
      }
      if (connection === 'open') {
        connected = true; paired = true; retry = 0; offlineSince = 0;
        accountOk = current.user?.id?.split(':')[0]?.split('@')[0] === options.sender;
        log(accountOk ? `Connected as +${options.sender}` : `WRONG ACCOUNT linked (${current.user?.id}); sends are blocked`);
        if (accountOk) { if (notified) haNotify(null); notified = false; }
        else haNotify(`The linked WhatsApp account is not +${options.sender}, so alerts are blocked. Unlink this device on that phone and pair the correct number.`);
      }
      if (connection === 'close') {
        if (connected || !offlineSince) offlineSince = Date.now();
        connected = false;
        if (stopping) return;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          log('WhatsApp rejected the session (unlinked on the phone, or pairing failed). Starting over with a new pairing code.');
          current.ev.removeAllListeners('creds.update');
          await auth.flush().catch(() => {});
          await rm(AUTH_DIR, { recursive: true, force: true });
          auth = null; paired = false; retry = 0;
          if (state.creds.registered) {
            notified = true;
            haNotify('This bridge was unlinked from WhatsApp, so pitch alerts are paused. Open the add-on log and enter the new pairing code on the sender phone.');
          }
        }
        if (code === DisconnectReason.forbidden) {
          notified = true;
          haNotify('WhatsApp refused the connection (403). The sender number may be restricted. Check WhatsApp on that phone.');
        }
        const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60000, 2000 * 2 ** retry++);
        log(`Connection closed (${code ?? 'no code'}); reconnecting in ${Math.round(delay / 1000)}s`);
        schedule(delay);
      }
    });
  }

  schedule(0);
  return {
    status: () => ({ connected, paired, accountOk }),
    async send(jid, text) {
      let timer;
      try {
        const msg = await Promise.race([
          sock.sendMessage(jid, { text }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('send timeout')), 20000); }),
        ]);
        if (!msg?.key?.id) throw new Error('no message id returned');
        return msg.key.id;
      } finally { clearTimeout(timer); }
    },
    // Home Assistant stops/updates the add-on with SIGTERM: finish session writes first.
    async stop() {
      stopping = true; clearTimeout(reconnectTimer);
      await auth?.flush().catch(() => {});
      sock?.end(undefined);
    },
  };
}

process.on('unhandledRejection', e => log('Unhandled rejection:', e?.stack || e));

const options = loadOptions();
await mkdir(DATA, { recursive: true });
const wa = startWhatsApp(options);
const server = http.createServer(createHandler({ options, ledger: createLedger(), wa }));
server.requestTimeout = 60000;
server.listen(PORT, () => log(`Bridge listening on :${PORT}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    log(`${signal} received; saving session and shutting down`);
    server.close();
    const force = setTimeout(() => process.exit(0), 8000);
    await wa.stop();
    clearTimeout(force);
    process.exit(0);
  });
}
