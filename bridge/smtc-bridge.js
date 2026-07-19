#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

const HOST = process.env.SMTC_BRIDGE_HOST || "0.0.0.0";
const PORT = Number(process.env.SMTC_BRIDGE_PORT || 17865);
const CACHE_MS = Number(process.env.SMTC_CACHE_MS || 650);
const SEEK_MS = Number(process.env.SMTC_SEEK_MS || 15000);
const LYRIC_CACHE_MS = Number(process.env.SMTC_LYRIC_CACHE_MS || 6 * 60 * 60 * 1000);
const SEARCH_CACHE_MS = Number(process.env.SMTC_SEARCH_CACHE_MS || 60 * 60 * 1000);
const META_CACHE_MS = Number(process.env.SMTC_META_CACHE_MS || 6 * 60 * 60 * 1000);
const EDGE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";

let cache = { at: 0, value: null };
const lyricCache = new Map();
const searchCache = new Map();
const metaCache = new Map();

function psEncode(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", psEncode(script),
    ], {
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PowerShell timeout"));
    }, 6000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `PowerShell exited ${code}`).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

const statusScript = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
function Await-WinRt($op, [Type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($op))
  if (-not $task.Wait(4000)) { throw "WinRT timeout" }
  return $task.Result
}
$manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$currentSession = $manager.GetCurrentSession()
$sessions = @($manager.GetSessions())
if ($sessions.Count -eq 0) {
  @{ ok = $true; connected = $false; state = "none"; title = ""; artist = ""; album = ""; position_ms = 0; duration_ms = 0 } | ConvertTo-Json -Compress
  exit 0
}
$best = $null
$bestScore = -999999
$bestProps = $null
$bestPlayback = $null
$bestTimeline = $null
$bestGenres = @()
$bestNcmId = 0
$bestDuration = 0
$bestIsCurrent = $false
foreach ($candidate in $sessions) {
  $props = Await-WinRt ($candidate.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $playback = $candidate.GetPlaybackInfo()
  $timeline = $candidate.GetTimelineProperties()
  $duration = 0
  if ($timeline.EndTime -and $timeline.StartTime) { $duration = [Math]::Max(0, ($timeline.EndTime - $timeline.StartTime).TotalMilliseconds) }
  $genres = @()
  try {
    foreach ($genre in $props.Genres) {
      $genres += [string]$genre
    }
  } catch {}
  $ncmId = 0
  foreach ($genre in $genres) {
    if ($genre -match '^NCM-(\d+)$') {
      $ncmId = [int64]$Matches[1]
      break
    }
  }
  $score = 0
  if ($ncmId -gt 0) { $score += 1000 }
  if ($duration -gt 0) { $score += 200 }
  if ([string]$props.AlbumTitle -ne "") { $score += 80 }
  if ([string]$props.Title -ne "") { $score += 20 }
  if ([string]$playback.PlaybackStatus -eq "Playing") { $score += 10 }
  if ([object]::ReferenceEquals($candidate, $currentSession)) { $score += 1 }
  if ($score -gt $bestScore) {
    $best = $candidate
    $bestScore = $score
    $bestProps = $props
    $bestPlayback = $playback
    $bestTimeline = $timeline
    $bestGenres = $genres
    $bestNcmId = $ncmId
    $bestDuration = $duration
    $bestIsCurrent = [object]::ReferenceEquals($candidate, $currentSession)
  }
}
@{
  ok = $true
  connected = $true
  source = [string]$best.SourceAppUserModelId
  state = [string]$bestPlayback.PlaybackStatus
  title = [string]$bestProps.Title
  artist = [string]$bestProps.Artist
  album = [string]$bestProps.AlbumTitle
  album_artist = [string]$bestProps.AlbumArtist
  track_number = [int]$bestProps.TrackNumber
  genres = $bestGenres
  ncm_id = [int64]$bestNcmId
  position_ms = [int64][Math]::Max(0, $bestTimeline.Position.TotalMilliseconds)
  duration_ms = [int64]$bestDuration
  session_count = [int]$sessions.Count
  selected_current = [bool]$bestIsCurrent
  updated_at = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
} | ConvertTo-Json -Compress
`;

const controlScript = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
function Await-WinRt($op, [Type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($op))
  if (-not $task.Wait(4000)) { throw "WinRT timeout" }
  return $task.Result
}
$manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$session = $manager.GetCurrentSession()
if ($null -eq $session) { @{ ok = $false; error = "no session" } | ConvertTo-Json -Compress; exit 0 }
$action = [string]$env:SMTC_ACTION
$seekMs = [int64]$env:SMTC_SEEK_MS
$ok = $false
switch ($action) {
  "play" { $ok = Await-WinRt ($session.TryPlayAsync()) ([Boolean]) }
  "pause" { $ok = Await-WinRt ($session.TryPauseAsync()) ([Boolean]) }
  "playpause" { $ok = Await-WinRt ($session.TryTogglePlayPauseAsync()) ([Boolean]) }
  "toggle" { $ok = Await-WinRt ($session.TryTogglePlayPauseAsync()) ([Boolean]) }
  "next" { $ok = Await-WinRt ($session.TrySkipNextAsync()) ([Boolean]) }
  "previous" { $ok = Await-WinRt ($session.TrySkipPreviousAsync()) ([Boolean]) }
  "stop" { $ok = Await-WinRt ($session.TryStopAsync()) ([Boolean]) }
  "seek_forward" {
    $timeline = $session.GetTimelineProperties()
    $target = [Math]::Max(0, $timeline.Position.Ticks + ([TimeSpan]::FromMilliseconds($seekMs)).Ticks)
    $ok = Await-WinRt ($session.TryChangePlaybackPositionAsync($target)) ([Boolean])
  }
  "seek_back" {
    $timeline = $session.GetTimelineProperties()
    $target = [Math]::Max(0, $timeline.Position.Ticks - ([TimeSpan]::FromMilliseconds($seekMs)).Ticks)
    $ok = Await-WinRt ($session.TryChangePlaybackPositionAsync($target)) ([Boolean])
  }
  default { @{ ok = $false; error = "unknown action"; action = $action } | ConvertTo-Json -Compress; exit 0 }
}
@{ ok = [bool]$ok; action = $action } | ConvertTo-Json -Compress
`;

function parseLrc(raw) {
  const lines = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]+\]/g, "").trim();
    if (!text) continue;
    for (const stamp of stamps) {
      const min = Number(stamp[1]) || 0;
      const sec = Number(stamp[2]) || 0;
      const frac = String(stamp[3] || "0").padEnd(3, "0").slice(0, 3);
      lines.push({ at_ms: min * 60000 + sec * 1000 + Number(frac), text });
    }
  }
  return lines.sort((a, b) => a.at_ms - b.at_ms);
}

