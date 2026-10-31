let downloadQueue = [];
let activeDownloads = 0;
let isPacing = false;

let adaptiveConcurrency = 8;
const MIN_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

let adaptiveGapMs = 30;
const EWMA_ALPHA = 0.35;
let ewmaVelocityFps = 0;
let prevVelocityFps = 0;
let accelerationFps2 = 0;
let ewmaDownloadRttSec = 0.85;
let lastCompletionWindowTs = Date.now();
let completionsInWindow = 0;

let currentSessionEpoch = 0;
const sessionFileLock = new Set();
const sessionShortcodeLock = new Set();
const sessionUrlPathLock = new Set();
const downloadMap = new Map();

let stats = {
  username: "",
  status: "Idle",
  gridCount: 0,
  reelsCount: 0,
  dupsCount: 0,
  scanned: 0,
  downloaded: 0,
  failed: 0,
  concurrency: 8,
  velocityFps: 0,
  accelerationFps2: 0
};

async function ensureBackgroundKeepAlive(tabId) {
  if (tabId) {
    try {
      await chrome.tabs.update(tabId, { autoDiscardable: false });
    } catch (_) {}
  }
  try {
    if (chrome.offscreen) {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (!hasDoc) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["AUDIO_PLAYBACK", "BLOBS"],
          justification: "Keep InstaSwift 3-Room Instagram scanner & downloader active in background until manually closed."
        });
      }
    }
  } catch (_) {
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Keep background scan & download queue active."
      });
    } catch (__) {}
  }
  try {
    chrome.alarms.create("instaswift_v38_watchdog", { periodInMinutes: 0.25 });
  } catch (_) {}
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "instaswift_offscreen_port") {
    port.onMessage.addListener((msg) => {
      if (msg.type === "HEARTBEAT") {
        reconcileStalledDownloads();
        if (downloadQueue.length > 0 && activeDownloads < Math.floor(adaptiveConcurrency)) {
          processQueue();
        }
      }
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "instaswift_v38_watchdog") {
    reconcileStalledDownloads();
    processQueue();
    broadcastStats();
  }
});

function reconcileStalledDownloads() {
  const now = Date.now();
  for (const [dlId, entry] of downloadMap.entries()) {
    if (now - entry.startedAt > 16000) {
      chrome.downloads.search({ id: dlId }, (results) => {
        if (chrome.runtime.lastError || !results || results.length === 0) {
          if (downloadMap.has(dlId)) {
            downloadMap.delete(dlId);
            handleDownloadFailure(entry.item);
          }
          return;
        }
        const dl = results[0];
        if (dl.state === "complete") {
          if (downloadMap.has(dlId)) {
            downloadMap.delete(dlId);
            activeDownloads = Math.max(0, downloadMap.size);
            stats.downloaded++;
            checkCompletion();
            broadcastStats();
            processQueue();
          }
        } else if (dl.state === "interrupted") {
          if (downloadMap.has(dlId)) {
            downloadMap.delete(dlId);
            handleDownloadFailure(entry.item);
          }
        }
      });
    }
  }
}

function sanitizeWindowsName(name, fallback = "user") {
  if (!name) return fallback;
  let clean = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\.+$/g, "")
    .trim();
  if (!clean || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(clean)) {
    clean = `${fallback}_${clean}`;
  }
  return clean;
}

function buildSafeRelativePath(username, filename) {
  const safeUser = sanitizeWindowsName(username, "profile");
  const parts = String(filename || "media.jpg").split(".");
  const ext = sanitizeWindowsName(parts.pop() || "jpg", "jpg");
  const base = sanitizeWindowsName(parts.join("."), "media");
  return `Instagram/${safeUser}/${base}.${ext}`;
}

