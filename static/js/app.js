"use strict";

const P = { sessionId:null, lastSessionId:null, heartbeat:null };
const S = {
  username:"", password:"",
  categories:[], channels:[], filtered:[],
  currentChannel:null, favourites:[],
  epgCache:{}, guideData:[],
  hlsInstance:null,
  prefs:{ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" },
};

const $    = id => document.getElementById(id);
const esc  = s  => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const b64 = s => {
  if (!s) return s;
  try {
    // Decode base64, then decode as UTF-8 to handle accented/special characters
    return decodeURIComponent(atob(s).split("").map(ch=>"%" + ch.charCodeAt(0).toString(16).padStart(2,"0")).join(""));
  } catch(_) {
    try { return atob(s); } catch(_) { return s; }
  }
};
const mob  = ()  => window.innerWidth <= 700;

function creds() { return `username=${encodeURIComponent(S.username)}&password=${encodeURIComponent(S.password)}`; }

function fmtTime(utcStr) {
  if (!utcStr) return "";
  try {
    // Handle "2026-05-10 18:00:00" or ISO format or numeric timestamp
    let d;
    if (typeof utcStr === "number") d = new Date(utcStr * 1000);
    else d = new Date(utcStr.replace(" ","T") + (utcStr.includes("Z") || utcStr.includes("+") ? "" : "Z"));
    return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",timeZone:S.prefs.timezone,hour12:false});
  } catch(_){ return String(utcStr).slice(11,16); }
}

function logoUrl(url) {
  if (!url) return null;
  return `/logo?url=${encodeURIComponent(url)}`;
}

async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok){ const e=await r.json().catch(()=>{}); throw new Error((e&&e.error)||`Error ${r.status}`); }
  return r.json();
}
async function xcGet(action, extra={}) {
  let url=`/api/xc/${action}?${creds()}`;
  for (const [k,v] of Object.entries(extra)) url+=`&${k}=${encodeURIComponent(v)}`;
  return apiGet(url);
}

// ── Boot ──────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  populateTimezones();
  showScreen("login");
});

function showScreen(n) {
  $("login-screen").classList.toggle("active", n==="login");
  $("app-screen").classList.toggle("active",   n==="app");
}
function showLoading(){ $("loading-overlay").classList.remove("hidden"); }
function hideLoading(){ $("loading-overlay").classList.add("hidden"); }
function setProgress(pct,msg,detail){
  $("progress-bar").style.width=pct+"%";
  if (msg!==undefined)    $("load-msg").textContent=msg;
  if (detail!==undefined) $("load-detail").textContent=detail||"\u00a0";
}

// ── Events ────────────────────────────────────────────────────────
function bindEvents() {
  $("btn-login").addEventListener("click", doLogin);
  ["inp-user","inp-pass"].forEach(id=>$(id).addEventListener("keydown",e=>e.key==="Enter"&&doLogin()));
  $("btn-logout").addEventListener("click", doLogout);

  // Desktop nav buttons
  document.querySelectorAll(".nav-btn").forEach(b=>b.addEventListener("click",()=>{
    document.querySelectorAll(".nav-btn").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    openTab(b.dataset.tab);
  }));

  // Desktop search
  const si=$("search-input");
  if (si) si.addEventListener("input",e=>filterChannels(e.target.value));

  // Mobile search
  const ms=$("mobile-search-input");
  if (ms) ms.addEventListener("input",e=>filterChannels(e.target.value));

  $("btn-fav").addEventListener("click", toggleFav);
  $("guide-search").addEventListener("input",e=>filterGuide(e.target.value));
  window.addEventListener("beforeunload",()=>stopStream());
}

