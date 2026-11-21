"use strict";
const fs = require("fs");
const path = require("path");

const MAX_SESSION_BYTES = 120 * 1024;

function normalizeSessionInput(value) {
  if (typeof value !== "string") throw new Error("Paste a cookie string or a JSON appstate export.");
  const input = value.trim();
  if (!input || Buffer.byteLength(input, "utf8") > MAX_SESSION_BYTES) {
    throw new Error("Paste a valid session (maximum 120 KB).");
  }
  if (input.startsWith("[") || input.startsWith("{")) {
    let parsed;
    try { parsed = JSON.parse(input); }
    catch (_) { throw new Error("The JSON appstate is invalid. Paste the complete cookie array or appstate object."); }
    const entries = Array.isArray(parsed) ? parsed :
      Array.isArray(parsed?.appState) ? parsed.appState :
      Array.isArray(parsed?.cookies) ? parsed.cookies : null;
    if (!entries) throw new Error("JSON must be a cookie array or an object containing an appState or cookies array.");
    const parts = entries.map(cookie => {
      const name = cookie?.key ?? cookie?.name;
      const val = cookie?.value;
      if (name == null || val == null) return null;
      const safeName = String(name).trim();
      if (!safeName || /[=;\s]/.test(safeName) || /[\r\n;]/.test(String(val))) return null;
      return safeName + "=" + String(val);
    }).filter(Boolean);
    if (!parts.length) throw new Error("The appstate contains no valid cookie entries with name/key and value.");
    const normalized = parts.join("; ");
    if (Buffer.byteLength(normalized, "utf8") > MAX_SESSION_BYTES) throw new Error("Normalized cookie session exceeds 120 KB.");
    if (!/(?:^|;\s*)c_user=[^;]+/i.test(normalized)) throw new Error("Appstate must include a c_user cookie.");
    return normalized;
  }
  if (/[\r\n]/.test(input)) throw new Error("Cookie-header format must be a single line. For multiline exports, paste the complete JSON appstate instead.");
  if (!/(?:^|;\s*)c_user=[^;]+/i.test(input)) throw new Error("Cookie string must include a c_user cookie. Alternatively, paste the complete JSON appstate export.");
  return input;
}

function createSessionStore({ dataDir }) {
  const file = path.join(dataDir || ".", "appstate.txt");

  function save(value) {
    const cookie = normalizeSessionInput(value);
    fs.mkdirSync(dataDir || ".", { recursive: true });
    fs.writeFileSync(file, cookie, "utf8");
    return { saved: true, storage: "file", survivesRestart: true };
  }
  function read() {
    try { return fs.readFileSync(file, "utf8").trim() || null; }
    catch { return null; }
  }
  function status() {
    return { configured: !!read(), storage: "file", survivesRestart: true };
  }
  function clear() {
    try { fs.unlinkSync(file); } catch {}
    return { configured: false, storage: "file" };
  }

  return { save, read, status, clear };
}

module.exports = { createSessionStore, normalizeSessionInput, MAX_SESSION_BYTES };
