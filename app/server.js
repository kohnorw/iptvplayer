# Optimized Ultra-Low-Latency IPTV/SiriusXM FFmpeg Server Rewrite

```js
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { spawn, spawnSync } = require("child_process");
const os = require("os");

const app = express();

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../data");
const XC_HOST = (process.env.XC_HOST || "http://192.168.1.124:3000").replace(/\/+$/, "");
const HLS_DIR = path.join(os.tmpdir(), "iptv-hls");

[DATA_DIR, HLS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.use(express.json({ limit: "10mb" }));

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const UA_MAP = {
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  vlc: "VLC/3.0.20 LibVLC/3.0.20",
  tivimate: "TiviMate/4.7.0",
};

const UNSUPPORTED_AUDIO = [
  "ac3",
  "eac3",
  "mp2",
  "dts",
  "truehd",
  "mlp",
  "pcm",
];

let CFG = {
  ua: UA_MAP.chrome,

  // Ultra low latency defaults
  segSecs: 1,
  prebuf: 1,
  window: 6,
  idle: 20000,

  hlsBuf: 8,
  liveSync: 1,
  stallDelay: 2,

  // Audio
  forceAac: false,
  audioBr: 192,
  audioSr: 48000,
  audioPrebuf: 1,
  aresample: true,

  // Safari
  safariTranscode: true,
  safariProfile: "baseline",
  safariPreset: "ultrafast",
  safariVbr: 0,

  // FFmpeg
  ffmpegInput: [],
  ffmpegExtra: [],
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function userFile(u, type) {
  return path.join(
    DATA_DIR,
    `${type}_${u.replace(/[^a-zA-Z0-9_\-.]/g, "_")}.json`
  );
}

function readUser(u, type, def) {
  try {
    return JSON.parse(fs.readFileSync(userFile(u, type), "utf8"));
  } catch (_) {
    return def;
  }
}

function writeUser(u, type, data) {
  fs.writeFileSync(userFile(u, type), JSON.stringify(data));
}

async function xcFetch(url, ms = 15000) {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const lib = p.protocol === "https:" ? https : http;

    const req = lib.request({
      hostname: p.hostname,
      port: p.port || (p.protocol === "https:" ? 443 : 80),
      path: p.pathname + p.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    }, res => {
      let body = "";

      res.on("data", c => body += c);

      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          reject(new Error(`Non-JSON HTTP ${res.statusCode}`));
        }
      });
    });

    req.on("error", reject);

    req.setTimeout(ms, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });

    req.end();
  });
}

function buildXcUrl(username, password, action, extra = {}) {
  const url = new URL(`${XC_HOST}/player_api.php`);

  url.searchParams.set("username", username);
  url.searchParams.set("password", password);

  if (action) {
    url.searchParams.set("action", action);
  }

  for (const [k, v] of Object.entries(extra)) {
    url.searchParams.set(k, v);
  }

  return url.toString();
}

function segCount(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith(".ts")).length;
  } catch (_) {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// PROBE CACHE
// ─────────────────────────────────────────────────────────────

const probeCache = new Map();
const PROBE_TTL = 300000;

function probeStream(url) {
  const hit = probeCache.get(url);

  if (hit && (Date.now() - hit.ts < PROBE_TTL)) {
    return hit;
  }

  const result = {
    hasVideo: true,
    hasAudio: false,
    audioCodec: "",
    ts: Date.now(),
  };

  try {
    const r = spawnSync("ffprobe", [
      "-v", "error",
      "-user_agent", "Mozilla/5.0",
      "-show_entries", "stream=codec_type,codec_name",
      "-of", "json",
      url,
    ], {
      timeout: 8000,
      encoding: "utf8",
    });

    const data = JSON.parse(r.stdout || "{}");
    const streams = data.streams || [];

    const video = streams.find(s => s.codec_type === "video");
    const audio = streams.find(s => s.codec_type === "audio");

    result.hasVideo = !!video;
    result.hasAudio = !!audio;
    result.audioCodec = audio ? (audio.codec_name || "").toLowerCase() : "";
    result.ts = Date.now();

  } catch (_) {}

  probeCache.set(url, result);
  return result;
}

// ─────────────────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────

const sessions = new Map();

function killSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;

  s.dead = true;

  clearTimeout(s.idleTimer);
  clearInterval(s.watchdog);

  try {
    s.ff.kill("SIGKILL");
  } catch (_) {}

  try {
    if (fs.existsSync(s.dir)) {
      fs.readdirSync(s.dir).forEach(f => {
        try {
          fs.unlinkSync(path.join(s.dir, f));
        } catch (_) {}
      });

      fs.rmdirSync(s.dir);
    }
  } catch (_) {}

  sessions.delete(sid);
}

function resetIdle(sid) {
  const s = sessions.get(sid);
  if (!s) return;

  clearTimeout(s.idleTimer);

  s.idleTimer = setTimeout(() => {
    killSession(sid);
  }, CFG.idle);
}

// ─────────────────────────────────────────────────────────────
// FFMPEG
// ─────────────────────────────────────────────────────────────

function spawnFfmpeg(xcUrl, needsTranscode, safari, audioOnly, dir, m3u8, startNum) {

  const audioFilter = (
    audioOnly && CFG.aresample
  )
    ? [
        "-af",
        "aresample=async=1:min_hard_comp=0.100:first_pts=0"
      ]
    : [];

  let codecArgs;

  // Safari full transcode
  if (needsTranscode && safari) {

    const vbrArgs = CFG.safariVbr > 0
      ? ["-b:v", `${CFG.safariVbr}k`]
      : [];

    codecArgs = [
      "-c:v", "libx264",
      "-profile:v", CFG.safariProfile,
      "-preset", CFG.safariPreset,
      "-tune", "zerolatency",
      "-movflags", "+faststart",

      ...vbrArgs,

      "-c:a", "aac",
      "-b:a", `${CFG.audioBr}k`,
      "-ar", String(CFG.audioSr),
      "-ac", "2",

      ...audioFilter,
    ];

  } else if (needsTranscode || CFG.forceAac) {

    if (audioOnly) {

      codecArgs = [
        "-vn",

        "-c:a", "aac",
        "-b:a", `${CFG.audioBr}k`,
        "-ar", String(CFG.audioSr),
        "-ac", "2",

        ...audioFilter,
      ];

    } else {

      codecArgs = [
        "-c:v", "copy",

        "-c:a", "aac",
        "-b:a", `${CFG.audioBr}k`,
        "-ar", String(CFG.audioSr),
        "-ac", "2",

        ...audioFilter,
      ];
    }

  } else {

    codecArgs = audioOnly
      ? ["-vn", "-c:a", "copy"]
      : ["-c:v", "copy", "-c:a", "copy"];
  }

  return spawn("ffmpeg", [

    "-hide_banner",
    "-loglevel", "error",

    // Reconnect logic
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "2",

    // Ultra-low-latency
    "-fflags", "nobuffer+genpts+discardcorrupt",
    "-flags", "low_delay",
    "-max_delay", "0",

    // Faster startup
    "-analyzeduration", "0",
    "-probesize", "32768",

    // Better queueing
    "-thread_queue_size", "8192",

    // Timeouts
    "-rw_timeout", "15000000",

    // User agent
    "-user_agent", CFG.ua,

    ...CFG.ffmpegInput,

    "-i", xcUrl,

    ...(audioOnly
      ? ["-map", "0:a:0"]
      : ["-map", "0:v?", "-map", "0:a?"]
    ),

    ...codecArgs,

    ...CFG.ffmpegExtra,

    "-f", "hls",

    // Tiny segments
    "-hls_time", audioOnly ? "1" : String(CFG.segSecs),

    // Tiny playlist
    "-hls_list_size", audioOnly ? "3" : String(CFG.window),

    "-hls_delete_threshold", "1",

    "-hls_flags",
    "delete_segments+append_list+omit_endlist+independent_segments",

    "-hls_allow_cache", "0",

    "-hls_segment_type", "mpegts",

    "-hls_segment_filename",
    path.join(dir, "seg%06d.ts"),

    "-start_number",
    String(startNum || 0),

    m3u8,

  ]);
}

// ─────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────

app.post("/api/login", async (req, res) => {

  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      error: "username and password required"
    });
  }

  try {

    const d = await xcFetch(
      buildXcUrl(username, password, null)
    );

    if (d.user_info && d.user_info.auth == 1) {

      return res.json({
        ok: true,
        status: d.user_info.status,
        expiry: d.user_info.exp_date,
        connections: `${d.user_info.active_cons}/${d.user_info.max_connections}`,
      });
    }

    return res.status(401).json({
      error: "Invalid username or password"
    });

  } catch (e) {

    return res.status(502).json({
      error: "Cannot reach server: " + e.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// STREAM START
// ─────────────────────────────────────────────────────────────

app.post("/api/stream/start", (req, res) => {

  const {
    username,
    password,
    streamId,
    sessionId: oldSid,
    safari,
  } = req.body || {};

  if (!username || !password || !streamId) {
    return res.status(400).json({ error: "Missing params" });
  }

  if (oldSid) {
    killSession(oldSid);
  }

  const sid =
    Date.now().toString(36) +
    Math.random().toString(36).slice(2);

  const dir = path.join(HLS_DIR, sid);
  const m3u8 = path.join(dir, "index.m3u8");

  fs.mkdirSync(dir, { recursive: true });

  const urlTs =
    `${XC_HOST}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.ts`;

  const urlM3u8 =
    `${XC_HOST}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.m3u8`;

  let probe = probeStream(urlTs);

  const xcUrl = (
    probe.hasVideo || probe.hasAudio
  )
    ? urlTs
    : urlM3u8;

  if (xcUrl === urlM3u8) {
    probe = probeStream(urlM3u8);
  }

  const audioOnly = probe.hasAudio && !probe.hasVideo;

  const needsTranscode = (
    (safari && CFG.safariTranscode) ||
    CFG.forceAac ||
    UNSUPPORTED_AUDIO.some(c => probe.audioCodec.includes(c))
  );

  console.log(
    `[stream] ${sid.slice(0, 8)} → ${streamId} ` +
    `audio=${probe.audioCodec || "?"} ` +
    `transcode=${needsTranscode} ` +
    `${audioOnly ? "[audio-only]" : ""}`
  );

  const IGNORE_RE = /frame size not set|PES packet|Packet corrupt|non monotonous|non-existing SPS|non-existing PPS|no frame!|Could not find ref|Error constructing/i;

  let ff = spawnFfmpeg(
    xcUrl,
    needsTranscode,
    safari,
    audioOnly,
    dir,
    m3u8,
    0
  );

  ff.stderr.on("data", d => {
    const m = d.toString().trim();

    if (m && !IGNORE_RE.test(m)) {
      console.error(`[ff:${sid.slice(0,8)}]`, m);
    }
  });

  const handleClose = () => {

    const s = sessions.get(sid);

    if (!s || s.dead) {
      return;
    }

    const next = segCount(dir);

    ff = spawnFfmpeg(
      xcUrl,
      needsTranscode,
      safari,
      audioOnly,
      dir,
      m3u8,
      next
    );

    ff.stderr.on("data", d => {
      const m = d.toString().trim();

      if (m && !IGNORE_RE.test(m)) {
        console.error(`[ff:${sid.slice(0,8)}]`, m);
      }
    });

    ff.on("close", handleClose);

    s.ff = ff;
  };

  ff.on("close", handleClose);

  // Watchdog
  let lastSeg = 0;
  let lastTime = Date.now();
  let watchdogActive = false;

  const watchdog = setInterval(() => {

    const s = sessions.get(sid);

    if (!s || s.dead) {
      clearInterval(watchdog);
      return;
    }

    const n = segCount(dir);

    if (n > lastSeg) {

      lastSeg = n;
      lastTime = Date.now();

      if (n >= (audioOnly ? CFG.audioPrebuf : CFG.prebuf)) {
        watchdogActive = true;
      }

    } else if (
      watchdogActive &&
      Date.now() - lastTime > 4000
    ) {

      lastTime = Date.now();

      try {
        s.ff.kill("SIGKILL");
      } catch (_) {}
    }

  }, 1000);

  const idleTimer = setTimeout(() => {
    killSession(sid);
  }, CFG.idle);

  sessions.set(sid, {
    ff,
    dir,
    idleTimer,
    watchdog,
    dead: false,
  });

  const t0 = Date.now();

  const poll = setInterval(() => {

    if (!sessions.has(sid)) {

      clearInterval(poll);

      if (!res.headersSent) {
        res.status(502).json({ error: "Stream failed" });
      }

      return;
    }

    const needed = audioOnly
      ? CFG.audioPrebuf
      : CFG.prebuf;

    if (
      segCount(dir) >= needed &&
      fs.existsSync(m3u8) &&
      fs.statSync(m3u8).size > 0
    ) {

      clearInterval(poll);

      res.json({
        ok: true,
        sessionId: sid,
        url: `/hls/${sid}/index.m3u8`,
        audioOnly,
        hlsCfg: {
          maxBufferLength: CFG.hlsBuf,
          liveSyncDurationCount: CFG.liveSync,
          maxStarvationDelay: CFG.stallDelay,
        },
      });

    } else if (Date.now() - t0 > 25000) {

      clearInterval(poll);

      killSession(sid);

      if (!res.headersSent) {
        res.status(504).json({
          error: "Stream timed out"
        });
      }
    }

  }, 300);
});

// ─────────────────────────────────────────────────────────────
// HEARTBEAT
// ─────────────────────────────────────────────────────────────

app.post("/api/stream/heartbeat/:sid", (req, res) => {

  if (!sessions.has(req.params.sid)) {
    return res.status(404).json({
      error: "Session gone"
    });
  }

  resetIdle(req.params.sid);

  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// STOP STREAM
// ─────────────────────────────────────────────────────────────

app.post("/api/stream/stop/:sid", (req, res) => {
  killSession(req.params.sid);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// HLS SERVING
// ─────────────────────────────────────────────────────────────

app.get("/hls/:sid/:file", (req, res) => {

  const { sid, file } = req.params;

  const fp = path.join(HLS_DIR, sid, file);

  if (!fs.existsSync(fp)) {
    return res.status(404).send("Not found");
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (file.endsWith(".m3u8")) {

    res.setHeader(
      "Content-Type",
      "application/vnd.apple.mpegurl"
    );

    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Pragma", "no-cache");

    try {

      const raw = fs.readFileSync(fp, "utf8");

      const out = raw
        .split("\n")
        .map(l => {
          const t = l.trim();

          return (
            t &&
            !t.startsWith("#") &&
            t.endsWith(".ts")
          )
            ? `/hls/${sid}/${t}`
            : l;
        })
        .join("\n");

      res.send(out);

    } catch (_) {
      res.status(500).end();
    }

  } else {

    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Cache-Control", "no-cache");

    try {
      const stat = fs.statSync(fp);
      res.setHeader("Content-Length", stat.size);
    } catch (_) {}

    res.sendFile(fp);
  }
});

// ─────────────────────────────────────────────────────────────
// STATIC
// ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "../static")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../static/index.html"));
});

// ─────────────────────────────────────────────────────────────
// SHUTDOWN
// ─────────────────────────────────────────────────────────────

process.on("SIGTERM", () => {

  sessions.forEach((_, sid) => {
    killSession(sid);
  });

  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Ultra-low-latency stream server :${PORT}`);
});
```