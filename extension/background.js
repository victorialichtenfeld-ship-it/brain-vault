// Brain Data Vault Sensor: background worker.
// Holds recordings until the vault page collects and encrypts them. A recording
// is timing numbers only: no letters, no page addresses.
"use strict";
const VAULT_ORIGINS = ["http://127.0.0.1:5180", "http://localhost:5180"];
const MAX_WAITING = 200; // oldest recordings are dropped beyond this
const BATCH = 10;        // recordings handed to the vault page per request

// One storage change at a time, so two tabs cannot overwrite each other.
let queue = Promise.resolve();
const inOrder = (fn) => (queue = queue.then(fn, fn));

async function setPending(pending) {
  await chrome.storage.local.set({ pending });
  chrome.action.setBadgeText({ text: pending.length ? String(pending.length) : "" });
}
const fromVault = (sender) => VAULT_ORIGINS.some((o) => (sender.url || "").startsWith(o + "/"));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || sender.id !== chrome.runtime.id || !sender.tab) return;
  if (msg.type === "chunk") {
    inOrder(async () => {
      const { pending = [], paused = false } = await chrome.storage.local.get(["pending", "paused"]);
      if (!paused) await setPending(pending.concat([msg.d]).slice(-MAX_WAITING));
    });
    return;
  }
  if (!fromVault(sender)) return;
  if (msg.type === "pending") {
    inOrder(async () => {
      const { pending = [], paused = false } = await chrome.storage.local.get(["pending", "paused"]);
      reply({ items: pending.slice(0, BATCH), total: pending.length, paused });
    });
    return true;
  }
  if (msg.type === "ack") {
    inOrder(async () => {
      const { pending = [] } = await chrome.storage.local.get("pending");
      await setPending(pending.slice(1));
      reply({ ok: true });
    });
    return true;
  }
});
