"use strict";

/**
 * Assistant commands for the troll bot.
 * 
 * Bagong dagdag:
 * - !imagelock on <url> / off / status (Group Photo Lock)
 * - !pm on / off (Private Message Banat toggle)
 * - !timecheck
 * - !titlelock
 * - !nicklock
 * - !massnn
 * - !spam
 * - !react
 */

const { musicCommand } = require("./music");
const economy = require("./economy");
const moderation = require("./moderation");
const { isTimeCheck, formatTimeCheck } = require("./time-check");
const { executeMassSetNickname } = require("./mass-setnn");
const { extractMessageID, dispatchMessageReaction } = require("./message-reactions");

async function getJson(url, ms = 10_000, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

function calc(input) {
  const s = String(input || "").replace(/\s+/g, "").replace(/×|x(?=[\d(.])/gi, "*").replace(/÷/g, "/").replace(/,/g, "");
  if (!s || s.length > 120 || !/^[0-9+\-*/%^().]+$/.test(s)) throw new Error("bad expression");
  let i = 0;
  const peek = () => s[i];
  function number() {
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) throw new Error("number expected");
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function primary() {
    if (peek() === "(") { i++; const v = expr(); if (peek() !== ")") throw new Error("missing )"); i++; return v; }
    return number();
  }
  function unary() { if (peek() === "-") { i++; return -unary(); } if (peek() === "+") { i++; return unary(); } return primary(); }
  function power() { const base = unary(); if (peek() === "^") { i++; return Math.pow(base, power()); } return base; }
  function term() {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") { const op = s[i++]; const r = power(); v = op === "*" ? v * r : op === "/" ? v / r : v % r; }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === "+" || peek() === "-") { const op = s[i++]; const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  }
  const out = expr();
  if (i !== s.length) throw new Error("unexpected " + s[i]);
  if (!Number.isFinite(out)) throw new Error("not finite");
  return Number(out.toPrecision(12));
}

const WMO = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Foggy", 48: "Foggy", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers", 81: "Rain showers", 82: "Violent showers", 95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ hail" };

async function weather(place) {
  const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(place)}`);
  const g = geo.results && geo.results[0];
  if (!g) return `Hindi ko mahanap ang "${place}" 🤷`;
  const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&timezone=auto`);
  const c = w.current;
  if (!c) return "Walang weather data ngayon.";
  return `🌤 ${g.name}${g.country_code ? ", " + g.country_code : ""}\n${WMO[c.weather_code] || "—"} · ${Math.round(c.temperature_2m)}°C (feels ${Math.round(c.apparent_temperature)}°C)\n💧 ${c.relative_humidity_2m}% · 🌧 ${c.precipitation} mm · 💨 ${Math.round(c.wind_speed_10m)} km/h`;
}

async function define(word) {
  try {
    const data = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    const e = Array.isArray(data) && data[0];
    const m = e && e.meanings && e.meanings[0];
    const d = m && m.definitions && m.definitions[0];
    if (!d) return `Walang definition para sa "${word}".`;
    return `📖 ${e.word}${m.partOfSpeech ? " (" + m.partOfSpeech + ")" : ""}\n${d.definition}${d.example ? `\nHal: ${d.example}` : ""}`;
  } catch { return `Walang definition para sa "${word}".`; }
}

function timeNow(zone, fallbackTz) {
  const tz = zone || fallbackTz || "Asia/Manila";
  try {
    const f = new Intl.DateTimeFormat("en-PH", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
    return `🕒 ${f.format(new Date())}\n(${tz})`;
  } catch { return `Di ko kilala ang timezone na "${tz}". Hal: time Asia/Tokyo`; }
}

const UNIT = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };
function parseDuration(t) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(String(t || ""));
  if (!m) return null;
  const ms = parseFloat(m[1]) * UNIT[m[2].toLowerCase()];
  return ms >= 5e3 && ms <= 7 * 86400e3 ? ms : null;
}