// ── Tabs ──────────────────────────────────────────────────────────
function openTab(tab) {
  // Close all overlays
  ["favourites","guide","settings"].forEach(t=>$(`tab-${t}`)?.classList.add("hidden"));

  if (tab==="live") {
    // Desktop: already on live, nothing to do
    // Mobile: go to channels view
    if (mob()) setMobileView("channels");
    return;
  }

  // Open the requested tab overlay
  const el = $(`tab-${tab}`);
  if (el) el.classList.remove("hidden");

  if (tab==="favourites") renderFavourites();
  if (tab==="guide")      loadGuide();
  if (tab==="settings")   loadSettingsTab();

  // Mobile: show channels pane beneath the overlay
  if (mob()) setMobileView("channels");
}

function closeTab(tab) {
  $(`tab-${tab}`)?.classList.add("hidden");
  // Reset nav to live/channels
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.tab==="live"));
  document.querySelectorAll(".bnav-btn").forEach(b=>b.classList.toggle("active",b.dataset.view==="channels"));
}
window.closeTab=closeTab;

// ── Mobile view switching ─────────────────────────────────────────
function setMobileView(view) {
  const body=$("app-body");
  if (!body) return;
  body.classList.remove("view-channels","view-player");
  body.classList.add(view==="player"?"view-player":"view-channels");
}

function mobileNav(view) {
  // Update bottom nav active state
  document.querySelectorAll(".bnav-btn").forEach(b=>b.classList.toggle("active",b.dataset.view===view));

  if (view==="channels") {
    // Close any overlays, show channel list
    ["favourites","guide","settings"].forEach(t=>$(`tab-${t}`)?.classList.add("hidden"));
    document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.tab==="live"));
    setMobileView("channels");
  } else if (view==="player") {
    ["favourites","guide","settings"].forEach(t=>$(`tab-${t}`)?.classList.add("hidden"));
    setMobileView("player");
  } else {
    // Guide, Favourites, Settings — show as overlay on top of channels
    setMobileView("channels");
    openTabOverlayOnly(view);
  }
}
window.mobileNav=mobileNav;

// Open overlay without triggering mobile view switch (called from mobileNav)
function openTabOverlayOnly(tab) {
  ["favourites","guide","settings"].forEach(t=>$(`tab-${t}`)?.classList.add("hidden"));
  const el=$(`tab-${tab}`);
  if (el) el.classList.remove("hidden");
  if (tab==="favourites") renderFavourites();
  if (tab==="guide")      loadGuide();
  if (tab==="settings")   loadSettingsTab();
}

// ── Login ─────────────────────────────────────────────────────────
async function doLogin() {
  const username=$("inp-user").value.trim(), password=$("inp-pass").value.trim();
  const errEl=$("login-error"), btn=$("btn-login");
  if (!username||!password){errEl.textContent="Fill in all fields.";errEl.classList.remove("hidden");return;}
  btn.disabled=true; btn.textContent="Connecting…";
  errEl.classList.add("hidden"); showLoading(); setProgress(5,"Authenticating…","");
  try {
    const auth=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({username,password})}).then(r=>r.json());
    if (!auth.ok) throw new Error(auth.error||"Login failed");
    S.username=username; S.password=password;

    setProgress(15,"Loading preferences…","");
    const prefs=await fetch(`/api/prefs/${encodeURIComponent(username)}`).then(r=>r.json()).catch(()=>({}));
    S.prefs={...S.prefs,...prefs};

    setProgress(30,"Fetching categories…","");
    S.categories=await xcGet("get_live_categories")||[];

    setProgress(60,"Fetching channels…",`${S.categories.length} categories`);
    S.channels=await xcGet("get_live_streams")||[];
    S.filtered=S.channels;

    setProgress(80,"Loading favourites…","");
    S.favourites=await fetch(`/api/favs/${encodeURIComponent(username)}`).then(r=>r.json()).catch(()=>[]);

    setProgress(100,`Ready — ${S.channels.length} channels`,"");
    await new Promise(r=>setTimeout(r,300));
    hideLoading(); showScreen("app");
    renderCategories(); renderChannels(S.channels);

    // Fetch EPG for all channels in background after UI is shown
    fetchAllEpg();

    // Mobile starts on channels view
    if (mob()) setMobileView("channels");
  } catch(err){
    hideLoading(); errEl.textContent=err.message; errEl.classList.remove("hidden");
    S.username=""; S.password="";
  } finally { btn.disabled=false; btn.textContent="Connect"; }
}

