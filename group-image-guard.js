"use strict";
const fs = require("fs");
const path = require("path");

function createGroupImageGuard(options = {}) {
  const store = options.store;
  const getApi = options.getApi || (() => null);
  const cooldownMs = Math.max(30000, Number(options.cooldownMs) || 120000);
  const lastRepair = new Map();
  const inFlight = new Set();
  let timer = null;
  let stopped = false;

  function invoke(api, method, args) {
    return new Promise((resolve, reject) => {
      if (!api || typeof api[method] !== "function") return reject(new Error("Messenger API method " + method + " is unavailable."));
      let settled = false;
      const done = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
      try {
        const returned = api[method](...args, done);
        if (returned && typeof returned.then === "function") returned.then(value => done(null, value)).catch(done);
      } catch (error) { done(error); }
    });
  }

  async function repair(threadID, reason = "event") {
    if (stopped || inFlight.has(threadID)) return { skipped: true };
    const now = Date.now();
    if (now - Number(lastRepair.get(threadID) || 0) < cooldownMs) return { skipped: true, cooldown: true };
    
    const config = await store.getGroupImage(threadID);
    if (!config || !config.imageUrl) return { skipped: true };
    
    const api = getApi();
    if (!api) return { skipped: true, offline: true };
    inFlight.add(threadID);
    
    try {
      // Kung sinusuportahan ng FCA mo ang URL directly sa changeGroupImage
      // Kung hindi, kailangan i-download. Dito, assume natin na pwede ang URL stream.
      // Sa ibang FCA, kailangan ng stream. Gagamtin natin ang changeGroupImage na may stream kung possible.
      
      // NOTE: Karamihan ng FCA ngayon ay tumatanggap ng URL o Readable stream.
      // I-a-attempt nating gamitin ang URL directly. Kung mag-fail, mag-log tayo.
      
      await invoke(api, "changeGroupImage", [config.imageUrl, String(threadID)]);
      lastRepair.set(threadID, now);
      console.info("[GROUP IMAGE LOCK] Restored group image", { thread_id: threadID, reason });
      return { ok: true, restored: true };
    } catch (error) {
      console.warn("[GROUP IMAGE LOCK] Repair failed:", error?.message || error);
      return { ok: false, error: error.message };
    } finally {
      inFlight.delete(threadID);
    }
  }

  async function handleEvent(event) {
    if (!event?.threadID) return;
    const type = [event.type, event.logMessageType, event.logMessageData?.type].filter(Boolean).join(" ").toLowerCase();
    if (type && !/(thread.?image|group.?image|photo)/i.test(type)) return;
    try { await repair(String(event.threadID), "group-image-event"); }
    catch (error) { console.warn("[GROUP IMAGE LOCK] Event repair failed:", error?.message || error); }
  }

  async function reconcile() {
    if (stopped || !store?.isInitialized?.()) return;
    try {
      const groups = await store.listProtectedImages();
      for (const group of groups) {
        try { await repair(String(group.threadID), "periodic-reconcile"); }
        catch (error) { console.warn("[GROUP IMAGE LOCK] Reconcile failed:", error?.message || error); }
      }
    } catch (error) { console.warn("[GROUP IMAGE LOCK] Could not load protected groups:", error?.message || error); }
  }

  function start() {
    if (stopped || timer) return;
    void reconcile();
    timer = setInterval(() => void reconcile(), 10 * 60 * 1000);
    if (typeof timer.unref === "function") timer.unref();
  }

  function pause() { if (timer) clearInterval(timer); timer = null; }
  function stop() { stopped = true; pause(); inFlight.clear(); }

  return { start, pause, stop, handleEvent, repair };
}
module.exports = { createGroupImageGuard };
