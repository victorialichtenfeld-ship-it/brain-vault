"use strict";
const $ = (id) => document.getElementById(id);
async function show() {
  const { pending = [], paused = false } = await chrome.storage.local.get(["pending", "paused"]);
  $("state").innerHTML = `${paused ? "Paused." : "<b>On.</b>"} <b>${pending.length}</b> recording${pending.length === 1 ? "" : "s"} waiting for your vault. Open the vault page and unlock it to collect them.`;
  $("toggle").textContent = paused ? "Resume" : "Pause";
}
$("toggle").onclick = async () => {
  const { paused = false } = await chrome.storage.local.get("paused");
  await chrome.storage.local.set({ paused: !paused });
  show();
};
$("clear").onclick = async () => {
  await chrome.storage.local.set({ pending: [] });
  chrome.action.setBadgeText({ text: "" });
  show();
};
show();