function mergeTranslation(primary, translation) {
  if (!primary.length || !translation.length) return primary;
  const translatedByTime = new Map(translation.map((line) => [line.at_ms, line.text]));
  return primary.map((line) => {
    const translated = translatedByTime.get(line.at_ms);
    if (!translated || translated === line.text) return line;
    return { ...line, text: `${line.text} / ${translated}` };
  });
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[()[\]{}【】（）。,，.!！?？'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitArtists(value) {
  return normalizeText(value)
    .split(/\s*(?:\/|&|,|，|;|；|\band\b|、)\s*/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "user-agent": EDGE_UA,
        "referer": "https://music.163.com/",
        "accept": "application/json,text/plain,*/*",
      },
      timeout: 7000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`lyric http ${res.statusCode}: ${body.slice(0, 120)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("lyric request timeout")));
    req.on("error", reject);
  });
}

function fetchBuffer(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const req = client.get(target, {
      headers: {
        "user-agent": EDGE_UA,
        "referer": "https://music.163.com/",
        "accept": "image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5",
      },
      timeout: 9000,
    }, (res) => {
      const location = res.headers.location;
      if (location && res.statusCode >= 300 && res.statusCode < 400 && redirects > 0) {
        res.resume();
        const next = new URL(location, target).toString();
        fetchBuffer(next, redirects - 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`image http ${res.statusCode}: ${body.toString("utf8", 0, 120)}`));
          return;
        }
        let contentType = String(res.headers["content-type"] || "image/jpeg");
        if (body.length >= 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) {
          contentType = "image/png";
        } else if (body.length >= 2 && body[0] === 0xff && body[1] === 0xd8) {
          contentType = "image/jpeg";
        }
        resolve({
          body,
          contentType,
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("image request timeout")));
    req.on("error", reject);
  });
}

function searchScore(song, track) {
  const title = normalizeText(track.title);
  const artist = normalizeText(track.artist);
  const songName = normalizeText(song?.name);
  const songArtists = Array.isArray(song?.artists)
    ? song.artists.map((item) => normalizeText(item?.name)).filter(Boolean)
    : [];
  let score = 0;
  if (songName === title) score += 80;
  else if (songName.includes(title) || title.includes(songName)) score += 45;
  for (const expected of splitArtists(artist)) {
    if (songArtists.some((actual) => actual === expected)) score += 30;
    else if (songArtists.some((actual) => actual.includes(expected) || expected.includes(actual))) score += 15;
  }
  if (Number(song?.duration) > 0 && Number(track.duration_ms) > 0) {
    const delta = Math.abs(Number(song.duration) - Number(track.duration_ms));
    if (delta < 2500) score += 15;
    else if (delta < 8000) score += 8;
  }
  return score;
}

async function searchNeteaseSong(track) {
  const title = String(track.title || "").trim();
  const artist = String(track.artist || "").trim();
  if (!title) return 0;
  const key = normalizeText(`${title} ${artist}`);
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return cached.id;

  const query = encodeURIComponent(`${title} ${artist}`.trim());
  const url = `https://music.163.com/api/search/get/web?csrf_token=&type=1&limit=8&s=${query}`;
  const doc = await httpsJson(url);
  const songs = doc?.result?.songs || [];
  let best = null;
  let bestScore = -1;
  for (const song of songs) {
    const score = searchScore(song, track);
    if (score > bestScore) {
      best = song;
      bestScore = score;
    }
  }
  const id = best && bestScore >= 45 ? Number(best.id) || 0 : 0;
  searchCache.set(key, { at: Date.now(), id });
  return id;
}

async function fetchNeteaseLyrics(ncmId) {
  ncmId = Number(ncmId) || 0;
  if (ncmId <= 0) return { source: "", lines: [] };

  const cached = lyricCache.get(ncmId);
  if (cached && Date.now() - cached.at < LYRIC_CACHE_MS) return cached.value;

  const url = `https://music.163.com/api/song/lyric?id=${ncmId}&lv=-1&kv=-1&tv=-1`;
  const doc = await httpsJson(url);
  const primary = parseLrc(doc?.lrc?.lyric || "");
  const translated = parseLrc(doc?.tlyric?.lyric || "");
  const lines = mergeTranslation(primary, translated);
  const value = { source: `netease:${ncmId}`, lines };
  lyricCache.set(ncmId, { at: Date.now(), value });
  return value;
}

async function fetchNeteaseMeta(ncmId) {
  ncmId = Number(ncmId) || 0;
  if (ncmId <= 0) return {};

  const cached = metaCache.get(ncmId);
  if (cached && Date.now() - cached.at < META_CACHE_MS) return cached.value;

  const url = `https://music.163.com/api/song/detail/?ids=%5B${ncmId}%5D`;
  const doc = await httpsJson(url);
  const song = Array.isArray(doc?.songs) ? doc.songs[0] : null;
  const album = song?.album || song?.al || {};
  const coverUrl = album.picUrl || album.pic || "";
  const value = {
    id: ncmId,
    title: song?.name || "",
    album: album.name || "",
    duration_ms: Number(song?.duration || song?.dt) || 0,
    cover_url: coverUrl ? `${coverUrl}?param=92y92&type=jpg` : "",
  };
  metaCache.set(ncmId, { at: Date.now(), value });
  return value;
}

async function findLyrics(status) {
  let ncmId = Number(status.ncm_id) || 0;
  let sourceHint = "smtc";
  if (ncmId <= 0) {
    ncmId = await searchNeteaseSong(status);
    sourceHint = "search";
    status.ncm_id = ncmId;
  }
  const found = await fetchNeteaseLyrics(ncmId);
  return {
    ...found,
    source: found.source ? `${found.source}:${sourceHint}` : "",
  };
}

function lyricAt(lines, positionMs) {
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].at_ms <= positionMs) index = i;
    else break;
  }
  return {
    index,
    at_ms: index >= 0 ? lines[index].at_ms : 0,
    next_at_ms: index + 1 < lines.length ? lines[index + 1].at_ms : 0,
    current: index >= 0 ? lines[index].text : "",
    next: index + 1 < lines.length ? lines[index + 1].text : "",
  };
}