function doLogout(){
  stopStream();
  S.username=""; S.password=""; S.categories=[]; S.channels=[]; S.filtered=[];
  S.currentChannel=null; S.epgCache={}; S.guideData=[]; S.favourites=[];
  $("inp-user").value=""; $("inp-pass").value="";
  $("login-error").classList.add("hidden");
  showScreen("login");
}

// ── Categories ────────────────────────────────────────────────────
function renderCategories(){
  const list=$("category-list"); list.innerHTML="";
  const all=makeCatEl({category_id:"all",category_name:"All Channels"});
  all.classList.add("active"); list.appendChild(all);
  S.categories.forEach(c=>list.appendChild(makeCatEl(c)));
}
function makeCatEl(cat){
  const el=document.createElement("div"); el.className="cat-item";
  el.innerHTML=`<span class="cat-dot"></span>${esc(cat.category_name)}`;
  el.addEventListener("click",()=>{
    document.querySelectorAll(".cat-item").forEach(c=>c.classList.remove("active"));
    el.classList.add("active");
    S.filtered=cat.category_id==="all"?S.channels:S.channels.filter(c=>String(c.category_id)===String(cat.category_id));
    renderChannels(S.filtered);
    $("search-input")&&($("search-input").value="");
    $("mobile-search-input")&&($("mobile-search-input").value="");
  });
  return el;
}

// ── Channels ──────────────────────────────────────────────────────
function renderChannels(list){
  const el=$("channel-list");
  if (!list.length){el.innerHTML='<div class="empty">No channels found</div>';return;}
  el.innerHTML=list.map(ch=>{
    const logo=ch.stream_icon?`<img src="${esc(logoUrl(ch.stream_icon))}" onerror="this.style.display='none'" loading="lazy"/>`:`<span>${esc((ch.name||"?")[0].toUpperCase())}</span>`;
    const active=S.currentChannel?.stream_id==ch.stream_id?" active":"";
    // Show current programme from EPG cache if available
    const epg = S.epgCache[ch.stream_id];
    const now = Date.now()/1000;
    const nowPlaying = epg ? epg.find(ep=>parseInt(ep.start_timestamp||0)<=now&&now<=parseInt(ep.stop_timestamp||0)) : null;
    const nowTitle = nowPlaying ? b64(nowPlaying.title||"").trim() : "";
    return `<div class="ch-item${active}" data-id="${ch.stream_id}">
      <div class="ch-logo">${logo}</div>
      <div class="ch-info">
        <div class="ch-name">${esc(ch.name||"Channel")}</div>
        <div class="ch-num">#${ch.num||ch.stream_id}${nowTitle?` · <span class="ch-now">${esc(nowTitle)}</span>`:""}</div>
      </div>
      <span class="ch-live"></span>
    </div>`;
  }).join("");
  el.querySelectorAll(".ch-item").forEach(el=>{
    el.addEventListener("click", ()=>{
      selectChannel(el.dataset.id);
      if (mob()) {
        setMobileView("player");
        document.querySelectorAll(".bnav-btn").forEach(b=>b.classList.toggle("active",b.dataset.view==="player"));
      }
    });
  });
}
function filterChannels(q){
  q=q.toLowerCase();
  S.filtered=q?S.channels.filter(c=>(c.name||"").toLowerCase().includes(q)):S.channels;
  renderChannels(S.filtered);
  // Sync both search inputs
  if($("search-input")&&$("search-input").value!==q) $("search-input").value=q;
  if($("mobile-search-input")&&$("mobile-search-input").value!==q) $("mobile-search-input").value=q;
}

