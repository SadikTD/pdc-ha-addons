# Editorial Monitor

Watches the Gamurs board for WGTC, TMS, OS and AOTF around the clock, checks every pitch and every published article against the seven syndication guides, and WhatsApps you only what needs you.

## What it does

**Pitches** (new cards in Pitched or Writing, including self-approve writers' cards):

- If a card has no source links 3 minutes after it was made, you get a WhatsApp message (once per card).
- As soon as sources are on the card, it's checked: headline rules (sentence case, under 150 characters, no dashes, single quotes, no colon joining two headlines, no bad or drug words, "SA"), the original post date on the card, freshness (news under 24 hours, social up to a week; TikTok and X dates come from the post itself), and the AI's review against the pitching and headline guides (three Cs, "Don't pitch" list, sensitive topics, satire, hedging).
- If the writer edits the card within two hours, it's checked again by itself.

**Articles:** once the card has an edit or publish link, the post is looked up every five minutes until it goes live (scheduled posts aren't public before), then the whole article is checked. That covers shape, word count, paragraphs, H2s, style, the source link, interlinks, the embed if there is one (an article without an embed is fine; one that's there must sit right after the paragraph under the H2, render, and have no cursing), the featured image (missing, size, Imager, title, credit, and the AI looks at the picture), the SEO title, the meta description, tags and categories, plus the AI's review of tone, value, hedging, quotes and U-turns.

Each finding names the rule, quotes the guide's own words, and shows the evidence. Findings from the AI are only kept if their evidence is really in the article, and each one is then double-checked by a second AI pass against the guide's exact words (it sees the headline and summary of every interlinked story too), so stretched or invented rules are dropped. Problems and things to check go to WhatsApp. The same findings are never sent twice.

## Setup (Settings page)

1. **Gamurs board:** the board address and the PDC Monitor feed token (board Admin page).
2. **AI:** one or more Gemini API keys (Gemini 3.5 Flash-Lite is used first) and MiMo keys (MiMo V2.6 Flash, used if every Gemini key fails). Keys are tried in order: a rate-limited key rests for 2 minutes and a refused one for 30 while the next takes over; a busy provider (500/503) is retried twice. "Test every key" checks each one. Use keys of their own, not PDC Monitor's.
3. **WhatsApp:** the PDC WhatsApp Bridge's `api_token` and your number (the bridge's recipient). The bridge add-on is found by itself. "Send a test message" checks it.

## Notes

- No WordPress login is needed: the sites' public API has everything. The sites block Node's own web requests, so the add-on uses `curl` (in the image) for WordPress, sources and images.
- The meta description box can't be read directly without a login. Yoast fills an empty one from the excerpt or the start of the article, so a description that matches neither is reported as "looks typed in". The focus keyphrase can't be checked at all, and is listed as such on the Rules page.
- OS stories are filed under Curveball, so its expected primary category is Curveball. Change it per site under Settings > Sites.
- The guides are copied word for word into the add-on. Rules > "Download the guides again" fetches the current Google Docs. Settings > Rules can make that happen daily (off by default).
- Description, edit link and publish link come from the board's feed. Until the board sends them, pitch descriptions and post dates aren't checked and articles wait.

Tests: `npm test` (Node 22.13+, no dependencies). Local preview against the live board: `node test/preview/dev.mjs <data dir>`, then add the keys in Settings.