function getNormalizedUrlPath(url) {
  try {
    return new URL(url).pathname;
  } catch (_) {
    return String(url || "");
  }
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  if (downloadMap.has(downloadItem.id)) {
    const entry = downloadMap.get(downloadItem.id);
    const forcedPath = buildSafeRelativePath(entry.item.username, entry.item.filename);
    suggest({
      filename: forcedPath,
      conflictAction: "uniquify"
    });
    return;
  }
  suggest();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "INIT_SESSION") {
    const incomingUser = (message.username || "").toLowerCase();
    currentSessionEpoch++;
    ensureBackgroundKeepAlive(sender?.tab?.id);

    downloadQueue = [];
    for (const [dlId] of downloadMap.entries()) {
      downloadMap.delete(dlId);
      try { chrome.downloads.cancel(dlId, () => {}); } catch (_) {}
    }
    activeDownloads = 0;
    isPacing = false;
    adaptiveConcurrency = 8;
    adaptiveGapMs = 30;
    ewmaVelocityFps = 0;
    prevVelocityFps = 0;
    accelerationFps2 = 0;
    ewmaDownloadRttSec = 0.85;
    completionsInWindow = 0;
    lastCompletionWindowTs = Date.now();

    sessionFileLock.clear();
    sessionShortcodeLock.clear();
    sessionUrlPathLock.clear();

    stats = {
      username: incomingUser,
      status: "4-Engine 3-Room Active: Step 1 Grid -> Step 2 Reels -> Step 3 Dedup",
      gridCount: 0,
      reelsCount: 0,
      dupsCount: 0,
      scanned: 0,
      downloaded: 0,
      failed: 0,
      concurrency: 8,
      velocityFps: 0,
      accelerationFps2: 0
    };

    broadcastStats();
    sendResponse({ ok: true });
  }
  else if (message.action === "UPDATE_ROOM_COUNTS") {
    stats.gridCount = message.gridCount ?? stats.gridCount;
    stats.reelsCount = message.reelsCount ?? stats.reelsCount;
    stats.dupsCount = message.dupsCount ?? stats.dupsCount;
    if (message.status) stats.status = message.status;
    broadcastStats();
    sendResponse({ ok: true });
  }
  else if (message.action === "QUEUE_MEDIA") {
    ensureBackgroundKeepAlive(sender?.tab?.id);
    const items = message.items || [];
    for (const item of items) {
      const cleanUser = (item.username || "").toLowerCase();
      const fileKey = `${cleanUser}/${item.filename}`;
      const codeKey = `${cleanUser}/${item.shortcode || item.filename}`;
      const urlPathKey = `${cleanUser}/${getNormalizedUrlPath(item.url)}`;

      if (
        sessionFileLock.has(fileKey) ||
        sessionShortcodeLock.has(codeKey) ||
        sessionUrlPathLock.has(urlPathKey)
      ) {
        continue;
      }

      sessionFileLock.add(fileKey);
      sessionShortcodeLock.add(codeKey);
      sessionUrlPathLock.add(urlPathKey);
      stats.scanned++;
      downloadQueue.push({ ...item, epoch: currentSessionEpoch, retries: 0 });
    }
    stats.status = `Downloading Unique Set (${stats.downloaded} / ${stats.scanned})...`;
    broadcastStats();
    processQueue();
    sendResponse({ ok: true });
  }
  else if (message.action === "QUEUE_SINGLE_MEDIA") {
    ensureBackgroundKeepAlive(sender?.tab?.id);
    const items = message.items || [];
    for (const item of items) {
      const cleanUser = (item.username || "instagram_videos").toLowerCase();
      if (!stats.username) stats.username = cleanUser;
      stats.scanned++;
      downloadQueue.unshift({
        ...item,
        username: cleanUser,
        isSinglePriority: true,
        epoch: currentSessionEpoch,
        retries: 0
      });
    }
    stats.status = `Downloading Single Video/Post (${stats.downloaded} / ${stats.scanned})...`;
    broadcastStats();
    processQueue();
    sendResponse({ ok: true });
  }
  else if (message.action === "SCAN_FINISHED") {
    if (activeDownloads === 0 && downloadQueue.length === 0) {
      stats.status = "Completed";
    } else {
      stats.status = `Downloading (${stats.downloaded} / ${stats.scanned})...`;
    }
    broadcastStats();
    sendResponse({ ok: true });
  }
  else if (message.action === "USER_EXPLICIT_STOP") {
    currentSessionEpoch++;
    downloadQueue = [];
    for (const [downloadId] of downloadMap.entries()) {
      downloadMap.delete(downloadId);
      try {
        chrome.downloads.cancel(downloadId, () => {});
      } catch (_) {}
    }
    activeDownloads = 0;
    isPacing = false;
    stats.status = "Stopped";
    broadcastStats();
    sendResponse({ ok: true });
  }
  else if (message.action === "GET_STATS") {
    sendResponse(stats);
  }
  return true;
});

function processQueue() {
  if (isPacing) return;
  const maxAllowed = Math.floor(adaptiveConcurrency);
  if (activeDownloads >= maxAllowed || downloadQueue.length === 0) return;

  isPacing = true;
  const burstCount = Math.min(4, maxAllowed - activeDownloads, downloadQueue.length);
  for (let i = 0; i < burstCount; i++) {
    const item = downloadQueue.shift();
    if (!item || (!item.isSinglePriority && item.epoch !== currentSessionEpoch)) continue;
    activeDownloads++;
    startDownload(item);
  }

  setTimeout(() => {
    isPacing = false;
    if (activeDownloads < Math.floor(adaptiveConcurrency) && downloadQueue.length > 0) {
      processQueue();
    }
  }, adaptiveGapMs);
}

