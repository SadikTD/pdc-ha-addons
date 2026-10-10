# Valorant Store Tracker

Checks your Valorant daily store right after it resets, keeps every day's store, and
WhatsApps you (through the **PDC WhatsApp Bridge** add-on) when a skin on your wishlist
shows up. The wishlist starts with the Reaver Butterfly Knife.

The **Valorant Store** sidebar panel has four tabs:

- **Today:** your main target with a 60-day strip (one mark per store, red when it was
  there), today's four skins, the featured bundle(s), the Night Market when it's running,
  and your VP, Radianite and Kingdom Credits.
- **History:** every store since you installed it, searchable by skin, and the skins
  you've been offered most often.
- **Wishlist:** add any skin from the full catalog; the first one is the main target.
- **Settings:** Riot sign-in, WhatsApp test, Night Market alerts, an optional daily
  store message, and an activity log.

## Setup

1. Start the add-on. WhatsApp works on its own: it uses the PDC WhatsApp Bridge's
   `recipient_number` and `api_token` (set `whatsapp_to` / `whatsapp_api_token` only to
   override them).
2. Open **Valorant Store > Settings** and follow the four steps to paste your Riot
   `ssid` cookie. Tick *Stay signed in* when you sign in to Riot; the session lasts much
   longer.
3. Press **Send test message** to check WhatsApp.

## How it signs in

Riot's sign-in has a captcha, so the add-on never sees your password. It uses the
`ssid` session cookie to get a fresh token on every check and saves the renewed cookies
Riot sends back, which keeps the session alive. If Riot ends the session anyway, you
get a WhatsApp message and a Home Assistant notification; paste a new cookie and it
carries on. The cookie is kept in this add-on's `/data` folder and is sent only to Riot.

The store API is the one the game client uses. It's unofficial: Riot can change it
without notice, and using it isn't endorsed by Riot.

## When it checks

Right after the daily reset (00:00 UTC, 6:00 AM in Bangladesh) and every
`check_every_hours` (default 6) in between, which picks up the Night Market and new
bundles. **Check now** in the header checks at once. Failed checks retry after 5, 10, 20,
40 and then every 60 minutes.

Each wishlist skin is alerted once per store (and once per Night Market).

## Options

| Option | Default | |
|---|---|---|
| `whatsapp_to` | empty | Override the bridge's `recipient_number` |
| `whatsapp_api_token` | empty | Override the bridge's `api_token` |
| `whatsapp_bridge_url` | empty | Only if the bridge isn't found automatically |
| `check_every_hours` | 6 | Extra checks between daily resets (1-24) |

## Development

`python test_main.py` runs the self-check. `python dev_demo.py [found]` serves the
dashboard on http://localhost:38766 with fake stores built from the real skin catalog.
