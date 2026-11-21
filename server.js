"use strict";
// Celestial Troll Bot — troll auto-reply + assistant commands + GC name cycle + PM Banat + Image Lock.
// Built to stay logged in and never die: errors back off and retry, they never end the process.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { pickBanatReply, rememberBanatReply } = require("./banat-memory");
const { chooseSocialResponse } = require("./banat-social");
const { startTyping, stopTyping, stopAllTyping } = require("./human-typing");
const { createGcCycle } = require("./gcname");
const commands = require("./commands");
const economy = require("./economy");
const moderation = require("./moderation");
const groupControls = require("./group-controls");

// ============================================================
// Phobia Integration Modules
// ============================================================
const { createLockStore } = require("./lock-store");
const { createGroupTitleGuard } = require("./group-title-guard");
const { createNicknameLockGuard } = require("./nickname-lock-guard");
const { createGroupImageGuard } = require("./group-image-guard"); // BAGO
const { executeMassSetNickname } = require("./mass-setnn");
const { isDuplicateMessage } = require("./message-dedupe");
const { extractMessageID, dispatchMessageReaction } = require("./message-reactions");
const { createSpamMode } = require("./spam-mode");
const { createAutoCount } = require("./auto-count");
const { createTargetReact } = require("./target-react");

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA, { recursive: true });
economy.init(DATA, (who, msg) => console.log(`[${who}] ${msg}`));