// ── Player ────────────────────────────────────────────────────────
let _selectDebounce = null;
async function selectChannel(id){
  if (S.currentChannel?.stream_id == id && S.hlsInstance) return;
  clearTimeout(_selectDebounce);
  _selectDebounce = setTimeout(() => _doSelectChannel(id), 150);
}
async function _doSelectChannel(id){
  const ch=S.channels.find(c=>c.stream_id==id)||S.favourites.find(c=>c.stream_id==id);
  if (!ch) return;
  stopStream();
  S.currentChannel=ch;
  document.querySelectorAll(".ch-item").forEach(el=>el.classList.toggle("active",el.dataset.id==id));
  $("player-placeholder").style.display="flex";
  $("player-placeholder").innerHTML=`<span class="ph-icon" style="animation:pulse 1.2s ease-in-out infinite">⏳</span><span>Buffering…</span>`;
  $("video").style.display="none";
  $("now-playing").style.display="flex";
  $("np-name").textContent=ch.name||"";
  $("np-epg").textContent="";
  updateFavBtn();
  try {
    const oldSid=P.lastSessionId; P.lastSessionId=null;
    const r=await fetch("/api/stream/start",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({username:S.username,password:S.password,streamId:ch.stream_id,sessionId:oldSid||null})
    });
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||"Stream failed");
    P.sessionId=d.sessionId; P.lastSessionId=d.sessionId;
    startHeartbeat(d.sessionId);
    if(d.audioOnly){
      $("player-placeholder").style.display="flex";
      $("player-placeholder").innerHTML=`<span class="ph-icon">🎵</span><span>${esc(ch.name||"Audio Stream")}</span>`;
      $("video").style.display="none";
    } else {
      $("player-placeholder").style.display="none";
      $("video").style.display="block";
    }
    playStream(d.url);
  } catch(err){
    $("player-placeholder").innerHTML=`<span class="ph-icon">⚠</span><span>${esc(err.message)}</span>`;
    $("video").style.display="none";
    $("np-epg").textContent="Unavailable";
  }
  loadEpg(ch.stream_id);
}

function playStream(url, audioOnly=false){
  stopHls();
  const vid=$("video"); vid.style.display="block";
  if (Hls.isSupported()){
    const hls=new Hls({
      enableWorker:       true,
      lowLatencyMode:     false,
      // Audio-only streams buffer much more aggressively to prevent pausing
      maxBufferLength:          audioOnly ? 120 : 60,
      maxMaxBufferLength:       audioOnly ? 300 : 120,
      backBufferLength:         audioOnly ?  60 : 30,
      fragLoadingTimeOut:       30000,
      fragLoadingMaxRetry:      audioOnly ? 20 : 10,
      fragLoadingRetryDelay:    500,
      nudgeMaxRetry:            audioOnly ? 40 : 20,
      nudgeOffset:              0.5,
      maxStarvationDelay:       audioOnly ? 30 : 10,
    });
    hls.loadSource(url);
    hls.attachMedia(vid);
    hls.on(Hls.Events.MANIFEST_PARSED, ()=>vid.play().catch(()=>{}));
    hls.on(Hls.Events.ERROR, (_,d)=>{
      if (d.fatal){
        if (d.type===Hls.ErrorTypes.NETWORK_ERROR) setTimeout(()=>hls.startLoad(),2000);
        else if (d.type===Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      }
    });
    S.hlsInstance=hls;
  } else if (vid.canPlayType("video/mp2t")||vid.canPlayType("application/vnd.apple.mpegurl")){
    vid.src=url; vid.play().catch(()=>{});
  }
}

function stopHls(){
  if (S.hlsInstance){S.hlsInstance.destroy();S.hlsInstance=null;}
  const vid=$("video");
  vid.pause(); vid.removeAttribute("src"); vid.load(); vid.style.display="none";
}

function stopStream(){
  stopHls();
  clearInterval(P.heartbeat); P.heartbeat=null;
  if(P.sessionId){
    const sid=P.sessionId; P.lastSessionId=sid; P.sessionId=null;
    fetch(`/api/stream/stop/${sid}`,{method:"POST"}).catch(()=>{});
  }
  $("epg-strip").innerHTML="";
}
function startHeartbeat(sid){
  clearInterval(P.heartbeat);
  P.heartbeat=setInterval(()=>{
    if(P.sessionId===sid) fetch(`/api/stream/heartbeat/${sid}`,{method:"POST"}).catch(()=>{});
    else clearInterval(P.heartbeat);
  },5000);
}

// ── Background EPG fetch for all channels ────────────────────────
async function fetchAllEpg() {
  // Fetch EPG in small batches to avoid hammering the server
  const BATCH = 20;
  const channels = S.channels;
  for (let i = 0; i < channels.length; i += BATCH) {
    const batch = channels.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async ch => {
      if (S.epgCache[ch.stream_id]) return; // already cached
      try {
        const d = await apiGet(`/api/epg/${ch.stream_id}?${creds()}`);
        S.epgCache[ch.stream_id] = d.epg_listings || [];
        // Update channel list item with now-playing if visible
        updateChannelNowPlaying(ch.stream_id);
      } catch(_) {}
    }));
    // Small pause between batches to avoid overwhelming XC-Menu
    await new Promise(r => setTimeout(r, 200));
  }
}