async function smtcStatus(force = false) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < CACHE_MS) return cache.value;
  try {
    const raw = await runPowerShell(statusScript);
    const status = JSON.parse(raw || "{}");
    if (status.connected) {
      const found = await findLyrics(status);
      const meta = await fetchNeteaseMeta(status.ncm_id);
      if (!status.album && meta.album) status.album = meta.album;
      if ((!Number(status.duration_ms) || Number(status.duration_ms) <= 0) && meta.duration_ms) status.duration_ms = meta.duration_ms;
      status.ncm_id_text = status.ncm_id ? String(status.ncm_id) : "";
      status.cover_url = meta.cover_url || "";
      status.lyrics_available = found.lines.length > 0;
      status.lyric_source = found.source;
      status.lyric = lyricAt(found.lines, Number(status.position_ms) || 0);
    } else {
      status.lyrics_available = false;
      status.lyric = { index: -1, current: "", next: "" };
    }
    cache = { at: now, value: status };
    return status;
  } catch (error) {
    const fallback = { ok: false, connected: false, error: error.message, state: "error", lyric: { index: -1, current: "", next: "" } };
    cache = { at: now, value: fallback };
    return fallback;
  }
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

function html() {
  return `<!doctype html><meta charset="utf-8"><title>SMTC Bridge</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#172033}code{background:#f1f5f9;padding:2px 5px;border-radius:6px}button{min-height:36px;margin:3px 3px 3px 0}</style>
<h1>SMTC Bridge</h1>
<p>Endpoints: <code>GET /status</code>, <code>GET /lyrics?ncm_id=...</code>, <code>GET /control?action=playpause</code>.</p>
<p>Lyrics are loaded from the NetEase ID exposed by InfLink-rs in SMTC Genres, e.g. <code>NCM-123456</code>.</p>
<p><button onclick="cmd('previous')">Prev</button><button onclick="cmd('playpause')">Play/Pause</button><button onclick="cmd('next')">Next</button><button onclick="cmd('seek_back')">-15s</button><button onclick="cmd('seek_forward')">+15s</button></p>
<pre id="out">Loading...</pre>
<script>
async function refresh(){out.textContent=JSON.stringify(await fetch('/status').then(r=>r.json()),null,2)}
async function cmd(action){await fetch('/control?action='+encodeURIComponent(action));refresh()}
refresh();setInterval(refresh,1500)
</script>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method === "GET" && url.pathname === "/") {
    const body = html();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "smtc-bridge", lyric_source: "smtc-genres-ncm-id" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/status") {
    sendJson(res, 200, await smtcStatus(url.searchParams.get("fresh") === "1"));
    return;
  }
  if (req.method === "GET" && url.pathname === "/lyrics") {
    try {
      let ncmId = Number(url.searchParams.get("ncm_id")) || 0;
      if (ncmId <= 0) {
        const status = await smtcStatus(url.searchParams.get("fresh") === "1");
        ncmId = Number(status.ncm_id) || 0;
      }
      const found = await fetchNeteaseLyrics(ncmId);
      sendJson(res, 200, {
        ok: true,
        ncm_id: ncmId,
        ncm_id_text: ncmId ? String(ncmId) : "",
        source: found.source,
        line_count: found.lines.length,
        lines: found.lines,
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message, lines: [] });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/cover") {
    try {
      const ncmId = Number(url.searchParams.get("ncm_id")) || 0;
      const meta = await fetchNeteaseMeta(ncmId);
      if (!meta.cover_url) {
        sendJson(res, 404, { ok: false, error: "cover not found" });
        return;
      }
      const image = await fetchBuffer(meta.cover_url);
      res.writeHead(200, {
        "content-type": image.contentType,
        "content-length": image.body.length,
        "cache-control": "public, max-age=86400",
        "access-control-allow-origin": "*",
      });
      res.end(image.body);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/control") {
    const action = url.searchParams.get("action") || "playpause";
    sendJson(res, 202, { ok: true, accepted: true, action });
    runPowerShell(controlScript, { SMTC_ACTION: action, SMTC_SEEK_MS: String(SEEK_MS) })
      .then(() => { cache.at = 0; })
      .catch((error) => {
        cache = {
          at: Date.now(),
          value: { ok: false, connected: false, error: error.message, state: "error", action, lyric: { index: -1, current: "", next: "" } },
        };
      });
    return;
  }
  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`SMTC bridge listening on http://${HOST}:${PORT}\n`);
  process.stdout.write("Lyrics: SMTC Genres NCM-{id} -> NetEase lyric API\n");
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
