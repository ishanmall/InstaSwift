if (navigator.locks && navigator.locks.request) {
  navigator.locks.request("instaswift_v16_permanent_lock", () => new Promise(() => {}));
}

let port = null;
function connectPort() {
  try {
    port = chrome.runtime.connect({ name: "instaswift_offscreen_port" });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectPort, 300);
    });
  } catch (_) {}
}
connectPort();

setInterval(() => {
  try {
    if (port) {
      port.postMessage({ type: "HEARTBEAT", ts: Date.now() });
    } else {
      connectPort();
    }
    chrome.runtime.sendMessage({ action: "OFFSCREEN_HEARTBEAT" }).catch(() => {});
  } catch (_) {
    connectPort();
  }
}, 750);