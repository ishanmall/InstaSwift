if (navigator.locks && navigator.locks.request) {
  navigator.locks.request("instaswift_os_wakelock", () => new Promise(() => {}));
}

let audioCtx = null;
function startSilentAudioWakeLock() {
  try {
    if (audioCtx && audioCtx.state === "running") return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioCtx = new AudioContextClass();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.00001;
    osc.frequency.value = 1;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
  } catch (_) {}
}
startSilentAudioWakeLock();

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
  startSilentAudioWakeLock();
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
}, 500);