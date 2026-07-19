# SMTC Music

HoloCubic app for displaying Windows SMTC media metadata and controlling playback through a small PC-side HTTP bridge.

## Device App

Copy `package/` to the device as:

```text
/sd/apps/smtc_music/app.info
/sd/apps/smtc_music/info.html
/sd/apps/smtc_music/main.png
/sd/apps/smtc_music/main.lua
/sd/apps/smtc_music/ui.lua
/sd/apps/smtc_music/web.lua
/sd/apps/smtc_music/config.lua
```

Edit `config.lua` and set `config.host` to the Windows PC IP that will run the bridge. The default bridge port is `17865`.

Controls:

- `HOME` short press: play/pause
- `HOME` long press: exit
- `LEFT` / `RIGHT`: previous / next
- `UP` / `DOWN`: seek +15s / -15s

## PC Bridge

Run on Windows:

```powershell
node .\bridge\smtc-bridge.js
```

Open `http://localhost:17865/` for health and endpoint info. The HoloCubic app reads `GET /status`, fetches full synced lyrics from `GET /lyrics?provider=...&id=...`, downloads covers from `GET /cover?provider=...&id=...`, and sends commands to `GET /control?action=...`.

When SMTC Music is running, launcher will expose the app's own WebUI route. Open the current app route shown by launcher to edit the device-side bridge host, port, poll interval, timeout, and endpoint paths. Saving the page rewrites `/sd/apps/smtc_music/config.lua` and the running app reconnects with the new values.

SMTC provides title, artist, album, playback status and timeline. InfLink-rs also writes the NetEase song ID into SMTC `Genres` as `NCM-{id}`. The bridge reads that ID and fetches synced lyrics and cover art from NetEase.

QQ Music is handled as its own source: the bridge normalizes QQ Music SMTC title/artist fields, matches the track through QQ Music's web API, then fetches QQ Music lyrics and album art. QQ tracks do not fall back to NetEase search.

- Lyrics work best when the current SMTC source is InfLink-rs or QQ Music.
- `GET /status` includes provider/id fields, playback state, timeline position, `lyric.current`, and `lyric.next`.
- `GET /lyrics?provider=...&id=...` returns the complete timed lyric array. The device app caches this and scrolls locally; `GET /status` is used only to correct playback time and state.
- If no provider-specific match is found, the bridge still shows metadata and controls, but lyrics and cover art may be unavailable.

## Font Build

The packaged `font/smtc_cjk_16.bin` is generated as 1bpp for crisp text on the HoloCubic display. To rebuild it:

```powershell
.\font\build_smtc_cjk_font.ps1
```

Run `npm install` in `font/` first if `font/node_modules/` is absent.

