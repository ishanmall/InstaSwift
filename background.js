let downloadQueue = [];
let activeDownloads = 0;
const MAX_CONCURRENT_DOWNLOADS = 4;

const sessionSeenKeys = new Set();
const downloadMap = new Map();
let forcedImageFormat = "auto";

let stats = {
  username: "",
  status: "Idle",
  gridPostsFiles: 0,
  reelsOnlyFiles: 0
};

function resolveExtensionFromMime(mime, item) {
  if (item.convertedFormat) {
    return item.convertedFormat;
  }
  const m = (mime || "").toLowerCase();
  if (m.includes("image/png")) return "png";
  if (m.includes("image/jpeg") || m.includes("image/jpg")) return "jpg";
  if (m.includes("image/webp")) return "webp";
  if (m.includes("video/mp4")) return "mp4";
  return item.extHint || "jpg";
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const tracked = downloadMap.get(downloadItem.id);
  if (!tracked) {
    suggest();
    return;
  }

  const cleanUser = tracked.username.replace(/[^a-zA-Z0-9._-]/g, "_");
  const baseName = tracked.baseFilename || tracked.filename.replace(/\.[^.]+$/, "");
  const trueExt = resolveExtensionFromMime(downloadItem.mime, tracked);

  suggest({
    filename: `Instagram/${cleanUser}/${baseName}.${trueExt}`,
    conflictAction: "overwrite"
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "INIT_SESSION") {
    downloadQueue = [];
    sessionSeenKeys.clear();
    downloadMap.clear();
    activeDownloads = 0;
    if (message.format) forcedImageFormat = message.format;

    stats = {
      username: message.username,
      status: "Scanning Grid Posts & Reels...",
      gridPostsFiles: 0,
      reelsOnlyFiles: 0
    };
    broadcastStats();
    sendResponse({ ok: true });
  }
  else if (message.action === "SET_IMAGE_FORMAT") {
    forcedImageFormat = message.format || "auto";
    sendResponse({ ok: true });
  }
  else if (message.action === "DOWNLOAD_ITEMS") {
    const items = message.items || [];
    for (const item of items) {
      const uniqueKey = `${item.username}/${item.uid}`;
      if (sessionSeenKeys.has(uniqueKey)) continue;
      sessionSeenKeys.add(uniqueKey);

      if (item.section === "reels") {
        stats.reelsOnlyFiles++;
      } else {
        stats.gridPostsFiles++;
      }

      downloadQueue.push({ ...item, retries: 0 });
    }
    broadcastStats();
    processQueue();
    sendResponse({ ok: true });
  }
  else if (message.action === "SCAN_FINISHED") {
    if (activeDownloads === 0 && downloadQueue.length === 0) {
      stats.status = "Completed";
    } else {
      stats.status = "Finishing Downloads...";
    }
    broadcastStats();
    sendResponse({ ok: true });
  }
  else if (message.action === "STOP_ALL") {
    downloadQueue = [];
    for (const [downloadId] of downloadMap.entries()) {
      downloadMap.delete(downloadId);
      try {
        chrome.downloads.cancel(downloadId, () => {});
      } catch (_) {}
    }
    activeDownloads = 0;
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
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
    const item = downloadQueue.shift();
    activeDownloads++;
    startDownload(item);
  }
}

function startDownload(item) {
  const cleanUser = item.username.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = `Instagram/${cleanUser}/${item.filename}`;

  chrome.downloads.download(
    {
      url: item.url,
      filename: filePath,
      conflictAction: "overwrite",
      saveAs: false
    },
    (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        handleFailure(item);
      } else {
        downloadMap.set(downloadId, item);
      }
    }
  );
}

function handleFailure(item) {
  activeDownloads = Math.max(0, activeDownloads - 1);
  if (item.retries < 2 && stats.status !== "Stopped") {
    item.retries++;
    downloadQueue.push(item);
  }
  checkAllDone();
  broadcastStats();
  processQueue();
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!downloadMap.has(delta.id)) return;
  const item = downloadMap.get(delta.id);

  if (delta.state && delta.state.current === "complete") {
    downloadMap.delete(delta.id);
    activeDownloads = Math.max(0, activeDownloads - 1);
    checkAllDone();
    broadcastStats();
    processQueue();
  } else if (delta.state && delta.state.current === "interrupted") {
    downloadMap.delete(delta.id);
    handleFailure(item);
  }
});

function checkAllDone() {
  if (activeDownloads === 0 && downloadQueue.length === 0 && stats.status === "Finishing Downloads...") {
    stats.status = "Completed";
  }
}

function broadcastStats() {
  chrome.tabs.query({ url: "https://www.instagram.com/*" }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { action: "STATS_UPDATE", stats }).catch(() => {});
    }
  });
}