// ── EPG ───────────────────────────────────────────────────────────
async function loadEpg(streamId){
  if (S.epgCache[streamId]){renderEpg(S.epgCache[streamId]);return;}
  try {
    const d=await apiGet(`/api/epg/${streamId}?${creds()}`);
    S.epgCache[streamId]=d.epg_listings||[];
    renderEpg(S.epgCache[streamId]);
    // Update the channel list item to show now playing
    updateChannelNowPlaying(streamId);
  } catch(_){}
}

function updateChannelNowPlaying(streamId) {
  const el = document.querySelector(`.ch-item[data-id="${streamId}"] .ch-num`);
  if (!el) return;
  const epg = S.epgCache[streamId];
  if (!epg) return;
  const now = Date.now()/1000;
  const nowPlaying = epg.find(ep=>parseInt(ep.start_timestamp||0)<=now&&now<=parseInt(ep.stop_timestamp||0));
  const nowTitle = nowPlaying ? b64(nowPlaying.title||"").trim() : "";
  const ch = S.channels.find(c=>c.stream_id==streamId)||S.favourites.find(c=>c.stream_id==streamId);
  el.innerHTML = `#${(ch&&(ch.num||ch.stream_id))||streamId}${nowTitle?` · <span class="ch-now">${esc(nowTitle)}</span>`:""}`;
}
function renderEpg(listings){
  const now=Date.now()/1000;
  $("epg-strip").innerHTML=listings.slice(0,8).map(ep=>{
    const start=parseInt(ep.start_timestamp||0),stop=parseInt(ep.stop_timestamp||0);
    const isNow=start<=now&&now<=stop;
    const startTime=fmtTime(ep.start);
    const stopTime=stop?fmtTime(new Date(stop*1000).toISOString().replace("T"," ").slice(0,19)):"";
    const timeRange=stopTime?`${startTime} – ${stopTime}`:startTime;
    const title=b64(ep.title||"").trim();
    if (isNow) $("np-epg").textContent=`${timeRange}  ${title}`;
    return `<div class="epg-card${isNow?" now":""}">
      <div class="epg-time">${esc(timeRange)}</div>
      <div class="epg-title">${esc(title||"—")}</div>
    </div>`;
  }).join("");
}

