"use strict";

// Target React: kapag nag-message ang target (UID) sa isang GC, kusang magre-react ang bot account (self) sa message niya.

const MAX_TARGETS = 50;

function createTargetReact({ getApi, getSelfId, getList, saveList, dispatchReaction, extractMessageID, delayRangeMs = [700, 2200] } = {}) {
  const cleanEmoji = (e) => { const v = String(e ?? "").trim(); return v && v.length <= 16 ? v : "❤️"; };
  const key = (t, u) => `${String(t).trim()}:${String(u).trim()}`;

  function list() { return (typeof getList === "function" ? getList() : []) || []; }

  function set(threadID, userID, emoji) {
    const t = String(threadID || "").trim(), u = String(userID || "").trim();
    if (!t || t.length > 128) throw new Error("Choose a valid Messenger group.");
    if (!/^\d{5,25}$/.test(u)) throw new Error("Target must be a numeric Facebook ID.");
    const items = list().filter(x => key(x.threadID, x.userID) !== key(t, u));
    if (items.length >= MAX_TARGETS) throw new Error(`Max ${MAX_TARGETS} targets.`);
    const entry = { threadID: t, userID: u, emoji: cleanEmoji(emoji), addedAt: new Date().toISOString(), reacted: 0 };
    items.push(entry); saveList(items); return entry;
  }

  function remove(threadID, userID) {
    const before = list();
    const after = before.filter(x => !(String(x.threadID) === String(threadID) && (!userID || String(x.userID) === String(userID))));
    saveList(after); return { removed: before.length - after.length };
  }

  function onMessage(ev) {
    try {
      const api = typeof getApi === "function" ? getApi() : null;
      if (!api || !ev || !ev.threadID || !ev.senderID) return;
      if (String(ev.senderID) === String(getSelfId?.())) return;
      const items = list();
      const hit = items.find(x => String(x.threadID) === String(ev.threadID) && String(x.userID) === String(ev.senderID));
      if (!hit) return;
      const messageID = extractMessageID(ev);
      if (!messageID) return;
      const [lo, hi] = delayRangeMs;
      setTimeout(() => {
        dispatchReaction(api, hit.emoji, messageID, String(ev.threadID), {
          onStatus: (state, meta) => { if (state === "failed") console.warn("[TARGET REACT]", meta?.error?.message || meta); },
        });
        hit.reacted = (hit.reacted || 0) + 1;
        if (hit.reacted % 10 === 1) saveList(items); // huwag mag-save sa bawat react
      }, lo + Math.floor(Math.random() * Math.max(1, hi - lo))).unref?.();
    } catch (e) { console.warn("[TARGET REACT]", e?.message || e); }
  }

  return { set, remove, list, onMessage };
}

module.exports = { createTargetReact, MAX_TARGETS };
