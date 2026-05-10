"use strict";

const express              = require("express");
const path                 = require("path");
const fs                   = require("fs");
const http                 = require("http");
const https                = require("https");
const { spawn, spawnSync } = require("child_process");
const os                   = require("os");

const app      = express();
const PORT     = process.env.PORT     || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../data");
const XC_HOST  = (process.env.XC_HOST || "http://192.168.1.124:3000").replace(/\/+$/, "");
const HLS_DIR  = path.join(os.tmpdir(), "iptv-hls");

[DATA_DIR, HLS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
app.use(express.json({ limit: "10mb" }));

const SEG_SECS    = 2;
const PREBUF_SEGS = 8;
const WINDOW_SEGS = 60;
const IDLE_MS     = 20000;

// ── Per-user data ─────────────────────────────────────────────────
function userFile(u, type) {
  return path.join(DATA_DIR, `${type}_${u.replace(/[^a-zA-Z0-9_\-\.]/g,"_")}.json`);
}
function readUser(u, type, def) {
  try { return JSON.parse(fs.readFileSync(userFile(u,type),"utf8")); } catch(_){ return def; }
}
function writeUser(u, type, d) { fs.writeFileSync(userFile(u,type), JSON.stringify(d)); }

// ── XC fetch ──────────────────────────────────────────────────────
async function xcFetch(url, ms=15000) {
  return new Promise((resolve, reject) => {
    const p   = new URL(url);
    const lib = p.protocol==="https:" ? https : http;
    const req = lib.request({
      hostname: p.hostname, port: p.port||(p.protocol==="https:"?443:80),
      path: p.pathname+p.search, method: "GET",
      headers: {"User-Agent":"Mozilla/5.0"},
    }, res => {
      let body="";
      res.on("data",c=>body+=c);
      res.on("end",()=>{ try{resolve(JSON.parse(body));}catch(_){reject(new Error(`Non-JSON HTTP ${res.statusCode}`));} });
    });
    req.on("error",reject);
    req.setTimeout(ms,()=>{ req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function buildXcUrl(u,p,action,extra={}) {
  const url=new URL(`${XC_HOST}/player_api.php`);
  url.searchParams.set("username",u); url.searchParams.set("password",p);
  if (action) url.searchParams.set("action",action);
  for (const [k,v] of Object.entries(extra)) url.searchParams.set(k,v);
  return url.toString();
}

// ── Auth ──────────────────────────────────────────────────────────
app.post("/api/login", async (req,res) => {
  const {username,password}=req.body||{};
  if (!username||!password) return res.status(400).json({error:"username and password required"});
  try {
    const d=await xcFetch(buildXcUrl(username,password,null));
    if (d.user_info&&d.user_info.auth==1) {
      res.json({ok:true,status:d.user_info.status,expiry:d.user_info.exp_date,
        connections:`${d.user_info.active_cons}/${d.user_info.max_connections}`});
    } else { res.status(401).json({error:"Invalid username or password"}); }
  } catch(e){ res.status(502).json({error:"Cannot reach server: "+e.message}); }
});

// ── XC API proxy ──────────────────────────────────────────────────
const ALLOWED=new Set(["get_live_categories","get_live_streams","get_vod_categories","get_vod_streams","get_short_epg","get_epg"]);
app.get("/api/xc/:action", async (req,res) => {
  const {username,password}=req.query;
  if (!username||!password) return res.status(401).json({error:"Missing credentials"});
  const {action}=req.params;
  if (!ALLOWED.has(action)) return res.status(403).json({error:"Not allowed"});
  const extra={};
  for (const [k,v] of Object.entries(req.query)) if (k!=="username"&&k!=="password") extra[k]=v;
  try { res.json(await xcFetch(buildXcUrl(username,password,action,extra))); }
  catch(e){ res.status(502).json({error:e.message}); }
});

app.get("/api/epg/:streamId", async (req,res) => {
  const {username,password}=req.query;
  if (!username||!password) return res.status(401).json({error:"Missing credentials"});
  try { res.json(await xcFetch(buildXcUrl(username,password,"get_short_epg",{stream_id:req.params.streamId,limit:8}))); }
  catch(_){ res.json({epg_listings:[]}); }
});

// ── Favourites + Prefs ────────────────────────────────────────────
app.get("/api/favs/:u",  (req,res)=>res.json(readUser(req.params.u.trim(),"favs",[])));
app.post("/api/favs/:u", (req,res)=>{ writeUser(req.params.u.trim(),"favs",Array.isArray(req.body)?req.body:[]); res.json({ok:true}); });
app.get("/api/prefs/:u",  (req,res)=>res.json(readUser(req.params.u.trim(),"prefs",{timezone:"America/Toronto"})));
app.post("/api/prefs/:u", (req,res)=>{ writeUser(req.params.u.trim(),"prefs",req.body||{}); res.json({ok:true}); });

// ── Stream detection ──────────────────────────────────────────────
function detectStream(url) {
  try {
    const r=spawnSync("ffprobe",[
      "-v","error","-user_agent","Mozilla/5.0",
      "-show_entries","stream=codec_type",
      "-of","default=noprint_wrappers=1:nokey=1", url,
    ],{timeout:6000,encoding:"utf8"});
    const out=(r.stdout||"").toLowerCase();
    return { hasVideo:out.includes("video"), hasAudio:out.includes("audio") };
  } catch(_){ return {hasVideo:true,hasAudio:false}; } // safe default - don't assume audio
}

// ── Session management ────────────────────────────────────────────
const sessions = new Map();

function segCount(dir) {
  try { return fs.readdirSync(dir).filter(f=>f.endsWith(".ts")).length; } catch(_){ return 0; }
}

function killSession(sid) {
  const s=sessions.get(sid); if (!s) return;
  s.dead=true;
  clearTimeout(s.idleTimer);
  clearInterval(s.watchdog);
  try{s.ff.kill("SIGKILL");}catch(_){}
  try{
    if (fs.existsSync(s.dir)) {
      fs.readdirSync(s.dir).forEach(f=>{try{fs.unlinkSync(path.join(s.dir,f));}catch(_){}});
      fs.rmdirSync(s.dir);
    }
  } catch(_){}
  sessions.delete(sid);
}

function resetIdle(sid) {
  const s=sessions.get(sid); if (!s) return;
  clearTimeout(s.idleTimer);
  s.idleTimer=setTimeout(()=>killSession(sid),IDLE_MS);
}

// ── ffmpeg → HLS segments ─────────────────────────────────────────
function spawnFfmpeg(xcUrl, info, dir, m3u8, startNum=0) {
  return spawn("ffmpeg",[
    "-loglevel",   "error",
    "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "-i",          xcUrl,
    // Optional mappings — ? means don't fail if stream doesn't exist
    "-map",        "0:v?",   // video if present
    "-map",        "0:a?",   // audio if present
    "-c:v",        "copy",
    "-c:a",        "aac","-b:a","192k","-ar","48000","-ac","2",
    "-fflags",     "+genpts+discardcorrupt+nobuffer",
    "-f",          "hls",
    "-hls_time",   String(SEG_SECS),
    "-hls_list_size", String(WINDOW_SEGS),
    "-hls_flags",  "delete_segments+append_list+omit_endlist+independent_segments",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", path.join(dir,"seg%06d.ts"),
    "-start_number", String(startNum),
    m3u8,
  ]);
}

// ── Start stream ──────────────────────────────────────────────────
app.post("/api/stream/start", (req,res) => {
  const {username,password,streamId,sessionId:old}=req.body||{};
  if (!username||!password||!streamId) return res.status(400).json({error:"Missing params"});

  if (old) killSession(old);

  const sid  = Date.now().toString(36)+Math.random().toString(36).slice(2);
  const dir  = path.join(HLS_DIR,sid);
  const m3u8 = path.join(dir,"index.m3u8");
  fs.mkdirSync(dir,{recursive:true});

  const urlTs   = `${XC_HOST}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.ts`;
  const urlM3u8 = `${XC_HOST}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.m3u8`;

  let info = detectStream(urlTs);
  const xcUrl = (info.hasVideo||info.hasAudio) ? urlTs : urlM3u8;
  if (xcUrl===urlM3u8) info = detectStream(urlM3u8);

  console.log(`[stream] ${sid.slice(0,8)} → ${streamId} video=${info.hasVideo} audio=${info.hasAudio}`);

  const IGNORE_RE = /frame size not set|PES packet size|Packet corrupt|Last message repeated|non monotonous|non-existing SPS|non-existing PPS|no frame!|Could not find ref|Error constructing/i;

  let ff = spawnFfmpeg(xcUrl, info, dir, m3u8);

  ff.stderr.on("data",d=>{
    const m=d.toString().trim();
    if (m&&!IGNORE_RE.test(m)) console.error(`[ff:${sid.slice(0,8)}]`,m);
  });

  const handleClose = (code) => {
    const s=sessions.get(sid);
    if (!s||s.dead) return;
    const next=segCount(dir);
    ff=spawnFfmpeg(xcUrl,info,dir,m3u8,next);
    ff.stderr.on("data",d=>{const m=d.toString().trim();if(m&&!IGNORE_RE.test(m))console.error(`[ff:${sid.slice(0,8)}]`,m);});
    ff.on("close",handleClose);
    s.ff=ff;
  };
  ff.on("close",handleClose);
  ff.on("error",err=>console.error("[ff] spawn:",err.message));

  let lastSeg=0,lastTime=Date.now(),watchdogActive=false;
  const watchdog=setInterval(()=>{
    const s=sessions.get(sid); if(!s||s.dead){clearInterval(watchdog);return;}
    const n=segCount(dir);
    if(n>lastSeg){lastSeg=n;lastTime=Date.now();if(n>=PREBUF_SEGS)watchdogActive=true;}
    else if(watchdogActive&&Date.now()-lastTime>10000){lastTime=Date.now();try{s.ff.kill("SIGKILL");}catch(_){}}
  },2000);

  const idleTimer=setTimeout(()=>killSession(sid),IDLE_MS);
  sessions.set(sid,{ff,dir,idleTimer,watchdog,dead:false});

  const t0=Date.now();
  const poll=setInterval(()=>{
    if(!sessions.has(sid)){clearInterval(poll);if(!res.headersSent)res.status(502).json({error:"Stream failed"});return;}
    if(segCount(dir)>=PREBUF_SEGS&&fs.existsSync(m3u8)&&fs.statSync(m3u8).size>0){
      clearInterval(poll);
      console.log(`[stream] ${sid.slice(0,8)} ready`);
      res.json({ok:true,sessionId:sid,url:`/hls/${sid}/index.m3u8`,audioOnly:!info.hasVideo});
    } else if(Date.now()-t0>25000){
      clearInterval(poll);
      killSession(sid);
      if(!res.headersSent)res.status(504).json({error:"Stream timed out"});
    }
  },300);
});

app.post("/api/stream/heartbeat/:sid",(req,res)=>{
  if(!sessions.has(req.params.sid)) return res.status(404).json({error:"Session gone"});
  resetIdle(req.params.sid);
  res.json({ok:true});
});

app.post("/api/stream/stop/:sid",(req,res)=>{
  killSession(req.params.sid);
  res.json({ok:true});
});

// ── HLS serving ───────────────────────────────────────────────────
app.get("/hls/:sid/:file",(req,res)=>{
  const {sid,file}=req.params;
  const fp=path.join(HLS_DIR,sid,file);
  if(!fs.existsSync(fp)) return res.status(404).send("Not found");
  res.setHeader("Access-Control-Allow-Origin","*");
  if(file.endsWith(".m3u8")){
    res.setHeader("Content-Type","application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control","no-cache,no-store,must-revalidate");
    try{
      const raw=fs.readFileSync(fp,"utf8");
      res.send(raw.replace(/^(seg\d+\.ts)$/mg,`/hls/${sid}/$1`));
    }catch(_){res.status(500).end();}
  } else {
    res.setHeader("Content-Type","video/mp2t");
    res.setHeader("Cache-Control","public,max-age=10");
    res.sendFile(fp);
  }
});

// ── Logo proxy ────────────────────────────────────────────────────
app.get("/logo",async(req,res)=>{
  const url=req.query.url;
  if(!url||!/^https?:\/\//i.test(url)) return res.status(400).end();
  try{
    const p=new URL(url),lib=p.protocol==="https:"?https:http;
    const preq=lib.request({hostname:p.hostname,port:p.port||(p.protocol==="https:"?443:80),
      path:p.pathname+p.search,method:"GET",
      headers:{"User-Agent":"Mozilla/5.0","Referer":p.origin,"Accept":"image/*,*/*"}},
      pres=>{
        res.setHeader("Content-Type",pres.headers["content-type"]||"image/png");
        res.setHeader("Cache-Control","public,max-age=86400");
        res.setHeader("Access-Control-Allow-Origin","*");
        pres.pipe(res,{end:true});
      });
    preq.on("error",()=>res.status(502).end());
    preq.setTimeout(5000,()=>{preq.destroy();res.status(504).end();});
    preq.end();
  }catch(_){res.status(400).end();}
});

// ── Static + SPA ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname,"../static")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"../static/index.html")));
process.on("SIGTERM",()=>{sessions.forEach((_,sid)=>killSession(sid));process.exit(0);});
app.listen(PORT,()=>console.log(`Stream :${PORT}  XC: ${XC_HOST}`));