// ── Favourites ────────────────────────────────────────────────────
function updateFavBtn(){
  const ch=S.currentChannel; if (!ch) return;
  const isFav=S.favourites.some(f=>f.stream_id==ch.stream_id);
  $("btn-fav").textContent=isFav?"★":"☆";
  $("btn-fav").classList.toggle("active",isFav);
}
function toggleFav(){
  const ch=S.currentChannel; if (!ch) return;
  const idx=S.favourites.findIndex(f=>f.stream_id==ch.stream_id);
  if (idx===-1) S.favourites.push({stream_id:ch.stream_id,name:ch.name,stream_icon:ch.stream_icon,num:ch.num,category_id:ch.category_id});
  else S.favourites.splice(idx,1);
  updateFavBtn();
  fetch(`/api/favs/${encodeURIComponent(S.username)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(S.favourites)});
}
function renderFavourites(){
  const body=$("fav-body");
  if (!S.favourites.length){body.innerHTML='<div class="empty">No favourites yet.<br>Press ☆ while watching a channel.</div>';return;}
  const grid=document.createElement("div"); grid.className="fav-grid";
  grid.innerHTML=S.favourites.map(ch=>{
    const logo=ch.stream_icon?`<img src="${esc(logoUrl(ch.stream_icon))}" onerror="this.style.display='none'" loading="lazy"/>`:`<span>${esc((ch.name||"?")[0].toUpperCase())}</span>`;
    return `<div class="fav-card" data-id="${ch.stream_id}"><button class="fav-remove" data-id="${ch.stream_id}">✕</button><div class="ch-logo">${logo}</div><div class="ch-name">${esc(ch.name||"")}</div></div>`;
  }).join("");
  body.innerHTML=""; body.appendChild(grid);
  grid.querySelectorAll(".fav-card").forEach(card=>card.addEventListener("click",e=>{
    if (e.target.classList.contains("fav-remove")) return;
    const ch=S.favourites.find(f=>f.stream_id==card.dataset.id);
    if (ch){ selectChannel(ch.stream_id); closeTab("favourites"); if(mob()){setMobileView("player");document.querySelectorAll(".bnav-btn").forEach(b=>b.classList.toggle("active",b.dataset.view==="player"));} }
  }));
  grid.querySelectorAll(".fav-remove").forEach(btn=>btn.addEventListener("click",e=>{
    e.stopPropagation();
    S.favourites=S.favourites.filter(f=>f.stream_id!=btn.dataset.id);
    fetch(`/api/favs/${encodeURIComponent(S.username)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(S.favourites)});
    renderFavourites();
  }));
}

