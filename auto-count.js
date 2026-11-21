"use strict";

// Auto Count: nagse-send ng 1, 2, 3, ... sa GC (pang-resibo), may custom suffix.
// Hal. suffix "🎄" => "1 🎄", "2 🎄", "3 🎄"

const MIN_INTERVAL_SECONDS = 2;
const MAX_INTERVAL_SECONDS = 3600;
const MAX_COUNT = 1000;
const MAX_SUFFIX_LENGTH = 100;
const MAX_START = 1000000000;

function formatCountMessage(n, suffix = "") {
  const tail = String(suffix ?? "").trim();
  return tail ? `${n} ${tail}` : String(n);
}

function createAutoCount({ getApi, sendMessage, isAuthorized = () => true, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const runs = new Map();

  function stop(threadID) {
    const key = String(threadID || "").trim();
    const run = runs.get(key);
    if (!run) return { stopped: false, threadID: key };
    run.stopped = true;
    if (run.timer) clearTimeoutFn(run.timer);
    runs.delete(key);
    console.log(`[AUTO COUNT] stopped thread=${key} last=${run.lastNumber ?? "-"} sent=${run.sent}`);
    return { stopped: true, threadID: key, sent: run.sent, lastNumber: run.lastNumber };
  }

  function stopAll(reason = "manual") {
    const out = [];
    for (const key of [...runs.keys()]) { out.push(stop(key)); console.log(`[AUTO COUNT] stopped by ${reason}: ${key}`); }
    return { stopped: out.length };
  }

  function getStatus() {
    return [...runs.values()].map(r => ({
      threadID: r.threadID, intervalSeconds: r.intervalSeconds, suffix: r.suffix,
      startFrom: r.startFrom, total: r.total, sent: r.sent, lastNumber: r.lastNumber,
      lastSentAt: r.lastSentAt, nextSendAt: r.nextSendAt, startedAt: r.startedAt,
    }));
  }

  async function tick(run) {
    if (run.stopped || runs.get(run.threadID) !== run) return;
    if (!isAuthorized()) return stop(run.threadID);
    const api = typeof getApi === "function" ? getApi() : null;
    if (!api || typeof sendMessage !== "function") return stop(run.threadID);
    try {
      const n = run.startFrom + run.sent;
      await sendMessage(api, formatCountMessage(n, run.suffix), run.threadID);
      if (run.stopped || runs.get(run.threadID) !== run) return;
      run.sent++; run.lastNumber = n; run.lastSentAt = new Date().toISOString();
      if (run.sent >= run.total) return stop(run.threadID);
      run.nextSendAt = new Date(Date.now() + run.intervalSeconds * 1000).toISOString();
      run.timer = setTimeoutFn(() => tick(run), run.intervalSeconds * 1000);
      run.timer.unref?.();
    } catch (error) {
      console.error(`[AUTO COUNT] stopped after send failure in ${run.threadID}:`, error?.message || error);
      stop(run.threadID);
    }
  }

  function start(input = {}) {
    const threadID = String(input.threadID || "").trim();
    const intervalSeconds = Number(input.intervalSeconds);
    const total = Number(input.total ?? input.max ?? 100);
    const startFrom = Number(input.startFrom ?? 1);
    const suffix = String(input.suffix ?? "").trim();
    if (!threadID || threadID.length > 128) throw new Error("Choose a valid Messenger group.");
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS) throw new Error(`Interval must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds.`);
    if (!Number.isInteger(total) || total < 1 || total > MAX_COUNT) throw new Error(`Count total must be between 1 and ${MAX_COUNT}.`);
    if (!Number.isInteger(startFrom) || startFrom < 0 || startFrom > MAX_START) throw new Error("Start number must be a whole number (0 or higher).");
    if (suffix.length > MAX_SUFFIX_LENGTH) throw new Error(`Suffix is limited to ${MAX_SUFFIX_LENGTH} characters.`);
    if (!isAuthorized()) throw new Error("Bot must be connected to start Auto Count.");
    if (runs.has(threadID)) throw new Error("Auto Count is already running in this group. Stop it first.");

    const run = { threadID, intervalSeconds, total, startFrom, suffix, sent: 0, lastNumber: null, lastSentAt: null, stopped: false, timer: null, startedAt: new Date().toISOString(), nextSendAt: null };
    runs.set(threadID, run);
    run.nextSendAt = new Date(Date.now() + intervalSeconds * 1000).toISOString();
    run.timer = setTimeoutFn(() => tick(run), intervalSeconds * 1000);
    run.timer.unref?.();
    console.log(`[AUTO COUNT] started thread=${threadID} from=${startFrom} total=${total} interval=${intervalSeconds}s suffix="${suffix}"`);
    return { threadID, intervalSeconds, total, startFrom, suffix, firstSendInSeconds: intervalSeconds, endsAt: startFrom + total - 1 };
  }

  return { start, stop, stopAll, getStatus };
}

module.exports = { createAutoCount, formatCountMessage, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, MAX_COUNT, MAX_SUFFIX_LENGTH };