function startDownload(item) {
  const filePath = buildSafeRelativePath(item.username, item.filename);

  chrome.downloads.download(
    {
      url: item.url,
      filename: filePath,
      conflictAction: "uniquify",
      saveAs: false
    },
    (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        handleDownloadFailure(item);
      } else {
        downloadMap.set(downloadId, {
          item,
          startedAt: Date.now(),
          epoch: item.epoch
        });
      }
    }
  );
}

function handleDownloadFailure(item) {
  activeDownloads = Math.max(0, downloadMap.size);
  if (!item.isSinglePriority && item.epoch !== currentSessionEpoch) {
    processQueue();
    return;
  }

  adaptiveConcurrency = Math.max(MIN_CONCURRENCY, adaptiveConcurrency * 0.78);
  adaptiveGapMs = Math.min(200, Math.round(adaptiveGapMs * 1.25));
  stats.concurrency = Math.floor(adaptiveConcurrency);

  if (item.retries < 4 && stats.status !== "Stopped") {
    item.retries++;
    const jitterBackoffMs = Math.floor(Math.random() * (350 * Math.pow(2, item.retries)));
    setTimeout(() => {
      if ((item.isSinglePriority || item.epoch === currentSessionEpoch) && stats.status !== "Stopped") {
        downloadQueue.push(item);
        processQueue();
      }
    }, jitterBackoffMs);
  } else {
    stats.failed++;
    checkCompletion();
    broadcastStats();
    processQueue();
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!downloadMap.has(delta.id)) return;
  const entry = downloadMap.get(delta.id);

  if (delta.state && delta.state.current === "complete") {
    downloadMap.delete(delta.id);
    activeDownloads = Math.max(0, downloadMap.size);
    stats.downloaded++;

    const elapsedSec = Math.max(0.08, (Date.now() - entry.startedAt) / 1000);
    ewmaDownloadRttSec = EWMA_ALPHA * elapsedSec + (1 - EWMA_ALPHA) * ewmaDownloadRttSec;

    completionsInWindow++;
    const windowSec = (Date.now() - lastCompletionWindowTs) / 1000;
    if (windowSec >= 0.75) {
      const instVelocity = completionsInWindow / windowSec;
      prevVelocityFps = ewmaVelocityFps;
      ewmaVelocityFps = Number(
        (EWMA_ALPHA * instVelocity + (1 - EWMA_ALPHA) * ewmaVelocityFps).toFixed(1)
      );
      accelerationFps2 = Number(((ewmaVelocityFps - prevVelocityFps) / windowSec).toFixed(1));
      stats.velocityFps = ewmaVelocityFps;
      stats.accelerationFps2 = accelerationFps2;
      completionsInWindow = 0;
      lastCompletionWindowTs = Date.now();
    }

    const littlesLawW = Math.ceil(ewmaVelocityFps * ewmaDownloadRttSec) + 4;
    if (elapsedSec < 2.2) {
      adaptiveConcurrency = Math.min(
        MAX_CONCURRENCY,
        Math.max(adaptiveConcurrency + 0.55, littlesLawW)
      );
    }
    adaptiveGapMs = Math.max(
      20,
      Math.min(200, Math.round(45 - 1.5 * ewmaVelocityFps - 0.8 * accelerationFps2))
    );
    stats.concurrency = Math.floor(adaptiveConcurrency);

    checkCompletion();
    broadcastStats();
    processQueue();
  } else if (delta.state && delta.state.current === "interrupted") {
    downloadMap.delete(delta.id);
    const err = delta.error?.current || "";
    if (err === "USER_CANCELED" || stats.status === "Stopped") {
      activeDownloads = Math.max(0, downloadMap.size);
      stats.failed++;
      checkCompletion();
      broadcastStats();
      processQueue();
    } else {
      handleDownloadFailure(entry.item);
    }
  }
});

function checkCompletion() {
  if (stats.status === "Stopped") return;
  if (activeDownloads === 0 && downloadQueue.length === 0 && stats.scanned > 0) {
    stats.status = `✅ Download Complete! Saved ${stats.downloaded} / ${stats.scanned} unique files.`;
  } else if (stats.scanned > 0) {
    stats.status = `Downloading (${stats.downloaded} / ${stats.scanned} saved)...`;
  }
}

function broadcastStats() {
  chrome.tabs.query({ url: "https://www.instagram.com/*" }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { action: "STATS_UPDATE", stats }).catch(() => {});
    }
  });
}