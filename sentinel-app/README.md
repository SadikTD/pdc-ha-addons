# Sentinel app (Android)

A dedicated app for the [Sentinel](../sentinel) NVR add-on: live cameras, recordings,
events and clips on your phone, at home or anywhere, fast and end-to-end encrypted.

**Install:** download `Sentinel.apk` from the
[latest release](https://github.com/SadikTD/pdc-ha-addons/releases/latest) on the phone
and open it (allow installing from your browser when Android asks). Android 8 or newer.

**Updates (1.11.0+):** the app updates itself. Each time it's opened it checks this
repository's latest `sentinel-app-v*` release, downloads it with a progress bar and
installs it (after a 5-second "Updating" message, or once a video being watched is
closed). Android asks once to allow Sentinel to install apps; after that updates install
without a tap on Android 12+, and a notification says what's new. To publish one: bump
`versionCode`/`versionName`, build, and create the release with `Sentinel.apk` attached;
its description (lines starting with "-") becomes the "What's new" list.

**Set up:** in Sentinel's web page go to **Settings → Sentinel app**, add a user, then in
the app log in with it. At home the app finds Sentinel by itself; elsewhere scan the QR
code or type the Sentinel ID shown there.

## Features

- **Live:** every camera live in a grid (1–3 columns), motion glow, recording status,
  sound per camera, data-saver mode (pictures instead of video on mobile data).
- **Camera:** instant start (substream first, full quality fades in), hardware H.264/HEVC
  decoding, pinch/double-tap zoom, fullscreen landscape, picture-in-picture, snapshots to
  the gallery, sound.
- **Scrubbing timeline:** drag or fling with preview frames, pinch to zoom from 1 minute
  to 2 days, tap to jump, recorded footage / gaps / motion at a glance; previous/next
  motion, ±10 s, 0.5–16× speed, "Go to" any date and time, back to live in one tap.
- **Clips:** mark a range with handles on the timeline and save (cut without
  re-encoding); watch, save to the phone, share, rename, pin, back up to Google Drive,
  delete.
- **Events:** who was seen (Person, Cat, Dog) with the picture framing them, by day;
  filter by kind, camera, time range and size, or search in plain words ("person on the
  roof last night"). Admins can press and hold a wrong label to remove it (Sentinel
  learns from it).
- **Daily summary:** people, cats, dogs and motion per camera, busiest hours,
  highlights, and whether every camera recorded; a notification each morning.
- **Timeline:** every camera's day on one screen with recorded percentage and people
  and animals marked in colour; on a camera, the skip buttons can jump between people
  or animals only.
- **System:** health, storage forecast, per-camera recorder stats, activity log (admins),
  restart a camera (admins).
- **Accounts:** each person logs in with their own username; viewers can be limited to
  some cameras; admins manage users and signed-in phones from the app too.
- App lock (fingerprint/face/screen lock), camera order and hiding per phone.

## How it connects

```
 phone ──QUIC (TLS 1.3)──► Sentinel (UDP 8555)        at home: straight over Wi-Fi
   │                          ▲                        away: straight across the internet
   └── "where are you?" ──► introducer ◄── WebSocket ──┘  (UDP hole punching)
```

- The app and Sentinel talk **directly**. Video never goes through anyone else's server.
- Both sides sit behind home/mobile routers (NAT). The **introducer**, a tiny
  [Cloudflare Worker](introducer) we deploy ourselves, only swaps the two sides' public
  addresses (a few hundred bytes); then both send UDP packets to each other at the same
  time so each router lets the other in (hole punching). STUN servers tell each side its
  own public address.
- **Security:** Sentinel has its own Ed25519 key; the **Sentinel ID is derived from that
  key**, and the app accepts only a server whose TLS certificate carries that key. So
  neither the introducer nor anyone on the network can impersonate Sentinel or read the
  traffic. Logins are per user (argon2id password hashes, lockout after wrong passwords),
  every phone gets its own revocable token, and viewers only reach their cameras.
- Inside the app, the Go connection engine (`tunnel/`, shared with Sentinel's
  `backend/p2p`) runs a private HTTP proxy on `127.0.0.1` with a random path secret; the
  video player, image loader and API client just use it.

## Building

Requirements: JDK 17, Android SDK 36 + NDK, Go 1.26+, gomobile.

```
cd sentinel-app/tunnel
gomobile bind -target=android/arm64,android/arm,android/amd64 -androidapi 26 \
  -javapkg app.sentinel -ldflags="-s -w" -trimpath -o ../android/app/libs/tunnel.aar .
cd ../android
SENTINEL_KEYSTORE=/path/sentinel-release.jks SENTINEL_KEYSTORE_PASSWORD=… ./gradlew assembleRelease
```

Add `-Pemulator` to include x86_64 for the Android emulator. Keep the release keystore
safe: Android only installs updates signed with the same key.

The introducer is deployed with `npx wrangler deploy` in `introducer/`.
`tunnel/cmd/p2ptest` tests the connection end to end (`serve`, `dial`, `discover`).
