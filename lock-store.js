"use strict";
const fs = require("fs");
const path = require("path");

function createLockStore({ dataDir }) {
  const file = path.join(dataDir || ".", "locks.json");

  function read() {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { return { titles: {}, nicknames: {} }; }
  }
  function write(data) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    } catch (e) { console.warn("[LOCK STORE] write failed:", e.message); }
  }

  return {
    isInitialized: () => true,
    async getGroup(threadID) {
      const g = read().titles[String(threadID)];
      return g ? { autolockEnabled: !!g.enabled, expectedTitle: String(g.title || "") } : { autolockEnabled: false, expectedTitle: "" };
    },
    async listProtectedGroups() {
      const t = read().titles;
      return Object.entries(t).filter(([, v]) => v.enabled && v.title).map(([threadID, v]) => ({ threadID, expectedTitle: String(v.title) }));
    },
    setGroupTitleLock(threadID, title, enabled) {
      const d = read(); d.titles[String(threadID)] = { title: String(title), enabled: !!enabled }; write(d);
    },
    removeGroupTitleLock(threadID) {
      const d = read(); delete d.titles[String(threadID)]; write(d);
    },
    async getNicknameLocks(threadID) {
      const n = read().nicknames[String(threadID)] || {};
      return Object.entries(n).map(([userID, expectedNickname]) => ({ userID, expectedNickname }));
    },
    async listNicknameLocks() {
      const n = read().nicknames;
      return Object.entries(n).flatMap(([threadID, users]) => Object.entries(users).map(([userID, expectedNickname]) => ({ threadID, userID, expectedNickname })));
    },
    async deleteNicknameLock(threadID, userID) {
      const d = read();
      if (d.nicknames[String(threadID)]) { delete d.nicknames[String(threadID)][String(userID)]; write(d); }
    },
    saveNicknameLock(threadID, userID, expectedNickname) {
      const d = read(); d.nicknames[String(threadID)] ||= {}; d.nicknames[String(threadID)][String(userID)] = String(expectedNickname); write(d);
    },
    clearNicknamesForThread(threadID) {
      const d = read(); delete d.nicknames[String(threadID)]; write(d);
    },
  };
}
module.exports = { createLockStore };
