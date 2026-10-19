// 1. Permanent Web Lock so Chromium never collects the offscreen document
if (navigator.locks && navigator.locks.request) {
  navigator.locks.request("instaswift_v17_os_wakelock", () => new Promise(() => {}));
}

// 2. Ultra-quiet (inaudible) WebAudio loop so Windows OS & Chrome Resource Saver
// treat the browser process as playing active audio and NEVER freeze it when minimized to VS Code!
let audioCtx = null;
function startSilentAudioWakeLock() {
  try {
    if (audioCtx && audioCtx.state === "running") return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioCtx = new AudioContextClass();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    // 0.00001 gain is completely inaudible to speakers/headphones but keeps Windows Multimedia thread active
    gain.gain.value = 0.00001;
    osc.frequency.value = 1;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
  } catch (_) {}
}
startSilentAudioWakeLock();

// 3. High-frequency persistent port + MessageChannel pulse (bypasses timer throttling)
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