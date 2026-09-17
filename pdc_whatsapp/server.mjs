// Entry point: Baileys session + HTTP endpoint. Pure request logic lives in bridge.mjs.
import http from 'node:http';
import { rmSync, mkdirSync } from 'node:fs';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from 'baileys';
import pino from 'pino';
import { DATA, loadOptions, createLedger, createHandler, log } from './bridge.mjs';

const AUTH_DIR = `${DATA}/auth`;
const PORT = Number(process.env.PORT || 8787);

// ---------------------------------------------------------------------------
// Baileys connection with pairing-code login and automatic reconnects.
// ---------------------------------------------------------------------------
export function startWhatsApp(options) {
  // Baileys warns about app-state sync (chat mutes, pins) it can't decrypt on a fresh link.
  // Sending doesn't use that data, so only real errors are logged.
  const logger = pino({ level: 'error' });
  let sock = null, connected = false, accountOk = false, paired = false, retry = 0;

  async function connect() {
    mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    paired = Boolean(state.creds.registered);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
    sock = makeWASocket({
      auth: state, logger, browser: Browsers.macOS('Chrome'), // WhatsApp rejects phone-number pairing for unknown client names
      markOnlineOnConnect: false, syncFullHistory: false, ...(version ? { version } : {}),
    });
    sock.ev.on('creds.update', saveCreds);
    let pairingRequested = false;

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr && !state.creds.registered && !pairingRequested) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(options.sender);
          log('==============================================================');
          log(`PAIRING CODE for +${options.sender}:  ${code.slice(0, 4)}-${code.slice(4)}`);
          log('On that phone: WhatsApp > Settings > Linked devices > Link a device');
          log('> "Link with phone number instead", then enter the code above.');
          log('==============================================================');
        } catch (e) { log('Could not request pairing code:', e?.message || e); }
      }
      if (connection === 'open') {
        connected = true; paired = true; retry = 0;
        accountOk = sock.user?.id?.split(':')[0]?.split('@')[0] === options.sender;
        log(accountOk ? `Connected as +${options.sender}` : `WRONG ACCOUNT linked (${sock.user?.id}); sends are blocked`);
      }
      if (connection === 'close') {
        connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          log('Logged out from the phone. Clearing session; a new pairing code will follow.');
          rmSync(AUTH_DIR, { recursive: true, force: true });
          paired = false; retry = 0;
        }
        const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60000, 2000 * 2 ** retry++);
        log(`Connection closed (${code ?? 'no code'}); reconnecting in ${Math.round(delay / 1000)}s`);
        setTimeout(() => connect().catch(e => { log('Reconnect failed:', e?.message || e); setTimeout(connect, 30000); }), delay);
      }
    });
  }

  connect().catch(e => { log('Startup failed:', e?.message || e); process.exit(1); });
  return {
    status: () => ({ connected, paired, accountOk }),
    async send(jid, text) {
      const msg = await Promise.race([
        sock.sendMessage(jid, { text }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('send timeout')), 20000)),
      ]);
      if (!msg?.key?.id) throw new Error('no message id returned');
      return msg.key.id;
    },
  };
}

const options = loadOptions();
mkdirSync(DATA, { recursive: true });
const wa = startWhatsApp(options);
http.createServer(createHandler({ options, ledger: createLedger(), wa })).listen(PORT, () => log(`Bridge listening on :${PORT}`));
