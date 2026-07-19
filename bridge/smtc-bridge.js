#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const zlib = require("zlib");
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
const qqSearchCache = new Map();
const qqMetaCache = new Map();

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
  if ([string]$playback.PlaybackStatus -eq "Playing") { $score += 3000 }
  if ([object]::ReferenceEquals($candidate, $currentSession)) { $score += 1200 }
  if ($ncmId -gt 0) { $score += 1000 }
  if ($duration -gt 0) { $score += 200 }
  if ([string]$props.AlbumTitle -ne "") { $score += 80 }
  if ([string]$props.Title -ne "") { $score += 20 }
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

function isQQMusicSource(source) {
  return /qqmusic|tencent/i.test(String(source || ""));
}

function stripPlaybackSuffix(value) {
  return String(value || "")
    .replace(/\s*[-–—|]\s*(?:qq\s*music|qq音乐|腾讯音乐)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferTrackMetadata(status) {
  const next = { ...status };
  next.title = stripPlaybackSuffix(next.title);
  next.artist = stripPlaybackSuffix(next.artist);
  next.album = stripPlaybackSuffix(next.album);

  if (!next.artist && isQQMusicSource(next.source)) {
    const match = String(next.title || "").match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (match) {
      next.title = stripPlaybackSuffix(match[1]);
      next.artist = stripPlaybackSuffix(match[2]);
    }
  }

  return next;
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

function requestText(url, options = {}, redirects = 3) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const req = client.get(target, {
      headers: {
        "user-agent": EDGE_UA,
        "referer": options.referer || "https://y.qq.com/",
        "accept": options.accept || "application/json,text/plain,*/*",
        "accept-encoding": "gzip, deflate, br",
        ...(options.headers || {}),
      },
      timeout: options.timeout || 9000,
    }, (res) => {
      const location = res.headers.location;
      if (location && res.statusCode >= 300 && res.statusCode < 400 && redirects > 0) {
        res.resume();
        const next = new URL(location, target).toString();
        requestText(next, options, redirects - 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let body = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`http ${res.statusCode}: ${body.toString("utf8", 0, 120)}`));
          return;
        }
        try {
          const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
          if (encoding.includes("gzip")) body = zlib.gunzipSync(body);
          else if (encoding.includes("deflate")) body = zlib.inflateSync(body);
          else if (encoding.includes("br")) body = zlib.brotliDecompressSync(body);
        } catch (error) {
          reject(error);
          return;
        }
        resolve(body.toString("utf8"));
      });
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
  });
}

function parseLooseJson(raw) {
  let text = String(raw || "").trim();
  const jsonp = text.match(/^[\w$.]+\(([\s\S]*)\)\s*;?$/);
  if (jsonp) text = jsonp[1];
  return JSON.parse(text);
}

async function requestJson(url, options) {
  return parseLooseJson(await requestText(url, options));
}

function fetchBuffer(url, options = {}, redirects = 3) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const req = client.get(target, {
      headers: {
        "user-agent": EDGE_UA,
        "referer": options.referer || "https://music.163.com/",
        "accept": "image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5",
      },
      timeout: 9000,
    }, (res) => {
      const location = res.headers.location;
      if (location && res.statusCode >= 300 && res.statusCode < 400 && redirects > 0) {
        res.resume();
        const next = new URL(location, target).toString();
        fetchBuffer(next, options, redirects - 1).then(resolve, reject);
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

function decodeHtml(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code) || 0))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16) || 0))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function maybeBase64Text(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("[") || /[^\w+/=\s]/.test(text)) return text;
  try {
    const decoded = Buffer.from(text, "base64").toString("utf8");
    return decoded.includes("[") ? decoded : text;
  } catch {
    return text;
  }
}

function qqCoverUrl(albumMid, size = 300) {
  albumMid = String(albumMid || "").trim();
  if (!albumMid) return "";
  return `https://y.qq.com/music/photo_new/T002R${size}x${size}M000${encodeURIComponent(albumMid)}.jpg?max_age=2592000`;
}

