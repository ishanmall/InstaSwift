if (navigator.locks && navigator.locks.request) {
  navigator.locks.request("instaswift_v29_bg_lock", () => new Promise(() => {}));
}

let audioCtx = null;
function ensureAudioWakeLock() {
  try {
    if (audioCtx && audioCtx.state === "running") return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.00001;
    osc.frequency.value = 1;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
  } catch (_) {}
}
ensureAudioWakeLock();

let port = null;
function connectPort() {
  try {
    port = chrome.runtime.connect({ name: "instaswift_offscreen_port" });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectPort, 200);
    });
  } catch (_) {}
}
connectPort();

setInterval(() => {
  ensureAudioWakeLock();
  try {
    if (port) port.postMessage({ type: "HEARTBEAT", ts: Date.now() });
    else connectPort();
  } catch (_) {
    connectPort();
  }
}, 400);