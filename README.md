# PDC Home Assistant add-ons

## PDC WhatsApp Bridge

Self-hosted [Baileys](https://github.com/WhiskeySockets/Baileys) sender used by the Pitch Duplicate Checker Worker.

- Logs in once with a pairing code shown in the add-on log.
- Exposes `POST /send` (bearer token, JSON `{to, text, idempotencyKey}`) and `GET /health` on port 8787 inside the Supervisor network only. No host port is published.
- Only the configured recipient number can be messaged.
- Each idempotency key is sent at most once, including across restarts.

Configure `api_token` (32+ random characters), `sender_number` and `recipient_number` in the add-on options before starting.
