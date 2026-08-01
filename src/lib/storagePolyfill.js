/**
 * The app's save/load-configuration and theme-persistence features were
 * originally written against `window.storage`, an in-browser key/value API
 * that only exists inside Claude's artifact preview. Outside that sandbox
 * (i.e. once this is a real deployed site) that global doesn't exist, so
 * this file provides a drop-in replacement backed by the browser's
 * `localStorage`, with the same method names and return shapes. No app code
 * had to change — this just installs `window.storage` before React renders.
 */
const PREFIX = "smart-timetable:";

function readAll() {
  return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
}

const storagePolyfill = {
  async get(key) {
    const ls = readAll();
    if (!ls) return null;
    const raw = ls.getItem(PREFIX + key);
    if (raw === null) return null;
    return { key, value: raw, shared: false };
  },
  async set(key, value) {
    const ls = readAll();
    if (!ls) return null;
    ls.setItem(PREFIX + key, value);
    return { key, value, shared: false };
  },
  async delete(key) {
    const ls = readAll();
    if (!ls) return null;
    ls.removeItem(PREFIX + key);
    return { key, deleted: true, shared: false };
  },
  async list(prefix) {
    const ls = readAll();
    if (!ls) return { keys: [] };
    const keys = Object.keys(ls)
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => k.slice(PREFIX.length))
      .filter((k) => !prefix || k.startsWith(prefix));
    return { keys };
  },
};

if (typeof window !== "undefined" && !window.storage) {
  window.storage = storagePolyfill;
}

export default storagePolyfill;