async function ask(question) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "Walang ANTHROPIC_API_KEY sa server kaya di pa gumagana ang !ask 😅";
  const data = await getJson("https://api.anthropic.com/v1/messages", 30_000, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ASSISTANT_MODEL || "claude-haiku-5-5", max_tokens: 350, system: "You are a Taglish troll-bot assistant inside a Messenger group chat. Answer the question correctly and briefly (max 4 short sentences, plain text, no markdown). Add a light, playful tease at the end. Never insult anyone's looks, family, gender, religion or background, and never use profanity.", messages: [{ role: "user", content: String(question).slice(0, 1500) }] }),
  });
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return text || "Walang sagot na lumabas 😭";
}

const EIGHT = ["Oo naman 😌", "Hindi 💀", "Baka 🤔", "Malabo pre", "Sure ball yan", "Wag ka muna umasa 😭", "Tanungin mo ulit mamaya", "Hindi ko type yung sagot, so hindi", "Oo, pero wag mo akong sisihin", "Ay hindi yan 😂"];
const dur = (s) => `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m ${s % 60 | 0}s`;
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];

const COMMANDS = {
  help: {
    run: async ({ prefix, isAdmin, isOwner }) => [
      "🤖 Troll Assistant",
      `${prefix}m [title] by [artist] — audio + info`,
      `${prefix}ask <tanong> — sagot ni AI`,
      `${prefix}weather <lugar> · ${prefix}calc <math> · ${prefix}define <word>`,
      `${prefix}time [timezone] · ${prefix}timecheck`,
      `${prefix}remind <10m|2h|1d> <text> · ${prefix}roll [NdM] · ${prefix}flip · ${prefix}8ball <tanong> · ${prefix}pick a | b | c`,
      `${prefix}convert 100 usd php — currency · ${prefix}uptime · ${prefix}owner`,
      `\n💰 Economy: ${prefix}balance · ${prefix}daily · ${prefix}work · ${prefix}bet <amt>`,
      `${prefix}deposit/${prefix}withdraw <amt|all> · ${prefix}give @tao <amt> · ${prefix}top`,
      `🎰 ${prefix}slot <amt> · ${prefix}cf heads|tails <amt> · ${prefix}rob @tao`,
      `🛒 Shop: ${prefix}shop · ${prefix}item <#> · ${prefix}buy <#> [dami] · ${prefix}sell <item> · ${prefix}inv`,
      `\n🛡 Mod (admin ng GC): ${prefix}kick @tao · ${prefix}ban @tao [dahilan] · ${prefix}unban <#|@tao> · ${prefix}banlist`,
      `${prefix}warn @tao [dahilan] · ${prefix}warns [@tao] · ${prefix}unwarn @tao [all] · ${prefix}unsend (reply) · ${prefix}mods`,
      `\n🔒 Locks (admin): ${prefix}titlelock on <title> · ${prefix}titlelock off · ${prefix}titlelock status`,
      `${prefix}nicklock on @user <nick> · ${prefix}nicklock off @user · ${prefix}nicklock list · ${prefix}massnn <nick> @user1 @user2`,
      `${prefix}imagelock on <url> · ${prefix}imagelock off · ${prefix}imagelock status`,
      `\n📣 Spam (admin): ${prefix}spam start <sec> <loops> (reply sa msg) · ${prefix}spam stop · ${prefix}spam stopall · ${prefix}spam status`,
      `❤️ ${prefix}react <emoji> (reply sa msg)`,
      `🔢 Count (admin): ${prefix}count start <sec> [total] [suffix] · ${prefix}count stop · ${prefix}count status`,
      `🎯 Target react (admin): ${prefix}target on <emoji> (reply sa msg ng target) · ${prefix}target off · ${prefix}target list`,
      `💬 ${prefix}pm on|off (toggle private message banat)`,
      isOwner ? `\n👑 Owner: ${prefix}setbal @tao <amt> [wallet|bank]\n${prefix}additem <name> | <presyo> | [emoji] | [desc] | [max] · ${prefix}edititem <#> price|name|emoji|desc|max <value> · ${prefix}delitem <#>` : null,
      isAdmin ? `🔒 ${prefix}on / ${prefix}off — buksan/patayin ang bot sa GC na ito` : null,
      isAdmin ? `🔒 Eco: ${prefix}eco add|remove|reset @tao [amt]` : null,
      isAdmin ? `\n🔒 Admin: ${prefix}gcname start|stop|status|list|add|remove|set|interval|now · ${prefix}troll on|off` : null,
    ].filter(Boolean).join("\n"),
  },
  music: { run: async ({ args, prefix }) => musicCommand(args, prefix) },
  song: { alias: "music" }, m: { alias: "music" },
  ask: { run: async ({ args, prefix }) => (args ? ask(args) : `Format: ${prefix}ask <tanong mo>`) },
  weather: { run: async ({ args, prefix }) => (args ? weather(args) : `Format: ${prefix}weather Manila`) },
  define: { run: async ({ args, prefix }) => (args ? define(args.split(/\s+/)[0]) : `Format: ${prefix}define serendipity`) },
  calc: {
    run: async ({ args, prefix }) => {
      if (!args) return `Format: ${prefix}calc (12+3)*4/5`;
      try { return `🧮 ${args} = ${calc(args)}`; } catch { return "Di ko ma-compute yan 😅 (+ - * / % ^ at ( ) lang)"; }
    },
  },
  time: { run: async ({ args, cfg }) => timeNow(args, cfg.tz) },
  timecheck: { run: async () => formatTimeCheck() },
  roll: {
    run: async ({ args }) => {
      const m = /^(\d{1,2})?d(\d{1,4})$/i.exec(String(args || "d6").trim()) || /^(\d{1,2})?d(\d{1,4})$/i.exec("d6");
      const n = Math.max(1, Math.min(20, parseInt(m[1] || "1", 10)));
      const sides = Math.max(2, parseInt(m[2], 10));
      const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
      return `🎲 ${n}d${sides}: ${rolls.join(", ")}${n > 1 ? ` = ${rolls.reduce((a, b) => a + b, 0)}` : ""}`;
    },
  },
  flip: { run: async () => `🪙 ${pickOne(["Heads", "Tails"])}` },
  "8ball": { run: async ({ args, prefix }) => (args ? `🎱 ${pickOne(EIGHT)}` : `Format: ${prefix}8ball <tanong>`) },
  pick: {
    run: async ({ args, prefix }) => {
      const opts = String(args || "").split(/\s*[|,]\s*/).map((x) => x.trim()).filter(Boolean);
      return opts.length >= 2 ? `👉 ${pickOne(opts)}` : `Format: ${prefix}pick pizza | burger | adobo`;
    },
  },
  remind: {
    run: async ({ args, ev, cfg, save, prefix }) => {
      const m = /^(\S+)\s+([\s\S]+)$/.exec(String(args || "").trim());
      const ms = m && parseDuration(m[1]);
      if (!m || !ms) return `Format: ${prefix}remind 10m uminom ng tubig\n(5s hanggang 7d: s, m, h, d)`;
      cfg.reminders = Array.isArray(cfg.reminders) ? cfg.reminders : [];
      if (cfg.reminders.filter((r) => r.senderID === String(ev.senderID)).length >= 5) return "Max 5 reminders kada tao 😅";
      cfg.reminders.push({ id: Date.now() + Math.random(), at: Date.now() + ms, threadID: String(ev.threadID), senderID: String(ev.senderID), text: m[2].slice(0, 300) });
      save();
      return `⏰ Sige, ipapaalala ko sa ${m[1]}.`;
    },
  },
  convert: {
    run: async ({ args, prefix }) => {
      const m = /^([\d.,]+)\s*([a-z]{3})(?:\s*(?:to|in|into|->|=|sa)?\s*([a-z]{3}))?$/i.exec(String(args || "").trim());
      if (!m) return `Format: ${prefix}convert 100 usd php (o ${prefix}convert 10 usd = PHP ang default)`;
      const amount = parseFloat(m[1].replace(/,/g, ""));
      const from = m[2].toUpperCase(), to = (m[3] || "PHP").toUpperCase();
      if (!(amount > 0) || amount > 1e12) return "Mali ang amount.";
      if (from === to) return `${amount} ${from} = ${amount} ${to} 😐`;
      try {
        const d = await getJson(`https://api.frankfurter.dev/v1/latest?amount=${amount}&from=${from}&to=${to}`);
        const v = d && d.rates && d.rates[to];
        if (v == null) return `Hindi ko ma-convert ang ${from} → ${to}.`;
        return `💱 ${amount.toLocaleString("en-US")} ${from} = ${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${to}\n(rate noong ${d.date})`;
      } catch { return `Hindi ko ma-convert ang ${from} → ${to}. Tingnan ang currency code (USD, PHP, JPY, EUR...).`; }
    },
  },
  currency: { alias: "convert" }, rate: { alias: "convert" },
  owner: {
    run: async ({ S, cfg }) => {
      const name = process.env.OWNER_NAME || cfg.ownerName || "Sinzu";
      const link = process.env.OWNER_LINK || cfg.ownerLink || "https://www.facebook.com/profile.php?id=61596019734288";
      return link ? `👑 Owner: ${name}\n🔗 ${link}` : `👑 Owner: ${name}`;
    },
  },
  creator: { alias: "owner" },
  uptime: { run: async ({ S }) => `⏱ Bot uptime: ${dur((Date.now() - (S.botSince || S.started)) / 1000)}\nServer: ${dur((Date.now() - S.started) / 1000)}` },

  titlelock: {
    admin: true,
    run: async ({ args, ev, lockStore, prefix }) => {
      if (!lockStore) return "⚠️ lockStore unavailable.";
      const [sub = "status", ...rest] = String(args || "").trim().split(/\s+/);
      const title = rest.join(" ").trim();
      const threadID = String(ev.threadID);
      switch (sub.toLowerCase()) {
        case "on": {
          if (!title) return `Format: ${prefix}titlelock on <exact title>`;
          if (title.length > 100) return "⚠️ Title max 100 chars.";
          lockStore.setGroupTitleLock(threadID, title, true);
          return `🔒 Title lock ON for this GC:\n"${title}"\n\nKapag may nagbago, ibabalik sa <120s.`;
        }
        case "off": { lockStore.setGroupTitleLock(threadID, "", false); return "🔓 Title lock OFF for this GC."; }
        case "status":
        default: {
          const g = await lockStore.getGroup(threadID);
          return g.autolockEnabled ? `🔒 Title lock: ON\nExpected: "${g.expectedTitle}"` : "🔓 Title lock: OFF";
        }
      }
    },
  },

  nicklock: {
    admin: true,
    run: async ({ args, ev, lockStore, prefix }) => {
      if (!lockStore) return "⚠️ lockStore unavailable.";
      const threadID = String(ev.threadID);
      const raw = String(args || "").trim();
      if (/^list\b/i.test(raw)) {
        const locks = await lockStore.getNicknameLocks(threadID);
        if (!locks.length) return "Walang naka-lock na nickname sa GC na ito.";
        return "🔒 Nickname locks:\n" + locks.map((l) => `• ${l.userID} → "${l.expectedNickname}"`).join("\n");
      }
      const m = /^(on|off)\s+@?(\d{5,})\s*(.*)$/i.exec(raw);
      if (!m) return `Format:\n${prefix}nicklock on @user <nickname>\n${prefix}nicklock off @user\n${prefix}nicklock list`;
      const [, action, userID, nick] = m;
      if (action.toLowerCase() === "on") {
        const nickname = nick.trim();
        if (!nickname) return `Format: ${prefix}nicklock on @user <nickname>`;
        if (nickname.length > 64) return "⚠️ Nickname max 64 chars.";
        lockStore.saveNicknameLock(threadID, userID, nickname);
        return `🔒 Nickname lock ON:\n${userID} → "${nickname}"`;
      }
      await lockStore.deleteNicknameLock(threadID, userID);
      return `🔓 Nickname lock removed: ${userID}`;
    },
  },

  massnn: {
    admin: true,
    run: async ({ args, ev, api, lockStore, prefix }) => {
      if (!lockStore) return "⚠️ lockStore unavailable.";
      if (!api) return "⚠️ Bot not connected.";
      const raw = String(args || "").trim();
      if (!raw) return `Format: ${prefix}massnn <nickname> @user1 @user2 ...`;
      const nickMatch = /^(.+?)(?:\s+@\d{5,}.*)?$/.exec(raw);
      const nickname = nickMatch ? nickMatch[1].trim().slice(0, 64) : "";
      if (!nickname) return `Format: ${prefix}massnn <nickname> @user1 @user2 ...`;
      const userIDs = [...new Set([...Object.keys(ev.mentions || {}), ...Array.from(ev.body.matchAll(/@(\d{5,})/g)).map(m => m[1]), ev?.messageReply?.senderID].map(String).filter(Boolean))];
      if (!userIDs.length) return "⚠️ Tag at least 1 user (or reply to their message).";
      if (userIDs.length > 50) return "⚠️ Max 50 users per run.";
      try {
        const result = await executeMassSetNickname({
          api, threadID: String(ev.threadID), nickname, userIDs,
          getMembers: (tid) => new Promise((ok, fail) => api.getThreadInfo(tid, (e, d) => (e ? fail(e) : ok(d)))).then((info) => (info.participantIDs || []).map((id) => ({ userID: id }))),
          saveNickname: (tid, uid, nick) => lockStore.saveNicknameLock(tid, uid, nick), delayMs: 1500,
        });
        const lines = [`✅ Mass setnn done`, `Total: ${result.total} · OK: ${result.succeeded} · Fail: ${result.failed}`, `Lock saved: ${result.lockSaved} · Lock failed: ${result.lockSaveFailed}`];
        const fails = result.results.filter((r) => !r.ok).slice(0, 3);
        if (fails.length) lines.push("⚠️ Failures: " + fails.map((f) => `${f.userID}: ${f.error}`).join(" | "));
        return lines.join("\n");
      } catch (e) { return `❌ Mass setnn failed: ${e.message}`; }
    },
  },

  imagelock: {
    admin: true,
    run: async ({ args, ev, lockStore, prefix }) => {
      if (!lockStore) return "⚠️ lockStore unavailable.";
      const [sub = "status", ...rest] = String(args || "").trim().split(/\s+/);
      const imageUrl = rest.join(" ").trim();
      const threadID = String(ev.threadID);
      switch (sub.toLowerCase()) {
        case "on":
        case "set": {
          if (!imageUrl) return `Format: ${prefix}imagelock on <image_url>`;
          lockStore.setGroupImageLock(threadID, imageUrl, true);
          return `🖼️ Image lock ON for this GC:\n${imageUrl}\n\nKapag may nagbago, ibabalik sa <120s.`;
        }
        case "off": {
          lockStore.removeGroupImageLock(threadID);
          return "🔓 Image lock OFF for this GC.";
        }
        case "status":
        default: {
          const g = await lockStore.getGroupImage(threadID);
          return g && g.imageUrl ? `🖼️ Image lock: ON\nURL: ${g.imageUrl}` : "🔓 Image lock: OFF";
        }
      }
    },
  },

  spam: {
    admin: true,
    run: async ({ args, ev, spamMode, prefix }) => {
      if (!spamMode) return "⚠️ spamMode unavailable.";
      const [sub = "status", ...rest] = String(args || "").trim().split(/\s+/);
      const threadID = String(ev.threadID);
      switch (sub.toLowerCase()) {
        case "start": {
          const replyBody = String(ev?.messageReply?.body || "").trim();
          if (!replyBody) return `Format: i-reply mo sa message na gusto mong i-spam, tapos:\n${prefix}spam start <sec> <loops>\n\nHal: ${prefix}spam start 5 3`;
          const intervalSeconds = parseInt(rest[0], 10);
          const loops = parseInt(rest[1], 10) || 1;
          try {
            const result = spamMode.start({ threadID, message: replyBody, intervalSeconds, loops });
            return `📣 Spam started\nMode: ${result.mode} · Total: ${result.totalMessages} · Every ${result.intervalSeconds}s\nFirst send in ${result.firstSendInSeconds}s`;
          } catch (e) { return `❌ ${e.message}`; }
        }
        case "stop": { const r = spamMode.stop(threadID); return r.stopped ? `⏹ Spam stopped sa GC na ito (sent ${r.sent}).` : "Walang tumatakbo sa GC na ito."; }
        case "stopall": { spamMode.stopAll("chat"); return "⏹ Lahat ng spam runs ay pinatay."; }
        case "status":
        default: {
          const list = spamMode.getStatus();
          if (!list.length) return "📣 Walang spam na tumatakbo.";
          return "📣 Spam runs:\n" + list.map((s) => `• ${s.threadID}: ${s.sent}/${s.totalMessages} every ${s.intervalSeconds}s (${s.mode})`).join("\n");
        }
      }
    },
  },

  count: {
    admin: true,
    run: async ({ args, ev, autoCount, prefix }) => {
      if (!autoCount) return "⚠️ autoCount unavailable.";
      const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts.shift() || "status").toLowerCase();
      const threadID = String(ev.threadID);
      switch (sub) {
        case "start": {
          // !count start <sec> [total] [suffix...]   hal: !count start 5 50 🎄
          const intervalSeconds = parseInt(parts[0], 10);
          const hasTotal = /^\d+$/.test(parts[1] || "");
          const total = hasTotal ? parseInt(parts[1], 10) : 100;
          const suffix = parts.slice(hasTotal ? 2 : 1).join(" ");
          if (!Number.isInteger(intervalSeconds)) return `Format: ${prefix}count start <sec> [total] [suffix]\n\nHal: ${prefix}count start 5 50 🎄`;
          try {
            const r = autoCount.start({ threadID, intervalSeconds, total, suffix });
            return `🔢 Auto Count started\n${r.startFrom} → ${r.endsAt} · every ${r.intervalSeconds}s${r.suffix ? ` · suffix: ${r.suffix}` : ""}\nFirst send in ${r.firstSendInSeconds}s`;
          } catch (e) { return `❌ ${e.message}`; }
        }
        case "stop": { const r = autoCount.stop(threadID); return r.stopped ? `⏹ Auto Count stopped (last: ${r.lastNumber ?? "-"}, sent ${r.sent}).` : "Walang count na tumatakbo sa GC na ito."; }
        case "stopall": { autoCount.stopAll("chat"); return "⏹ Lahat ng auto count ay pinatay."; }
        default: {
          const list = autoCount.getStatus();
          if (!list.length) return "🔢 Walang auto count na tumatakbo.";
          return "🔢 Auto Count:\n" + list.map((s) => `• ${s.threadID}: last ${s.lastNumber ?? "-"} (${s.sent}/${s.total}) every ${s.intervalSeconds}s${s.suffix ? ` · ${s.suffix}` : ""}`).join("\n");
        }
      }
    },
  },

  target: {
    admin: true,
    run: async ({ args, ev, targetReact, prefix }) => {
      if (!targetReact) return "⚠️ targetReact unavailable.";
      const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] || "list").toLowerCase();
      const threadID = String(ev.threadID);
      const mentioned = [...new Set([...Object.keys(ev.mentions || {}), ...Array.from(String(ev.body || "").matchAll(/@(\d{5,})/g)).map(m => m[1]), ev?.messageReply?.senderID].map(String).filter(Boolean))];
      if (sub === "list") {
        const items = targetReact.list().filter(x => String(x.threadID) === threadID);
        return items.length ? "🎯 Targets sa GC na ito:\n" + items.map(x => `• ${x.userID} ${x.emoji} (${x.reacted || 0} reacts)`).join("\n") : "Walang target sa GC na ito.";
      }
      if (sub === "off" || sub === "remove" || sub === "stop") {
        const r = targetReact.remove(threadID, mentioned[0] || null);
        return r.removed ? `⏹ Tinanggal ang ${r.removed} target.` : "Walang natanggal.";
      }
      // !target on [emoji]  — i-reply sa message ng target, o i-mention siya
      const emoji = (sub === "on" ? parts[1] : parts[0]) || "❤️";
      if (!mentioned.length) return `Format: i-reply sa message ng target (o i-mention), tapos:\n${prefix}target on <emoji>\n${prefix}target off · ${prefix}target list`;
      try {
        const e = targetReact.set(threadID, mentioned[0], emoji);
        return `🎯 Target set: ${e.userID} → ire-react ko ng ${e.emoji}`;
      } catch (err) { return `❌ ${err.message}`; }
    },
  },

  react: {
    run: async ({ args, ev, api, prefix }) => {
      if (!api) return "⚠️ Bot not connected.";
      const emoji = String(args || "").trim() || "❤";
      const replyInfo = ev?.messageReply;
      if (!replyInfo) return `Format: i-reply mo sa message, tapos:\n${prefix}react <emoji>\n\nHal: ${prefix}react ❤`;
      const messageID = extractMessageID(replyInfo);
      if (!messageID) return "⚠️ Di ko makuha ang message ID ng reply.";
      try {
        dispatchMessageReaction(api, emoji, messageID, String(ev.threadID), { onStatus: (state, meta) => { if (state === "failed") console.warn("[REACT]", meta?.error?.message || meta); } });
        return `❤️ Reacted ${emoji}`;
      } catch (e) { return `❌ ${e.message}`; }
    },
  },

  pm: {
    admin: true,
    run: async ({ args, cfg, save, prefix }) => {
      const val = String(args || "").trim().toLowerCase();
      if (val === "on" || val === "off") {
        cfg.pmTroll = val === "on";
        save();
        return `💬 PM Banat: ${cfg.pmTroll ? "ON" : "OFF"}`;
      }
      return `Usage: ${prefix}pm on|off\nCurrent: PM Banat is ${cfg.pmTroll ? "ON" : "OFF"}`;
    },
  },

  on: { admin: true, run: async ({ ev, cfg, save, S }) => { const id = String(ev.threadID); if (!cfg.threads.includes(id)) cfg.threads.push(id); if (!S.running) { S.running = true; S.botSince = Date.now(); } cfg.running = true; save(); return `✅ Naka-ON na ako sa GC na ito. (${cfg.threads.length} GC lahat)`; } },
  off: { admin: true, run: async ({ ev, cfg, save, gc }) => { const id = String(ev.threadID); cfg.threads = cfg.threads.filter((t) => t !== id); gc.stop(id); save(); return `⏹ Naka-OFF na ako sa GC na ito. (${cfg.threads.length} GC na lang)`; } },

  gcname: {
    admin: true,
    run: async ({ args, ev, gc, prefix }) => {
      const [sub = "status", ...rest] = String(args || "").trim().split(/\s+/);
      const tail = rest.join(" ").trim();
      const status = () => { const s = gc.status(); return `🔁 GC name cycle: ${s.on ? "ON" : "OFF"} · ${s.threads.length} GC\nEvery ~${s.intervalS}s · ${s.names.length} names · ${s.changes || 0} changes${s.fails ? ` · ${s.fails} fails` : ""}\nNow: ${s.lastTitle || "—"}`; };
      switch (sub.toLowerCase()) {
        case "start": case "on": { const sec = parseInt(rest[0], 10); gc.start({ threadId: ev.threadID, ...(Number.isFinite(sec) ? { intervalS: sec } : {}) }); return `▶️ GC name cycle ON dito sa chat na ito (${gc.status().threads.length} GC lahat). Hindi titigil hanggang ${prefix}gcname stop.`; }
        case "stop": case "off": if ((rest[0] || "").toLowerCase() === "all") { gc.stop(); return "⏹ GC name cycle OFF sa lahat ng GC."; } gc.stop(ev.threadID); return gc.status().on ? `⏹ Inalis ang GC na ito sa name cycle. (Tuloy pa sa ${gc.status().threads.length} GC. "${prefix}gcname stop all" para patayin lahat.)` : "⏹ GC name cycle OFF.";
        case "now": gc.now(); return "⏭ Next name na...";
        case "list": { const s = gc.status(); return "📝 Names:\n" + s.names.map((n, i) => `${i + 1}. ${n}`).join("\n"); }
        case "add": return tail && gc.add(tail) ? `➕ Added: ${tail}` : `Format: ${prefix}gcname add <pangalan>`;
        case "remove": case "del": return gc.remove(rest[0]) ? "➖ Removed." : `Format: ${prefix}gcname remove <number> (hindi pwedeng maubos lahat)`;
        case "set": return gc.setNames(tail.split("|")) ? `✅ ${gc.status().names.length} names saved.` : `Format: ${prefix}gcname set Name 1 | Name 2 | Name 3`;
        case "interval": return gc.setInterval(rest[0]) ? `⏲ Interval: ${gc.status().intervalS}s (min ${gc.MIN_S}s)` : `Format: ${prefix}gcname interval 45`;
        case "status": default: return status();
      }
    },
  },
  troll: { admin: true, run: async ({ args, cfg, save }) => { const v = String(args || "").trim().toLowerCase(); if (v === "on" || v === "off") { cfg.troll = v === "on"; save(); } return `🤡 Troll replies: ${cfg.troll ? "ON" : "OFF"}`; } },
};