// ---------- tiny helpers ----------
function safeRead(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } }
function writeAtomic(f, obj) {
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const rnd = (a, b) => a + Math.random() * (b - a);
const num = (v, min, max, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };

// ---------- dashboard access ----------
const hasAdmin = () => !!process.env.ADMIN_PASSWORD;
function safeEq(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const checkPw = (pw) => hasAdmin() && safeEq(pw || "", process.env.ADMIN_PASSWORD);

// ---------- config ----------
const CFG_FILE = path.join(DATA, "config.json");
const DEFAULTS = {
  appState: null, savedAt: null, stateRefreshedAt: null,
  autoReply: false, threadId: null, threads: [], running: false,
  speed: "fast", selfReact: true, selfReactRate: 0.15, markRead: true,
  skipMax: 4, senderCooldownS: 0, hourlyMax: 0, dailyMax: 0, threadMax: 0, threadWindowS: 300,
  awayBreaks: false,
  quiet: { on: false, start: "00:30", end: "07:30" }, tz: process.env.BOT_TZ || "Asia/Manila",
  openers: ["hello", "uy"],
  profile: "unlimited-v1",
  troll: true,
  pmTroll: true, // BAGO: Private Message Banat ON/OFF
  prefix: "!",
  admins: [],
  cmdCooldownS: 2, cmdHourlyMax: 0,
  fcaPackage: null,
  reminders: [],
  reactTargets: [], // [{threadID,userID,emoji}] — self react sa target
};
const STEALTH_V1 = ["speed", "selfReact", "selfReactRate", "skipMax", "senderCooldownS", "hourlyMax", "dailyMax", "threadMax", "threadWindowS", "openers"];
const cfg = Object.assign({}, DEFAULTS, safeRead(CFG_FILE));
cfg.quiet = Object.assign({}, DEFAULTS.quiet, cfg.quiet);
if (cfg.profile !== DEFAULTS.profile) {
  for (const k of STEALTH_V1) cfg[k] = DEFAULTS[k];
  cfg.quiet = Object.assign({}, DEFAULTS.quiet); cfg.profile = DEFAULTS.profile;
  try { writeAtomic(CFG_FILE, cfg); } catch {}
}
cfg.threads = (Array.isArray(cfg.threads) ? cfg.threads : []).map(String);
if (cfg.threadId && !cfg.threads.includes(String(cfg.threadId))) cfg.threads.push(String(cfg.threadId));
cfg.threadId = null;
const save = () => { try { writeAtomic(CFG_FILE, cfg); } catch (e) { console.error("[save]", e.message); } };

const envAdmins = new Set(String(process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
const isAdminId = (id) => String(id) === S.uid || envAdmins.has(String(id)) || (cfg.admins || []).map(String).includes(String(id));

const envOwners = new Set(String(process.env.OWNER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
const isOwnerId = (id) => {
  const cfgOwners = (cfg.owners || []).map(String);
  if (String(id) === S.uid || envOwners.has(String(id)) || cfgOwners.includes(String(id))) return true;
  return !envOwners.size && !cfgOwners.length && isAdminId(id);
};
moderation.init(DATA, (who, msg) => console.log(`[${who}] ${msg}`), { isAdminId, isOwnerId });

// ---------- reply pools ----------
const RAW_POOL = JSON.parse(fs.readFileSync(path.join(__dirname, "replies.json"), "utf8"));
const POOLS = Array.isArray(RAW_POOL) ? { default: RAW_POOL } : RAW_POOL;
const ALL_REPLIES = [...new Set(Object.values(POOLS).flat())];
const poolKey = (type) => (Array.isArray(POOLS[type]) && POOLS[type].length ? type : "default");
const poolFor = (type) => (Array.isArray(POOLS[poolKey(type)]) && POOLS[poolKey(type)].length ? POOLS[poolKey(type)] : ALL_REPLIES);

// ---------- runtime state ----------
const S = {
  api: null, uid: null, online: false, running: false, logging: false, stopListen: null, manualOff: false,
  authDead: false, started: Date.now(), botSince: null, lastConnected: null, lastDisconnected: null,
  attempts: 0, nextRetry: null, timer: null, listenTimer: null, listenFails: 0, pingFails: 0,
  lastEventAt: null, lastPing: null, nextPing: 0, lastStateJson: cfg.appState ? JSON.stringify(cfg.appState) : null,
  lastError: null, replies: [], daily: [], suppressed: 0, awayUntil: 0, fcaName: null,
  senders: new Map(), threads: new Map(), busy: new Set(), log: [], skipRun: new Map(),
  cmdSenders: new Map(), cmdHour: [], pmCooldown: new Map(),
};

function log(who, msg) {
  S.log.unshift({ t: Date.now(), who, msg: String(msg).slice(0, 300) });
  S.log.length = Math.min(S.log.length, 80);
  console.log(`[${who}] ${msg}`);
}

// ============================================================
// Phobia: lock store + guards + spam
// ============================================================
const lockStore = createLockStore({ dataDir: DATA });
let titleGuard = null, nicknameGuard = null, imageGuard = null;

function initGuards() {
  if (!titleGuard) { titleGuard = createGroupTitleGuard({ store: lockStore, getApi: () => S.api }); titleGuard.start(); }
  if (!nicknameGuard) { nicknameGuard = createNicknameLockGuard({ store: lockStore, getApi: () => S.api }); nicknameGuard.start(); }
  if (!imageGuard) { imageGuard = createGroupImageGuard({ store: lockStore, getApi: () => S.api }); imageGuard.start(); }
}

const spamMode = createSpamMode({
  getApi: () => S.api,
  sendMessage: (api, msg, tid) => new Promise((ok, fail) => api.sendMessage(msg, tid, (e) => (e ? fail(e) : ok()))),
  isAuthorized: () => !!S.api,
});
if (typeof commands.setSpamModeInstance === "function") commands.setSpamModeInstance(spamMode);

// Auto Count (resibo) + Target React
const autoCount = createAutoCount({
  getApi: () => S.api,
  sendMessage: (api, msg, tid) => new Promise((ok, fail) => api.sendMessage(msg, tid, (e) => (e ? fail(e) : ok()))),
  isAuthorized: () => !!S.api,
});
const targetReact = createTargetReact({
  getApi: () => S.api,
  getSelfId: () => S.uid,
  getList: () => (Array.isArray(cfg.reactTargets) ? cfg.reactTargets : (cfg.reactTargets = [])),
  saveList: (list) => { cfg.reactTargets = list; save(); },
  dispatchReaction: dispatchMessageReaction,
  extractMessageID,
});

// ---------- session ----------
function parseCookie(raw) {
  raw = String(raw || "").trim();
  const arr = raw.startsWith("[")
    ? JSON.parse(raw)
    : raw.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
        const i = p.indexOf("=");
        return { key: p.slice(0, i), value: p.slice(i + 1), domain: "facebook.com", path: "/", hostOnly: false };
      });
  const keys = new Set(arr.map((c) => c.key || c.name));
  if (!keys.has("c_user") || !keys.has("xs")) throw new Error("missing c_user / xs");
  return arr;
}

if (!cfg.appState) {
  try {
    const raw = process.env.APPSTATE || (fs.existsSync(path.join(DATA, "appstate.json")) ? fs.readFileSync(path.join(DATA, "appstate.json"), "utf8") : "");
    if (raw) {
      cfg.appState = parseCookie(raw); cfg.savedAt = Date.now(); S.lastStateJson = JSON.stringify(cfg.appState); save();
      console.log("[system] cookie loaded from " + (process.env.APPSTATE ? "APPSTATE env" : "appstate.json"));
    }
  } catch (e) { console.error("[system] bad APPSTATE / appstate.json:", e.message); }
}

// ---------- quiet hours ----------
function localMinutes() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}
const toMin = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
function inQuiet() {
  if (!cfg.quiet.on) return false;
  try {
    const n = localMinutes(), a = toMin(cfg.quiet.start), b = toMin(cfg.quiet.end);
    return a <= b ? n >= a && n < b : n >= a || n < b;
  } catch { return false; }
}

// ---------- session keep-alive ----------
const AUTH_RE = /checkpoint|not logged in|login[_ ]?(approval|blocked)|expired|appstate|retrieving userid|unknown location|suspended|disabled|locked|invalid.*(cookie|session)/i;
const isAuthError = (e) => AUTH_RE.test(String((e && (e.error || e.message)) || e || ""));

function captureState(reason) {
  if (!S.api || typeof S.api.getAppState !== "function") return;
  try {
    const st = S.api.getAppState();
    if (!Array.isArray(st) || !st.length) return;
    const json = JSON.stringify(st);
    if (json === S.lastStateJson) return;
    if (cfg.appState) { try { writeAtomic(path.join(DATA, "appstate.backup.json"), cfg.appState); } catch {} }
    S.lastStateJson = json; cfg.appState = st; cfg.stateRefreshedAt = Date.now(); save();
    log("session", `cookie refreshed (${reason})`);
  } catch (e) { log("error", "getAppState: " + (e.message || e)); }
}

function stopListening() {
  const s = S.stopListen; S.stopListen = null;
  clearTimeout(S.listenTimer);
  try {
    if (typeof s === "function") s();
    else if (s && typeof s.stopListening === "function") s.stopListening();
    else if (s && typeof s.stop === "function") s.stop();
  } catch {}
}
function teardown() { stopListening(); stopAllTyping(); S.api = null; S.online = false; S.busy.clear(); }

function markAuthDead(e) {
  probeNet().then((up) => {
    if (up) return realMarkAuthDead(e);
    if (netUp) { netUp = false; netDownAt = Date.now(); netMiss = 2; }
    S.lastError = "Walang internet — nakaabang pa rin, kusang babalik.";
    log("watchdog", "error during internet outage, NOT a dead session: " + String((e && (e.error || e.message)) || e).slice(0, 80));
    if (S.api) drop(); else scheduleRetry();
  }).catch(() => realMarkAuthDead(e));
}
function realMarkAuthDead(e) {
  S.authDead = true;
  S.lastError = "Session expired / checkpoint — paste a fresh cookie. (" + String((e && (e.error || e.message)) || e).slice(0, 120) + ")";
  log("watchdog", "auth problem: fast retry paused, will probe again in 30 min");
  teardown(); S.lastDisconnected = Date.now(); clearTimeout(S.timer);
  S.nextRetry = Date.now() + 30 * 60e3;
  S.timer = setTimeout(() => { if (S.manualOff) return; S.authDead = false; connect(); }, 30 * 60e3);
}

function loadFca() {
  const names = [process.env.FCA_PACKAGE, cfg.fcaPackage, "@dongdev/fca-unofficial"].filter(Boolean);
  const tried = [];
  for (const name of [...new Set(names)]) {
    try {
      const mod = require(name);
      const login = typeof mod === "function" ? mod : mod && (mod.login || mod.default);
      if (typeof login === "function") { S.fcaName = name; return login; }
      tried.push(`${name} (no login export)`);
    } catch (e) { tried.push(`${name} (${String(e.message).split("\n")[0].slice(0, 80)})`); }
  }
  log("error", "fca library missing: " + tried.join(" | "));
  return null;
}

// Proxy (optional): set PROXY_URL env, e.g. http://user:pass@host:port  (o "proxy" sa config.json)
function getProxyUrl() {
  const raw = String(process.env.PROXY_URL || cfg.proxy || "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "http://" + raw;
  try { new URL(withScheme); return withScheme; } catch { log("error", "PROXY_URL invalid, ignored"); return ""; }
}
function maskProxy(u) { try { const x = new URL(u); return x.protocol + "//" + (x.username ? "***@" : "") + x.host; } catch { return "(invalid)"; } }

function connect() {
  if (S.logging || !cfg.appState || S.authDead) return;
  clearTimeout(S.timer); S.nextRetry = null; S.logging = true;
  const login = loadFca();
  if (!login) { S.logging = false; S.lastError = "fca library not installed (npm i, or set FCA_PACKAGE)"; return scheduleRetry(); }

  const loginOpts = { online: true, selfListen: true, listenEvents: true, autoMarkRead: false, logLevel: "error" };
  const proxyUrl = getProxyUrl();
  if (proxyUrl) { loginOpts.proxy = proxyUrl; log("system", "proxy ON: " + maskProxy(proxyUrl)); }

  login({ appState: cfg.appState }, loginOpts, (err, api) => {
    S.logging = false;
    if (err) {
      S.lastError = String(err.message || err.error || err);
      log("error", "login: " + S.lastError);
      return isAuthError(err) ? markAuthDead(err) : scheduleRetry();
    }
    S.api = api; S.uid = String(api.getCurrentUserID()); S.online = true; S.attempts = 0; S.listenFails = 0; S.pingFails = 0;
    S.lastConnected = Date.now(); S.lastError = null; S.authDead = false; S.nextPing = Date.now() + rnd(10, 20) * 60e3;
    log("system", `Messenger connected as ${S.uid} (${S.fcaName})`);
    captureState("login");
    if (cfg.running && !S.running) { S.running = true; S.botSince = Date.now(); log("bot", "resumed after reconnect"); }

    // Start guards
    initGuards();
    if (titleGuard) titleGuard.reconcile().catch(() => {});
    if (nicknameGuard) nicknameGuard.reconcile("reconnect").catch(() => {});
    if (imageGuard) imageGuard.reconcile().catch(() => {});

    startListen();
    gc.resume();
  });
}

function startListen() {
  if (!S.api) return;
  stopListening();
  S.stopListen = S.api.listenMqtt((e, ev) => {
    if (e) return onListenError(e);
    S.listenFails = 0; S.lastEventAt = Date.now();

    // Dedupe
    if (ev && ev.messageID && isDuplicateMessage(ev.messageID)) return;

    // Guards
    if (ev && ev.threadID) {
      try { titleGuard?.handleEvent(ev).catch(() => {}); } catch {}
      try { nicknameGuard?.handleEvent(ev).catch(() => {}); } catch {}
      try { imageGuard?.handleEvent(ev).catch(() => {}); } catch {}
    }

    onEvent(ev).catch((err) => log("error", "event: " + (err && err.message || err)));
  });
}
function onListenError(e) {
  log("error", "listen: " + (e.message || e.error || e));
  if (isAuthError(e)) return markAuthDead(e);
  S.listenFails++;
  if (S.listenFails <= 3) {
    clearTimeout(S.listenTimer);
    S.listenTimer = setTimeout(startListen, 4000 * S.listenFails + rnd(0, 2000));
    return;
  }
  drop();
}
function drop() { teardown(); S.lastDisconnected = Date.now(); scheduleRetry(); }
function scheduleRetry() {
  if (!cfg.appState || S.manualOff || S.authDead) return;
  S.attempts++;
  let s = Math.min(300, 8 * 2 ** (S.attempts - 1)) + rnd(0, 5);
  if (S.attempts > 10) { s = 1800; S.attempts = 0; log("watchdog", "10 tries failed. Will retry in 30 min"); }
  else log("watchdog", `reconnect #${S.attempts} in ${Math.round(s)}s`);
  S.nextRetry = Date.now() + s * 1000; clearTimeout(S.timer); S.timer = setTimeout(connect, s * 1000);
}
function disconnect() {
  S.manualOff = true; clearTimeout(S.timer); teardown();
  S.running = false; cfg.running = false; save(); S.lastDisconnected = Date.now(); S.nextRetry = null;
}

function ping() {
  if (!S.api) return;
  S.api.getThreadList(1, null, ["INBOX"], (e) => {
    if (!e) { S.pingFails = 0; S.lastPing = Date.now(); return; }
    if (isAuthError(e)) return markAuthDead(e);
    if (++S.pingFails >= 3) { log("watchdog", "health check failed 3x, reconnecting"); S.pingFails = 0; drop(); }
  });
}
setInterval(() => {
  if (!S.api) return;
  captureState("periodic");
  if (Date.now() >= S.nextPing) { S.nextPing = Date.now() + rnd(20, 40) * 60e3; ping(); }
}, 5 * 60e3);

let netUp = true, netDownAt = 0, netMiss = 0;
async function probeNet() {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try { await fetch("https://www.facebook.com/favicon.ico", { method: "HEAD", signal: ctl.signal }); return true; }
  catch { return false; } finally { clearTimeout(t); }
}
setInterval(async () => {
  if (!cfg.appState || S.manualOff) return;
  const up = await probeNet();
  if (!up) {
    if (++netMiss >= 2 && netUp) { netUp = false; netDownAt = Date.now(); S.lastError = "Walang internet — maghihintay, kusang babalik."; log("watchdog", "internet down"); }
    return;
  }
  netMiss = 0;
  if (netUp) return;
  netUp = true; S.lastError = null;
  log("watchdog", `internet back after ${Math.round((Date.now() - netDownAt) / 1000)}s — resuming`);
  if (S.authDead) return;
  if (S.api) { S.listenFails = 0; startListen(); S.nextPing = Date.now() + 5000; }
  else if (!S.logging) { S.attempts = 0; clearTimeout(S.timer); connect(); }
  gc.resume();
}, 30e3);

if (process.env.SELF_URL) {
  setInterval(() => { fetch(String(process.env.SELF_URL).replace(/\/+$/, "") + "/health").catch(() => {}); }, 4 * 60e3);
}

// ---------- sending ----------
const sendRaw = (api, text, tid, cb, replyTo) => api.sendMessage(text, tid, cb, replyTo || undefined);
function sendAssistant(threadID, message, replyTo = null, incomingText = "") {
  if (!S.api) return Promise.resolve(false);
  return sendBanatReplyWithTyping(S.api, message, threadID, replyTo, {
    trafficSendMessage: sendRaw, incomingText, speed: "fast", selfReact: false, humanize: false,
  });
}

// ---------- GC name cycle ----------
const gc = createGcCycle({ getApi: () => S.api, cfg, save, log, isAuthError, onAuthError: markAuthDead });
commands.startReminderLoop({ cfg, save, ready: () => !!S.api, send: (tid, text) => sendAssistant(tid, text) });

// ---------- Bot gates ----------
function allowed(ev) {
  const now = Date.now();
  S.replies = S.replies.filter((t) => now - t < 3600e3);
  S.daily = S.daily.filter((t) => now - t < 86400e3);
  if ((cfg.hourlyMax > 0 && S.replies.length >= cfg.hourlyMax) || (cfg.dailyMax > 0 && S.daily.length >= cfg.dailyMax)) return false;
  if (cfg.senderCooldownS > 0 && now - (S.senders.get(ev.senderID) || 0) < cfg.senderCooldownS * 1000) return false;
  const th = (S.threads.get(ev.threadID) || []).filter((t) => now - t < cfg.threadWindowS * 1000);
  S.threads.set(ev.threadID, th);
  if (S.senders.size > 2000) for (const [k, t] of S.senders) if (now - t > 3600e3) S.senders.delete(k);
  if (S.threads.size > 500) for (const [k, v] of S.threads) if (!v.length) S.threads.delete(k);
  return !(cfg.threadMax > 0) || th.length < cfg.threadMax;
}
const isTarget = (ev) => cfg.autoReply || cfg.threads.includes(String(ev.threadID));

async function handleCommand(ev, parsed) {
  const cmd = commands.resolve(parsed.name);
  if (!cmd) return;
  const admin = isAdminId(ev.senderID);
  if (cmd.admin && !admin) return;
  const owner = isOwnerId(ev.senderID);
  if (cmd.owner && !owner) return;
  if (!admin && moderation.isBanned(ev.threadID, ev.senderID)) return;

  if (!admin) {
    if (!S.running || !isTarget(ev)) return;
    const now = Date.now();
    S.cmdHour = S.cmdHour.filter((t) => now - t < 3600e3);
    if (cfg.cmdHourlyMax > 0 && S.cmdHour.length >= cfg.cmdHourlyMax) return;
    if (now - (S.cmdSenders.get(ev.senderID) || 0) < cfg.cmdCooldownS * 1000) return;
    S.cmdSenders.set(ev.senderID, now); S.cmdHour.push(now);
    if (S.cmdSenders.size > 1000) for (const [k, t] of S.cmdSenders) if (now - t > 3600e3) S.cmdSenders.delete(k);
  }

  const api = S.api;
  if (!api) return;
  if (cfg.markRead && typeof api.markAsRead === "function" && String(ev.senderID) !== S.uid) {
    try { api.markAsRead(ev.threadID, true, () => {}); } catch {}
  }

  startTyping(api, ev.threadID);
  let reply;
  try {
    reply = await cmd.run({
      args: parsed.args, ev, cfg, save, gc, S, prefix: cfg.prefix, isAdmin: admin, isOwner: owner,
      api, lockStore, spamMode, imageGuard, autoCount, targetReact, // <-- Passed to commands
    });
  } catch (e) {
    log("error", `cmd ${parsed.name}: ${e && e.message || e}`);
    reply = "May error sa command na yan 😭 subukan ulit mamaya.";
  }
  if (!reply) { stopTyping(api, ev.threadID); return; }

  const message = typeof reply === "string" ? { body: reply } : reply;
  const cleanup = message.cleanup; delete message.cleanup;
  const ok = await sendAssistant(ev.threadID, message, ev.messageID || null, ev.body);
  if (typeof cleanup === "function") cleanup();
  stopTyping(api, ev.threadID);
  log("cmd", `${cfg.prefix}${parsed.name} -> ${ev.threadID}${ok ? "" : " (send failed)"}`);
}

async function onEvent(ev) {
  if (ev && ev.type === "event") {
    try { groupControls.handleEvent(S.api, ev, S.uid); } catch {}
    if (S.api) await moderation.onEvent(S.api, ev, { S, isTarget }).catch(() => {});
    return;
  }
  if (ev && (ev.type === "message" || ev.type === "message_reply")) targetReact.onMessage(ev);
  if (!ev || (ev.type !== "message" && ev.type !== "message_reply") || !ev.body) return;

  const parsed = commands.parse(ev.body, cfg.prefix || "!");
  const isCmd = !!(parsed && commands.resolve(parsed.name));
  const own = String(ev.senderID) === S.uid;

  if (own && !isCmd) return;
  if (isCmd) return handleCommand(ev, parsed);

  // ============================================================
  // PRIVATE MESSAGE (PM) BANAT
  // Kung threadID === senderID, ibig sabihin PM ito.
  // ============================================================
  if (ev.threadID === ev.senderID && ev.senderID !== S.uid) {
    if (!cfg.pmTroll || !S.running) return;
    
    const now = Date.now();
    const lastPM = S.pmCooldown.get(ev.senderID) || 0;
    if (now - lastPM < 5000) return; // 5s cooldown per sender
    S.pmCooldown.set(ev.senderID, now);
    if (S.pmCooldown.size > 1000) for (const [k, t] of S.pmCooldown) if (now - t > 3600e3) S.pmCooldown.delete(k);

    if (Math.random() < 0.3) return; // 30% chance to skip, para parang tao
    if (S.busy.has(ev.threadID)) return;

    S.busy.add(ev.threadID);
    try {
      const social = chooseSocialResponse(ev.body, "", { momentum: 1, recentMessages: 1 });
      const r = pickBanatReply(ev.threadID, poolFor(social.type), [], "pm-pool:" + poolKey(social.type));
      const text = typeof r === "string" && r ? r : ALL_REPLIES[Math.floor(Math.random() * ALL_REPLIES.length)];
      const ok = await sendBanatReplyWithTyping(S.api, text, ev.threadID, null, {
        trafficSendMessage: sendRaw,
        incomingText: ev.body,
        speed: cfg.speed,
        selfReact: false,
      });
      if (ok) log("bot", `PM reply -> ${ev.senderID}`);
    } finally {
      S.busy.delete(ev.threadID);
    }
    return;
  }

  // ============================================================
  // GROUP CHAT BANAT
  // ============================================================
  if (!S.running || !cfg.troll) return;
  if (!isTarget(ev) || inQuiet()) return;
  if (Date.now() < S.awayUntil) return;

  const run = S.skipRun.get(ev.threadID) || 0;
  if (run < Math.min(4, Math.max(0, Number(cfg.skipMax) || 0)) && Math.random() < 0.5) { S.skipRun.set(ev.threadID, run + 1); return; }
  if (S.busy.has(ev.threadID)) return;
  if (!allowed(ev)) { S.suppressed++; return; }

  const api = S.api;
  if (!api) return;
  S.busy.add(ev.threadID);
  S.skipRun.set(ev.threadID, 0);
  if (S.skipRun.size > 500) S.skipRun.clear();
  try {
    const social = chooseSocialResponse(ev.body, "", { momentum: 1, recentMessages: 1 });
    const key = poolKey(social.type);
    const r = pickBanatReply(ev.threadID, poolFor(social.type), [], "reply-pool:" + key);
    const text = typeof r === "string" && r ? r : ALL_REPLIES[Math.floor(Math.random() * ALL_REPLIES.length)];

    const now = Date.now();
    S.replies.push(now); S.daily.push(now); S.senders.set(ev.senderID, now); S.threads.get(ev.threadID).push(now);

    if (cfg.markRead && typeof api.markAsRead === "function") {
      setTimeout(() => { try { api.markAsRead(ev.threadID, true, () => {}); } catch {} }, rnd(250, 1200));
    }

    const ok = await sendBanatReplyWithTyping(api, text, ev.threadID, null, {
      trafficSendMessage: sendRaw,
      incomingText: ev.body,
      speed: cfg.speed,
      selfReact: cfg.selfReact ? { rate: cfg.selfReactRate } : false,
    });
    if (ok) {
      rememberBanatReply(ev.threadID, text, ev.senderID); log("bot", `reply [${social.type}] -> ${ev.threadID}`);
      if (cfg.awayBreaks && Math.random() < 0.06) { S.awayUntil = Date.now() + rnd(20, 90) * 60e3; log("bot", `away break ${Math.round((S.awayUntil - Date.now()) / 60e3)} min`); }
    }
  } finally { S.busy.delete(ev.threadID); }
}

async function startBot() {
  if (!S.online) return log("error", "Connect first");
  S.running = true; cfg.running = true; save(); S.botSince = Date.now(); log("bot", "started");
  cfg.threads.forEach((tid, i) => {
    setTimeout(() => {
      if (!S.api || !S.running) return;
      const o = cfg.openers[Math.floor(Math.random() * cfg.openers.length)];
      sendBanatReplyWithTyping(S.api, o, tid, null, { trafficSendMessage: sendRaw, incomingText: "", speed: cfg.speed, selfReact: false });
    }, i * rnd(4000, 9000));
  });
}

// ---------- HTTP ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.get("/", (q, r) => r.sendFile(path.join(__dirname, "index.html")));

const PWA_FILES = {
  "/manifest.webmanifest": "application/manifest+json", "/sw.js": "application/javascript",
  "/icon.svg": "image/svg+xml", "/icon-192.png": "image/png", "/icon-512.png": "image/png",
  "/icon-maskable-512.png": "image/png", "/apple-touch-icon.png": "image/png",
};
for (const [route, type] of Object.entries(PWA_FILES)) {
  app.get(route, (q, r) => {
    r.type(type);
    if (route === "/sw.js") r.set("Cache-Control", "no-cache");
    r.sendFile(path.join(__dirname, route.slice(1)), (err) => { if (err && !r.headersSent) r.status(404).end(); });
  });
}
app.get("/health", (q, r) => r.json({ ok: true }));

app.get("/api/needsetup", (q, r) => r.json({ setup: false, open: !hasAdmin() }));

const fails = new Map();
app.use("/api", (req, res, next) => {
  if (!hasAdmin()) return next();
  const ip = req.ip, now = Date.now(), given = req.get("x-admin");
  const f = (fails.get(ip) || []).filter((t) => now - t < 900e3);
  if (f.length >= 10) return res.status(429).json({ error: "Too many wrong tries. Wait 15 min." });
  if (hasAdmin() && given !== undefined && checkPw(given)) { fails.delete(ip); return next(); }
  if (given !== undefined) { f.push(now); fails.set(ip, f); }
  if (fails.size > 500) for (const [k, v] of fails) if (!v.some((t) => now - t < 900e3)) fails.delete(k);
  res.status(401).json({ error: "unauthorized" });
});

const status = () => ({
  online: S.online, running: S.running, uid: S.uid, authDead: S.authDead, fca: S.fcaName,
  serverUptime: (Date.now() - S.started) / 1000 | 0, botUptime: S.running && S.botSince ? (Date.now() - S.botSince) / 1000 | 0 : 0,
  lastConnected: S.lastConnected, lastDisconnected: S.lastDisconnected, lastPing: S.lastPing, lastEventAt: S.lastEventAt,
  stateRefreshedAt: cfg.stateRefreshedAt, savedAt: cfg.savedAt,
  autoReply: cfg.autoReply, threads: cfg.threads, repliesHour: S.replies.length, repliesDay: S.daily.length, suppressed: S.suppressed,
  attempts: S.attempts, nextRetry: S.nextRetry, lastError: S.lastError, cookieSaved: !!cfg.appState,
  prefix: cfg.prefix, gc: gc.status(), admins: (cfg.admins || []).map(String),
  settings: {
    speed: cfg.speed, selfReact: cfg.selfReact, selfReactRate: cfg.selfReactRate, markRead: cfg.markRead, troll: cfg.troll,
    pmTroll: cfg.pmTroll, // <-- PM Toggle status
    skipMax: cfg.skipMax, hourlyMax: cfg.hourlyMax, dailyMax: cfg.dailyMax, quiet: cfg.quiet, tz: cfg.tz,
  },
  quietNow: inQuiet(), log: S.log.slice(0, 40),
  spam: spamMode.getStatus(),
  count: autoCount.getStatus(),
  targets: targetReact.list(),
});
app.get("/api/status", (q, r) => r.json(status()));
app.post("/api/auto", (q, r) => { cfg.autoReply = !!q.body.on; save(); r.json(status()); });
app.post("/api/threadset", (q, r) => {
  const id = String((q.body && q.body.threadId) || "").trim();
  if (!/^\d{5,25}$/.test(id)) return r.status(400).json({ error: "Invalid GC id" });
  const has = cfg.threads.includes(id);
  if (q.body.on && !has) cfg.threads.push(id);
  if (!q.body.on && has) { cfg.threads = cfg.threads.filter((t) => t !== id); gc.stop(id); }
  save(); r.json(status());
});
app.post("/api/start", async (q, r) => { await startBot(); r.json(status()); });
app.post("/api/stop", (q, r) => { S.running = false; cfg.running = false; save(); log("bot", "stopped"); r.json(status()); });
app.post("/api/reconnect", (q, r) => {
  S.manualOff = false; S.authDead = false; if (S.online) { teardown(); }
  S.attempts = 0; clearTimeout(S.timer); connect(); r.json(status());
});
app.post("/api/disconnect", (q, r) => { disconnect(); r.json(status()); });
app.post("/api/session", (q, r) => {
  try {
    cfg.appState = parseCookie(q.body.cookie); cfg.savedAt = Date.now(); cfg.stateRefreshedAt = null; S.lastStateJson = JSON.stringify(cfg.appState); save();
    S.manualOff = false; S.authDead = false; S.attempts = 0; S.lastError = null;
    if (S.online) teardown();
    connect(); r.json(status());
  } catch (e) { r.status(400).json({ error: "Invalid cookie (need a JSON array or c_user=...; xs=...)" }); }
});
app.post("/api/settings", (q, r) => {
  const b = q.body || {};
  if (["fast", "normal", "slow"].includes(b.speed)) cfg.speed = b.speed;
  if (typeof b.selfReact === "boolean") cfg.selfReact = b.selfReact;
  if (typeof b.markRead === "boolean") cfg.markRead = b.markRead;
  if (typeof b.troll === "boolean") cfg.troll = b.troll;
  if (typeof b.pmTroll === "boolean") cfg.pmTroll = b.pmTroll; // <-- PM Toggle
  cfg.selfReactRate = num(b.selfReactRate, 0, 1, cfg.selfReactRate);
  cfg.skipMax = Math.round(num(b.skipMax, 0, 4, cfg.skipMax));
  cfg.hourlyMax = Math.round(num(b.hourlyMax, 0, 1e6, cfg.hourlyMax));
  cfg.dailyMax = Math.round(num(b.dailyMax, 0, 1e7, cfg.dailyMax));
  if (b.quiet && typeof b.quiet === "object") {
    const ok = (s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s));
    cfg.quiet = { on: !!b.quiet.on, start: ok(b.quiet.start) ? b.quiet.start : cfg.quiet.start, end: ok(b.quiet.end) ? b.quiet.end : cfg.quiet.end };
  }
  save(); log("system", "settings updated"); r.json(status());
});

// GC name cycle
app.post("/api/gcsave", (q, r) => {
  const b = q.body || {};
  if (Array.isArray(b.names)) gc.setNames(b.names, false);
  if (b.intervalS != null) gc.setInterval(b.intervalS, false);
  save(); r.json(status());
});
app.post("/api/gcstart", (q, r) => {
  const b = q.body || {};
  const ids = [...new Set([...(Array.isArray(b.threadIds) ? b.threadIds : []), ...(b.threadId ? [b.threadId] : [])].map(String))];
  const use = ids.length ? ids : cfg.threads.length ? cfg.threads : gc.status().threads;
  if (!use.length) return r.status(400).json({ error: "I-ON muna ang bot sa kahit isang GC (Group chat card)." });
  gc.start({ threadIds: use, names: Array.isArray(b.names) ? b.names : undefined, intervalS: b.intervalS });
  r.json(status());
});
app.post("/api/gcstop", (q, r) => { gc.stop(q.body && q.body.threadId ? q.body.threadId : undefined); r.json(status()); });

// Admin IDs
app.post("/api/admins", (q, r) => {
  const raw = (q.body && q.body.ids) || [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/);
  const ids = [...new Set(list.map((x) => String(x).trim()).filter((x) => /^\d{5,25}$/.test(x)))].slice(0, 50);
  cfg.admins = ids; save(); log("system", `admins updated (${ids.length})`);
  r.json(status());
});

// Group features
require("./group-routes")(app, () => S.api, () => S.uid);

// ============================================================
// Phobia Lock Routes (Title, Nickname, Image)
// ============================================================
app.get("/api/titlelock", async (_req, res) => {
  try { res.json({ groups: await lockStore.listProtectedGroups() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/titlelock", async (req, res) => {
  try {
    const { threadID, title, enabled } = req.body || {};
    if (!threadID || !title) return res.status(400).json({ error: "threadID and title required" });
    lockStore.setGroupTitleLock(threadID, title, enabled !== false);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/titlelock/:threadID", (req, res) => {
  lockStore.removeGroupTitleLock(req.params.threadID);
  res.json({ ok: true });
});

app.get("/api/nicklocks", async (_req, res) => {
  try { res.json({ locks: await lockStore.listNicknameLocks() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/nicklocks", (req, res) => {
  try {
    const { threadID, userID, nickname } = req.body || {};
    if (!threadID || !userID || !nickname) return res.status(400).json({ error: "threadID, userID, nickname required" });
    lockStore.saveNicknameLock(threadID, userID, nickname);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/nicklocks/:threadID/:userID", async (req, res) => {
  try { await lockStore.deleteNicknameLock(req.params.threadID, req.params.userID); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/imagelock", async (_req, res) => {
  try { res.json({ groups: await lockStore.listProtectedImages() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/imagelock", async (req, res) => {
  try {
    const { threadID, imageUrl, enabled } = req.body || {};
    if (!threadID || !imageUrl) return res.status(400).json({ error: "threadID and imageUrl required" });
    lockStore.setGroupImageLock(threadID, imageUrl, enabled !== false);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/imagelock/:threadID", (req, res) => {
  lockStore.removeGroupImageLock(req.params.threadID);
  res.json({ ok: true });
});

// Mass set nickname
app.post("/api/mass-setnn", async (req, res) => {
  try {
    if (!S.api) return res.status(503).json({ error: "Bot not connected" });
    const result = await executeMassSetNickname({
      api: S.api,
      threadID: req.body.threadID,
      nickname: req.body.nickname,
      userIDs: req.body.userIDs,
      getMembers: (tid) => new Promise((ok, fail) => S.api.getThreadInfo(tid, (e, d) => (e ? fail(e) : ok(d)))).then(info => (info.participantIDs || []).map(id => ({ userID: id }))),
      saveNickname: (tid, uid, nick) => lockStore.saveNicknameLock(tid, uid, nick),
      delayMs: 1500,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Spam routes
app.post("/api/spam/start", (req, res) => {
  try {
    if (!S.api) return res.status(503).json({ error: "Bot not connected" });
    res.json(spamMode.start(req.body));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/spam/stop", (req, res) => {
  try {
    const result = req.body?.all ? spamMode.stopAll("dashboard") : spamMode.stop(req.body?.threadID);
    res.json(result || { ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/spam/status", (_req, res) => res.json(spamMode.getStatus()));

// Auto Count routes
app.post("/api/count/start", (req, res) => {
  try {
    if (!S.api) return res.status(503).json({ error: "Bot not connected" });
    res.json(autoCount.start(req.body || {}));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/count/stop", (req, res) => {
  try { res.json((req.body?.all ? autoCount.stopAll("dashboard") : autoCount.stop(req.body?.threadID)) || { ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/count/status", (_req, res) => res.json(autoCount.getStatus()));

// Target React routes
app.get("/api/target/list", (_req, res) => res.json(targetReact.list()));
app.post("/api/target/set", (req, res) => {
  try { res.json(targetReact.set(req.body?.threadID, req.body?.userID, req.body?.emoji)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/target/remove", (req, res) => {
  try { res.json(targetReact.remove(req.body?.threadID, req.body?.userID)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// React route
app.post("/api/react", (req, res) => {
  try {
    if (!S.api) return res.status(503).json({ error: "Bot not connected" });
    const { messageID, threadID, emoji } = req.body || {};
    const id = extractMessageID(messageID);
    if (!id || !threadID) return res.status(400).json({ error: "messageID and threadID required" });
    dispatchMessageReaction(S.api, emoji || "❤", id, threadID, {
      onStatus: (state, meta) => console.log("[REACT]", state, meta?.method || ""),
    });
    res.json({ ok: true, messageID: id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/threads", (q, r) => {
  if (!S.api) return r.json([]);
  S.api.getThreadList(50, null, ["INBOX"], (e, l) => r.json(e ? [] : l.filter((t) => t.isGroup).map((t) => ({ id: t.threadID, name: t.name || t.threadID }))));
});

// Global Error Handlers
process.on("uncaughtException", (e) => log("fatal", (e && e.stack) || e));
process.on("unhandledRejection", (e) => log("fatal", (e && e.stack) || e));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { economy.flush(); moderation.flush(); stopAllTyping(); captureState("shutdown"); save(); process.exit(0); });

app.listen(PORT, () => { log("system", "server on " + PORT); if (cfg.appState) connect(); });