function normalizeQQSong(song) {
  if (!song) return null;
  const singer = Array.isArray(song.singer) ? song.singer : [];
  const album = song.album || {};
  const id = Number(song.songid || song.id || song.musicid) || 0;
  const mid = String(song.songmid || song.mid || "").trim();
  const albumMid = String(album.mid || song.albummid || "").trim();
  const value = {
    provider: "qqmusic",
    id,
    mid,
    title: song.songname || song.name || "",
    artist: singer.map((item) => item.name).filter(Boolean).join(" / "),
    album: album.name || song.albumname || "",
    duration_ms: (Number(song.interval) || 0) * 1000,
    album_mid: albumMid,
    cover_url: qqCoverUrl(albumMid),
  };
  if (value.id > 0) qqMetaCache.set(`id:${value.id}`, { at: Date.now(), value });
  if (value.mid) qqMetaCache.set(`mid:${value.mid}`, { at: Date.now(), value });
  if (value.album_mid) qqMetaCache.set(`album:${value.album_mid}`, { at: Date.now(), value });
  return value;
}

async function searchQQMusicSong(track) {
  const title = String(track.title || "").trim();
  const artist = String(track.artist || "").trim();
  if (!title) return null;
  const key = normalizeText(`${title} ${artist}`);
  const cached = qqSearchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return cached.value;

  const query = encodeURIComponent(`${title} ${artist}`.trim());
  const endpoints = [
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?ct=24&qqmusic_ver=1298&new_json=1&remoteplace=txt.yqq.song&searchid=1&t=0&aggr=1&cr=1&catZhida=1&lossless=0&flag_qc=0&p=1&n=8&w=${query}&format=json&platform=yqq.json&needNewCode=0`,
    `https://c.y.qq.com/soso/fcgi-bin/search_cp?g_tk=5381&uin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0&w=${query}&zhidaqu=1&catZhida=1&t=0&flag=1&ie=utf-8&sem=1&aggr=0&perpage=8&n=8&p=1&remoteplace=txt.mqq.all`,
  ];
  let songs = [];
  for (const endpoint of endpoints) {
    try {
      const doc = await requestJson(endpoint, { referer: "https://y.qq.com/" });
      songs = doc?.data?.song?.list || doc?.data?.list || [];
      if (songs.length) break;
    } catch {}
  }
  let best = null;
  let bestScore = -1;
  for (const rawSong of songs) {
    const song = normalizeQQSong(rawSong);
    if (!song) continue;
    const score = searchScore({ name: song.title, artists: splitArtists(song.artist).map((name) => ({ name })), duration: song.duration_ms }, track);
    if (score > bestScore) {
      best = song;
      bestScore = score;
    }
  }
  const value = best && bestScore >= 45 ? best : null;
  qqSearchCache.set(key, { at: Date.now(), value });
  return value;
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

async function fetchQQLyrics(track) {
  const songId = Number(track?.id) || 0;
  const songMid = String(track?.mid || "").trim();
  if (songId <= 0 && !songMid) return { source: "", lines: [] };

  const cacheKey = `qq:${songId || songMid}`;
  const cached = lyricCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LYRIC_CACHE_MS) return cached.value;

  const params = [
    "nobase64=1",
    "format=json",
    "inCharset=utf8",
    "outCharset=utf-8",
    "notice=0",
    "platform=yqq",
    "needNewCode=0",
  ].join("&");
  const queryIds = [];
  if (songId > 0) queryIds.push(`musicid=${songId}`);
  if (songMid) queryIds.push(`songmid=${encodeURIComponent(songMid)}`);
  const endpoints = queryIds.flatMap((idPart) => [
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${params}&${idPart}`,
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric.fcg?${params}&${idPart}`,
  ]);
  const referer = songMid ? `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(songMid)}` : "https://y.qq.com/";
  for (const endpoint of endpoints) {
    try {
      const doc = await requestJson(endpoint, {
        referer,
        headers: {
          origin: "https://y.qq.com",
        },
      });
      const lyricRaw = decodeHtml(maybeBase64Text(doc?.lyric || ""));
      const transRaw = decodeHtml(maybeBase64Text(doc?.trans || doc?.translate || ""));
      const primary = parseLrc(lyricRaw);
      const translated = parseLrc(transRaw);
      const lines = mergeTranslation(primary, translated);
      if (lines.length) {
        const value = { source: `qqmusic:${songId || songMid}`, lines };
        lyricCache.set(cacheKey, { at: Date.now(), value });
        return value;
      }
    } catch {}
  }

  const value = { source: "", lines: [] };
  lyricCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function findNeteaseLyrics(status) {
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

async function resolveMedia(status) {
  if (isQQMusicSource(status.source)) {
    const qq = await searchQQMusicSong(status);
    if (!qq) {
      status.lyric_provider = "qqmusic";
      status.lyric_id_text = "";
      status.cover_provider = "qqmusic";
      status.cover_id_text = "";
      return { found: { source: "", lines: [] }, meta: {} };
    }
    status.qq_song_id = qq.id;
    status.qq_song_mid = qq.mid;
    status.qq_album_mid = qq.album_mid;
    status.lyric_provider = "qqmusic";
    status.lyric_id_text = qq.id ? String(qq.id) : qq.mid;
    status.cover_provider = "qqmusic";
    status.cover_id_text = qq.album_mid || "";
    const found = await fetchQQLyrics(qq);
    return { found, meta: qq };
  }

  const found = await findNeteaseLyrics(status);
  const meta = await fetchNeteaseMeta(status.ncm_id);
  status.lyric_provider = "netease";
  status.lyric_id_text = status.ncm_id ? String(status.ncm_id) : "";
  status.cover_provider = "netease";
  status.cover_id_text = status.ncm_id ? String(status.ncm_id) : "";
  return { found, meta };
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
    const status = inferTrackMetadata(JSON.parse(raw || "{}"));
    if (status.connected) {
      status.smtc_adapter = isQQMusicSource(status.source) ? "qqmusic" : "generic";
      const { found, meta } = await resolveMedia(status);
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
<p>Endpoints: <code>GET /status</code>, <code>GET /lyrics?provider=...&id=...</code>, <code>GET /cover?provider=...&id=...</code>, <code>GET /control?action=playpause</code>.</p>
<p>Lyrics are loaded from InfLink-rs <code>NCM-{id}</code> metadata or from QQ Music SMTC title/artist matching.</p>
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
    sendJson(res, 200, { ok: true, service: "smtc-bridge", lyric_sources: ["smtc-genres-ncm-id", "qqmusic"] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/status") {
    sendJson(res, 200, await smtcStatus(url.searchParams.get("fresh") === "1"));
    return;
  }
  if (req.method === "GET" && url.pathname === "/lyrics") {
    try {
      let provider = String(url.searchParams.get("provider") || "").toLowerCase();
      let idText = String(url.searchParams.get("id") || url.searchParams.get("ncm_id") || "");
      let songMid = String(url.searchParams.get("songmid") || "");
      if (!provider && url.searchParams.has("ncm_id")) provider = "netease";
      if (!idText) {
        const status = await smtcStatus(url.searchParams.get("fresh") === "1");
        provider = String(status.lyric_provider || (status.ncm_id ? "netease" : "")).toLowerCase();
        idText = String(status.lyric_id_text || status.ncm_id_text || "");
        songMid = String(status.qq_song_mid || "");
      }
      let found;
      if (provider === "qq" || provider === "qqmusic") {
        found = await fetchQQLyrics({ id: Number(idText) || 0, mid: songMid });
        provider = "qqmusic";
      } else {
        const ncmId = Number(idText) || 0;
        found = await fetchNeteaseLyrics(ncmId);
        provider = "netease";
        idText = ncmId ? String(ncmId) : "";
      }
      sendJson(res, 200, {
        ok: true,
        provider,
        id: idText,
        ncm_id: provider === "netease" ? Number(idText) || 0 : 0,
        ncm_id_text: provider === "netease" ? idText : "",
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
      let provider = String(url.searchParams.get("provider") || "").toLowerCase();
      let idText = String(url.searchParams.get("id") || url.searchParams.get("ncm_id") || "");
      if (!provider && url.searchParams.has("ncm_id")) provider = "netease";
      let coverUrl = "";
      let referer = "https://music.163.com/";
      if (provider === "qq" || provider === "qqmusic") {
        provider = "qqmusic";
        coverUrl = qqCoverUrl(idText);
        referer = "https://y.qq.com/";
      } else {
        const ncmId = Number(idText) || 0;
        const meta = await fetchNeteaseMeta(ncmId);
        coverUrl = meta.cover_url || "";
      }
      if (!coverUrl) {
        sendJson(res, 404, { ok: false, error: "cover not found" });
        return;
      }
      const image = await fetchBuffer(coverUrl, { referer });
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
  process.stdout.write("Lyrics: InfLink NCM-{id} -> NetEase, QQ Music SMTC -> QQ Music API\n");
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