Object.assign(COMMANDS, economy.commands);
Object.assign(COMMANDS, moderation.commands);

function resolve(name) {
  let cmd = COMMANDS[name];
  if (cmd && cmd.alias) cmd = COMMANDS[cmd.alias];
  return cmd || null;
}

function parse(body, prefix) {
  const text = String(body || "").trim();
  if (!text.startsWith(prefix)) return null;
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.slice(prefix.length));
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

function startReminderLoop({ cfg, save, send, ready }) {
  setInterval(() => {
    if (typeof ready === "function" && !ready()) return;
    if (!Array.isArray(cfg.reminders) || !cfg.reminders.length) return;
    const now = Date.now();
    const due = cfg.reminders.filter((r) => r.at <= now);
    if (!due.length) return;
    cfg.reminders = cfg.reminders.filter((r) => r.at > now);
    save();
    for (const r of due) Promise.resolve(send(r.threadID, `⏰ Paalala: ${r.text}`)).catch(() => {});
  }, 5000);
}

let _spamModeInstance = null;
function setSpamModeInstance(instance) { _spamModeInstance = instance; }
function getSpamModeInstance() { return _spamModeInstance; }

module.exports = { COMMANDS, resolve, parse, startReminderLoop, calc, setSpamModeInstance, getSpamModeInstance };
