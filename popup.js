const fmtSelect = document.getElementById("p-fmt");

chrome.storage.local.get(["instaswift_img_format"], (res) => {
  if (res?.instaswift_img_format) {
    fmtSelect.value = res.instaswift_img_format;
  }
});

fmtSelect.addEventListener("change", () => {
  const format = fmtSelect.value;
  chrome.storage.local.set({ instaswift_img_format: format });
  chrome.runtime.sendMessage({ action: "SET_IMAGE_FORMAT", format });
});

function refreshPopupStats() {
  chrome.runtime.sendMessage({ action: "GET_STATS" }, (stats) => {
    if (chrome.runtime.lastError || !stats) return;
    document.getElementById("p-status").textContent =
      `${stats.status}` + (stats.username ? ` (@${stats.username}) — Saved: ${stats.savedToDisk}/${stats.totalQueued}` : "");
    document.getElementById("p-posts").textContent =
      stats.expectedPosts > 0 ? `${stats.gridPostsMatched}/${stats.expectedPosts}` : (stats.gridPostsMatched || 0);
    document.getElementById("p-reels").textContent = stats.uniqueReelsMatched || 0;
  });
}

document.getElementById("p-trigger").addEventListener("click", () => {
  const format = fmtSelect.value;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "TRIGGER_FROM_POPUP", format }, () => {
        window.close();
      });
    }
  });
});

refreshPopupStats();
setInterval(refreshPopupStats, 600);