// ── Guide ─────────────────────────────────────────────────────────
async function loadGuide(){
  const body=$("guide-body");
  if (!S.favourites.length){body.innerHTML='<div class="empty">Add channels to favourites to see the guide.</div>';return;}
  body.innerHTML='<div class="spinner">Loading guide…</div>';
  const now=Date.now()/1000;
  const rows=await Promise.allSettled(S.favourites.map(async ch=>{
    let listings=S.epgCache[ch.stream_id];
    if (!listings){
      try{const d=await apiGet(`/api/epg/${ch.stream_id}?${creds()}`);listings=d.epg_listings||[];S.epgCache[ch.stream_id]=listings;}
      catch(_){listings=[];}
    }
    return {ch,listings};
  }));
  S.guideData=rows.filter(r=>r.status==="fulfilled").map(r=>r.value);
  renderGuide(S.guideData);
}
function renderGuide(data){
  const body=$("guide-body");
  if (!data.length){body.innerHTML='<div class="empty">No guide data for your favourites.</div>';return;}
  const now=Date.now()/1000;
  const grid=document.createElement("div"); grid.className="guide-grid";
  grid.innerHTML=data.map(({ch,listings})=>{
    const logo=ch.stream_icon?`<img src="${esc(logoUrl(ch.stream_icon))}" onerror="this.style.display='none'" loading="lazy"/>`:`<span>${esc((ch.name||"?")[0].toUpperCase())}</span>`;
    const progs=listings.slice(0,8).map(ep=>{
      const start=parseInt(ep.start_timestamp||0),stop=parseInt(ep.stop_timestamp||0);
      const isNow=start<=now&&now<=stop;
      const startTime=fmtTime(ep.start);
      // Build end time from stop_timestamp
      const stopTime=ep.stop ? fmtTime(ep.stop) : (stop ? fmtTime(new Date(stop*1000).toISOString().replace("T"," ").slice(0,19)) : "");
      const timeRange=stopTime ? `${startTime} – ${stopTime}` : startTime;
      const title=b64(ep.title||"").trim();
      return `<div class="guide-program${isNow?" now":""}">
        <div class="gp-time">${esc(timeRange)}</div>
        <div class="gp-title">${esc(title||"—")}</div>
      </div>`;
    }).join("")||'<div class="guide-program"><div class="gp-time">—</div><div class="gp-title">No guide data</div></div>';
    return `<div class="guide-row"><div class="guide-ch" data-id="${ch.stream_id}"><div class="guide-ch-logo">${logo}</div><span class="guide-ch-name">${esc(ch.name||"")}</span><span class="guide-ch-watch">▶</span></div><div class="guide-programs">${progs}</div></div>`;
  }).join("");
  body.innerHTML=""; body.appendChild(grid);
  grid.querySelectorAll(".guide-ch").forEach(el=>el.addEventListener("click",()=>{
    const ch=data.find(d=>d.ch.stream_id==el.dataset.id)?.ch;
    if (ch){ selectChannel(ch.stream_id); closeTab("guide"); if(mob()){setMobileView("player");document.querySelectorAll(".bnav-btn").forEach(b=>b.classList.toggle("active",b.dataset.view==="player"));} }
  }));
}
function filterGuide(q){
  q=q.toLowerCase();
  renderGuide(q?S.guideData.filter(d=>(d.ch.name||"").toLowerCase().includes(q)):S.guideData);
}

// ── Settings ──────────────────────────────────────────────────────
function populateTimezones(){
  const sel=$("pref-timezone");
  ["America/Vancouver","America/Edmonton","America/Regina","America/Winnipeg",
   "America/Toronto","America/Halifax","America/St_Johns",
   "America/Los_Angeles","America/Denver","America/Phoenix","America/Chicago","America/New_York",
   "Pacific/Honolulu","America/Anchorage",
   "Europe/London","Europe/Paris","Europe/Berlin","Europe/Helsinki","Europe/Moscow",
   "Asia/Dubai","Asia/Kolkata","Asia/Singapore","Asia/Tokyo","Australia/Sydney","Pacific/Auckland","UTC"]
  .forEach(z=>{const o=document.createElement("option");o.value=z;o.textContent=z.replace(/_/g," ");sel.appendChild(o);});
}
async function loadSettingsTab(){
  try {
    const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({username:S.username,password:S.password})}).then(r=>r.json());
    const exp=r.expiry?new Date(parseInt(r.expiry)*1000).toLocaleDateString():"—";
    $("acct-info").innerHTML=`<b>${S.username}</b><br>Status: ${r.status||"—"}<br>Connections: ${r.connections}<br>Expires: ${exp}`;
  } catch(_){$("acct-info").textContent="Could not load account info.";}
  $("pref-timezone").value=S.prefs.timezone||"UTC";
}
async function savePrefs(){
  S.prefs.timezone=$("pref-timezone").value;
  const msg=$("prefs-msg");
  try {
    await fetch(`/api/prefs/${encodeURIComponent(S.username)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(S.prefs)});
    msg.style.color="var(--green)"; msg.textContent="✓ Saved!"; msg.classList.remove("hidden");
    setTimeout(()=>msg.classList.add("hidden"),2000);
    S.epgCache={}; $("epg-strip").innerHTML="";
    if (S.currentChannel) loadEpg(S.currentChannel.stream_id);
  } catch(e){msg.style.color="var(--red)"; msg.textContent="Error: "+e.message; msg.classList.remove("hidden");}
}
window.savePrefs=savePrefs;
