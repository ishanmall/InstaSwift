let preferredImageFormat = "auto";
let latestSessionMeta = {
  csrfToken: "",
  lsdToken: "",
  wwwClaim: "0",
  postsDocId: "9310670392322965",
  reelsDocId: "7898261790222653",
  postsReqTemplate: "",
  reelsReqTemplate: ""
};

let tabAudioCtx = null;
function activateTabWakeLock() {
  try {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request("instaswift_tab_active_lock", () => new Promise(() => {}));
    }
    if (!tabAudioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        tabAudioCtx = new AudioCtx();
        const osc = tabAudioCtx.createOscillator();
        const gain = tabAudioCtx.createGain();
        gain.gain.value = 0.00001;
        osc.connect(gain);
        gain.connect(tabAudioCtx.destination);
        osc.start();
      }
    } else if (tabAudioCtx.state === "suspended") {
      tabAudioCtx.resume().catch(() => {});
    }
  } catch (_) {}
}

const mediaCacheByShortcode = new Map();
const storyItemsByPk = new Map();
const storyTraysByUser = new Map();
const rawInterceptBuffer = [];
const pendingRpcMap = new Map();
let rpcCounter = 0;

const RESERVED_PATHS = new Set([
  "explore", "reels", "direct", "accounts", "p", "reel", "stories", "tv", "challenge"
]);

try {
  chrome.storage.local.get(["instaswift_img_format"], (res) => {
    if (res?.instaswift_img_format) {
      preferredImageFormat = res.instaswift_img_format;
    }
  });
} catch (_) {}

function cleanPk(raw) {
  if (!raw) return "";
  return String(raw).split("_")[0].trim();
}

function safeSendMessage(payload) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.id) {
        updateHUDStatus("⚠️ Extension reloaded! Please press F5 to refresh this page.");
        resolve(null);
        return;
      }
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response);
        }
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function callMainWorld(cmd, payload, timeoutMs = 14000) {
  return new Promise((resolve) => {
    const reqId = ++rpcCounter;
    const timer = setTimeout(() => {
      if (pendingRpcMap.has(reqId)) {
        pendingRpcMap.delete(reqId);
        resolve({ ok: false, status: 408, data: null });
      }
    }, timeoutMs);

    pendingRpcMap.set(reqId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    window.postMessage({ source: "INSTASWIFT_CONTENT", cmd, reqId, payload }, "*");
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "INSTASWIFT_MAIN") return;
  const { type } = event.data;

  if (type === "CMD_RESPONSE") {
    const cb = pendingRpcMap.get(event.data.reqId);
    if (cb) {
      pendingRpcMap.delete(event.data.reqId);
      cb(event.data.result);
    }
  } else if (type === "META_UPDATE") {
    if (event.data.meta) latestSessionMeta = { ...latestSessionMeta, ...event.data.meta };
  } else if (type === "INTERCEPTED_JSON") {
    if (event.data.meta) latestSessionMeta = { ...latestSessionMeta, ...event.data.meta };
    const payload = event.data.payload;
    if (!payload) return;
    rawInterceptBuffer.push({
      url: event.data.url || "",
      payload
    });
    if (rawInterceptBuffer.length > 500) rawInterceptBuffer.shift();
    indexPassiveMediaAndStories(payload);

    safeSendMessage({
      action: "PASSIVE_JSON_CHUNK",
      url: event.data.url || "",
      payload,
      meta: latestSessionMeta
    });
  }
});

function runUiInjectors() {
  injectProfileButton();
  injectGridPostDownloadButtons();
  injectModalPostDownloadButton();
  injectManualStoryButtons();
}

runUiInjectors();
setInterval(runUiInjectors, 1200);
const observer = new MutationObserver(() => runUiInjectors());
if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}

function getUsernameFromUrl() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length >= 1 && !RESERVED_PATHS.has(parts[0].toLowerCase())) {
    return parts[0];
  }
  return null;
}

function getCurrentProfileSubTab() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const sub = parts[1].toLowerCase();
    if (sub === "reels") return "reels";
    if (sub === "tagged") return "tagged";
  }
  return "posts";
}

function parseExpectedPostsFromHeaderDOM() {
  try {
    const header = document.querySelector("header");
    if (!header) return 0;
    const text = header.innerText || "";
    const m = text.match(/([\d,]+)\s+posts?\b/i);
    if (m && m[1]) {
      const num = parseInt(m[1].replace(/,/g, ""), 10);
      if (!isNaN(num) && num > 0) return num;
    }
  } catch (_) {}
  return 0;
}

function findTargetUserIdInDOM(usernameLower) {
  const html = document.documentElement.innerHTML;
  const escaped = usernameLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes = [
    new RegExp(`"id":"(\\d+)"[^}]{0,220}"username":"${escaped}"`, "i"),
    new RegExp(`"username":"${escaped}"[^}]{0,220}"id":"(\\d+)"`, "i"),
    new RegExp(`"pk":"(\\d+)"[^}]{0,220}"username":"${escaped}"`, "i"),
    new RegExp(`"username":"${escaped}"[^}]{0,220}"pk":"(\\d+)"`, "i"),
    /"profilePage_(\d+)"/,
    /"target_id":"(\d+)"/
  ];
  for (const rx of regexes) {
    const m = html.match(rx);
    if (m && m[1]) return m[1];
  }
  return "";
}

function collectEmbeddedPageJsonPayloads(usernameLower) {
  const list = [];
  const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
  for (const s of scripts) {
    const txt = (s.textContent || "").trim();
    if (
      txt.startsWith("{") &&
      (txt.toLowerCase().includes(usernameLower) ||
        txt.includes("xdt_api__v1__") ||
        txt.includes("reels_media") ||
        txt.includes("edge_owner_to_timeline_media") ||
        txt.includes("video_versions") ||
        txt.includes("image_versions2"))
    ) {
      try {
        const parsed = JSON.parse(txt);
        indexPassiveMediaAndStories(parsed);
        list.push({
          url: window.location.pathname,
          payload: parsed
        });
      } catch (_) {}
    }
  }
  return list;
}

function scrapeVisibleDomShortcodes() {
  const codes = [];
  const anchors = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
  for (const a of anchors) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (m) {
      codes.push({ shortcode: m[2], isReel: m[1] === "reel" });
    }
  }
  return codes;
}

function injectProfileButton() {
  const username = getUsernameFromUrl();
  if (!username) return;

  const header = document.querySelector("header");
  if (!header || document.getElementById("instaswift-download-btn")) return;

  const actionSection = header.querySelector("section") || header;
  const wrap = document.createElement("div");
  wrap.className = "instaswift-profile-bar";

  const btn = document.createElement("button");
  btn.id = "instaswift-download-btn";
  btn.className = "instaswift-btn";
  btn.innerHTML = "⚡ Download All (Works Minimized / Background)";
  btn.addEventListener("click", () => {
    activateTabWakeLock();
    const currentUsername = getUsernameFromUrl();
    if (currentUsername) triggerBackgroundAutonomousJob(currentUsername);
  });

  const fmtSelect = document.createElement("select");
  fmtSelect.id = "instaswift-fmt-select";
  fmtSelect.className = "instaswift-fmt-select";
  fmtSelect.innerHTML = `
    <option value="auto">Photo: Auto (Original)</option>
    <option value="png">Photo: Force .PNG</option>
    <option value="jpg">Photo: Force .JPG</option>
  `;
  fmtSelect.value = preferredImageFormat;
  fmtSelect.addEventListener("change", () => {
    preferredImageFormat = fmtSelect.value;
    chrome.storage.local.set({ instaswift_img_format: preferredImageFormat });
    safeSendMessage({ action: "SET_IMAGE_FORMAT", format: preferredImageFormat });
  });

  wrap.appendChild(btn);
  wrap.appendChild(fmtSelect);
  actionSection.appendChild(wrap);
}

async function triggerBackgroundAutonomousJob(username) {
  activateTabWakeLock();

  if (
    document.body.innerText.includes("This account is private") ||
    document.body.innerText.includes("This Account is Private")
  ) {
    createOrShowHUD(username);
    updateHUDStatus("🔒 Private profile.");
    return;
  }

  const userLower = username.toLowerCase();
  const currentSubTab = getCurrentProfileSubTab();

  createOrShowHUD(username);

  if (currentSubTab !== "posts") {
    updateHUDStatus(`🔄 Switching from /${currentSubTab}/ to Main Grid & starting full scan...`);
    const mainGridTabLink = document.querySelector(`a[href="/${username}/"], a[href="/${userLower}/"]`);
    if (mainGridTabLink) {
      mainGridTabLink.click();
      await new Promise((r) => setTimeout(r, 900));
    }
  } else {
    updateHUDStatus("🚀 InstaSwift Active! Scanning all Grid Posts & Reels in Background...");
  }

  const metaRes = await callMainWorld("GET_SESSION_META", {}, 3000);
  if (metaRes?.ok && metaRes.meta) {
    latestSessionMeta = { ...latestSessionMeta, ...metaRes.meta };
  }

  const userId = findTargetUserIdInDOM(userLower);
  const expectedPosts = parseExpectedPostsFromHeaderDOM();
  const embeddedPayloads = collectEmbeddedPageJsonPayloads(userLower);

  await safeSendMessage({
    action: "START_AUTONOMOUS_PROFILE_JOB",
    username: userLower,
    userId,
    expectedPosts,
    format: preferredImageFormat,
    meta: latestSessionMeta,
    initialPayloads: [...embeddedPayloads, ...rawInterceptBuffer],
    domShortcodes: scrapeVisibleDomShortcodes()
  });
}

function injectGridPostDownloadButtons() {
  const anchors = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
  for (const a of anchors) {
    if (a.dataset.instaswiftBound === "1") continue;
    const match = (a.getAttribute("href") || "").match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (!match) continue;
    if (!a.querySelector("img, video")) continue;

    a.dataset.instaswiftBound = "1";
    const type = match[1];
    const shortcode = match[2];

    if (window.getComputedStyle(a).position === "static") {
      a.style.position = "relative";
    }

    const postBtn = document.createElement("button");
    postBtn.className = "is-grid-post-btn";
    postBtn.title = "Download all photos/videos in this post";
    postBtn.innerHTML = "⬇ All";
    postBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await downloadSinglePostComplete(shortcode, type === "reel", postBtn);
    });

    a.appendChild(postBtn);
  }
}

function injectModalPostDownloadButton() {
  const m = window.location.pathname.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
  if (!m) return;
  const isReel = m[1] === "reel";
  const shortcode = m[2];

  const articles = document.querySelectorAll('article, div[role="dialog"]');
  for (const container of articles) {
    if (container.querySelector(".is-modal-dl-btn")) continue;
    const bookmarkSvg = container.querySelector('svg[aria-label="Save"], svg[aria-label="Remove"]');
    const targetBar = bookmarkSvg ? bookmarkSvg.closest("section") || bookmarkSvg.parentElement?.parentElement : null;
    if (!targetBar) continue;

    const btn = document.createElement("button");
    btn.className = "is-modal-dl-btn";
    btn.innerHTML = "⬇ Download All Slides";
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await downloadSinglePostComplete(shortcode, isReel, btn);
    });

    targetBar.appendChild(btn);
  }
}

async function downloadSinglePostComplete(shortcode, isReel, btnEl) {
  const origText = btnEl ? btnEl.innerHTML : "";
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = "⏳...";
  }

  try {
    const ownerFallback = (getUsernameFromUrl() || "instagram_post").toLowerCase();
    createOrShowHUD(ownerFallback);
    updateHUDStatus(`Fetching all slides for post ${shortcode}...`);

    const res = await callMainWorld("FETCH_FULL_POST_BY_SHORTCODE", { shortcode, isReel }, 10000);
    if (res && res.ok && res.data) {
      await safeSendMessage({
        action: "DOWNLOAD_SINGLE_POST_PAYLOAD",
        username: ownerFallback,
        shortcode,
        payload: res.data
      });
      if (btnEl) btnEl.innerHTML = "✓ Queued";
    } else {
      updateHUDStatus(`⚠️ Could not fetch post ${shortcode}.`);
    }
  } catch (err) {
    updateHUDStatus(`Error: ${err.message}`);
  } finally {
    setTimeout(() => {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = origText;
      }
    }, 2000);
  }
}

function injectManualStoryButtons() {
  if (!window.location.pathname.startsWith("/stories/")) {
    const existingBar = document.getElementById("instaswift-story-bar");
    if (existingBar) existingBar.remove();
    return;
  }

  if (document.getElementById("instaswift-story-bar")) return;

  const bar = document.createElement("div");
  bar.id = "instaswift-story-bar";
  bar.innerHTML = `
    <button id="is-dl-curr-story" class="is-story-btn">⬇ Download This Story</button>
    <button id="is-dl-all-stories" class="is-story-btn is-story-btn-all">⬇ All Stories in Tray</button>
  `;
  document.body.appendChild(bar);

  document.getElementById("is-dl-curr-story").addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await downloadManualStories(false);
  });

  document.getElementById("is-dl-all-stories").addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await downloadManualStories(true);
  });
}

async function downloadManualStories(downloadAllInReel = false) {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const isHighlight = pathParts[1] === "highlights";
  const targetSlug = (pathParts[1] || "stories").toLowerCase();
  const urlStoryOrHighlightId = cleanPk(pathParts[2] || "");

  createOrShowHUD(targetSlug);
  updateHUDStatus("Resolving HD Story media (Video/Photo)...");

  collectEmbeddedPageJsonPayloads(targetSlug);

  if (!downloadAllInReel && !isHighlight && urlStoryOrHighlightId && /^\d+$/.test(urlStoryOrHighlightId)) {
    if (!storyItemsByPk.has(urlStoryOrHighlightId)) {
      const mediaRes = await callMainWorld("FETCH_MEDIA_INFO", { mediaPk: urlStoryOrHighlightId }, 8000);
      if (mediaRes?.ok && mediaRes.data) {
        indexPassiveMediaAndStories(mediaRes.data, targetSlug);
      }
    }
  }

  if (isHighlight && urlStoryOrHighlightId) {
    const res = await callMainWorld("FETCH_STORIES_REEL", { reelId: `highlight:${urlStoryOrHighlightId}` }, 8500);
    if (res?.ok && res.data) indexPassiveMediaAndStories(res.data, targetSlug);
  } else if (!isHighlight && targetSlug) {
    let uid = findTargetUserIdInDOM(targetSlug);
    if (!uid) {
      const profRes = await callMainWorld("FETCH_WEB_PROFILE_INFO", { username: targetSlug }, 7000);
      const u = profRes?.data?.data?.user || profRes?.data?.graphql?.user || profRes?.data?.user;
      if (u) uid = cleanPk(u.id || u.pk);
    }
    if (uid) {
      const sRes = await callMainWorld("FETCH_STORIES_REEL", { reelId: uid }, 8500);
      if (sRes?.ok && sRes.data) indexPassiveMediaAndStories(sRes.data, targetSlug);
    }
  }

  const batch = [];

  if (!downloadAllInReel) {
    if (!isHighlight && urlStoryOrHighlightId && storyItemsByPk.has(urlStoryOrHighlightId)) {
      batch.push(storyItemsByPk.get(urlStoryOrHighlightId));
    } else {
      const matchedItem = findCurrentlyPlayingStoryItem(targetSlug, isHighlight);
      if (matchedItem) batch.push(matchedItem);
    }
  } else {
    const userTray = storyTraysByUser.get(targetSlug);
    if (userTray && userTray.size > 0) {
      for (const item of userTray.values()) {
        batch.push(item);
      }
    } else {
      for (const item of storyItemsByPk.values()) {
        if (!isHighlight && item.username && item.username !== targetSlug) continue;
        batch.push(item);
      }
    }
  }

  if (batch.length === 0) {
    const domItem = extractValidStoryCanvasMediaFromDOM(targetSlug, urlStoryOrHighlightId);
    if (domItem) {
      batch.push(domItem);
    } else {
      updateHUDStatus("⚠️ Story is a streaming video whose ID wasn't in URL. Wait 1s or click 'All Stories in Tray'.");
      return;
    }
  }

  await safeSendMessage({
    action: "QUEUE_STORY_ITEMS",
    items: batch
  });
  updateHUDStatus(`✅ Downloading ${batch.length} HD Story file(s) (${batch.map((b) => b.extHint.toUpperCase()).join(", ")})!`);
}

function findCurrentlyPlayingStoryItem(targetSlug, isHighlight) {
  const userTray = storyTraysByUser.get(targetSlug);
  const candidates = userTray
    ? Array.from(userTray.values())
    : Array.from(storyItemsByPk.values()).filter((i) => isHighlight || i.username === targetSlug);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const allVideos = Array.from(document.querySelectorAll("video"));
  const isPlayingVideo = allVideos.some((v) => v.clientHeight > 250);

  const videoCandidates = candidates.filter((c) => c.extHint === "mp4");
  if (isPlayingVideo && videoCandidates.length === 1) {
    return videoCandidates[0];
  }

  return candidates[candidates.length - 1];
}

function extractValidStoryCanvasMediaFromDOM(targetSlug, fallbackId) {
  const storyId = fallbackId || `story_${Date.now()}`;

  const videos = Array.from(document.querySelectorAll("video"));
  for (const v of videos) {
    if (v.clientHeight < 200) continue;
    const src = v.currentSrc || v.src || "";
    if (src && src.startsWith("http") && !src.startsWith("blob:")) {
      return {
        username: targetSlug,
        uid: `story_${storyId}`,
        section: "stories",
        url: src,
        baseFilename: `story_${storyId}`,
        extHint: "mp4",
        filename: `story_${storyId}.mp4`
      };
    }
  }

  const hasLargeBlobVideo = videos.some((v) => v.clientHeight >= 250);
  if (hasLargeBlobVideo) {
    return null;
  }

  const imgs = Array.from(document.querySelectorAll("img"));
  let bestImg = null;
  let maxArea = 0;

  for (const img of imgs) {
    const alt = (img.getAttribute("alt") || "").toLowerCase();
    if (alt.includes("profile picture") || alt.includes("avatar")) continue;

    const w = Math.max(img.naturalWidth || 0, img.clientWidth || 0);
    const h = Math.max(img.naturalHeight || 0, img.clientHeight || 0);

    if (w < 250 || h < 250) continue;

    const area = w * h;
    if (area > maxArea && img.src && img.src.startsWith("http")) {
      maxArea = area;
      bestImg = img;
    }
  }

  if (bestImg) {
    return {
      username: targetSlug,
      uid: `story_${storyId}`,
      section: "stories",
      url: bestImg.src,
      baseFilename: `story_${storyId}`,
      extHint: "jpg",
      filename: `story_${storyId}.jpg`
    };
  }

  return null;
}

function indexPassiveMediaAndStories(rootObj, fallbackUsername = "") {
  const visited = new WeakSet();

  function walk(node, inheritedOwner = fallbackUsername) {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, inheritedOwner);
      return;
    }

    const currentOwner = (
      node.user?.username ||
      node.owner?.username ||
      inheritedOwner ||
      ""
    ).toLowerCase();

    if (Array.isArray(node.items) && (node.expiring_at || node.reel_type || node.seen !== undefined || node.id)) {
      for (const storyNode of node.items) {
        recordStoryNode(storyNode, currentOwner);
      }
    }

    const pk = cleanPk(node.pk || node.id);
    const hasMediaVersions = Boolean(
      (Array.isArray(node.video_versions) && node.video_versions.length > 0) ||
      node.image_versions2?.candidates?.length
    );
    const looksLikeStory = Boolean(
      node.expiring_at ||
      node.story_cta ||
      node.reel_type ||
      node.product_type === "story" ||
      node.is_reel_media ||
      window.location.pathname.startsWith("/stories/")
    );

    if (pk && hasMediaVersions && looksLikeStory) {
      recordStoryNode(node, currentOwner);
    }

    const shortcode = node.code || node.shortcode;
    if (shortcode && hasMediaVersions) {
      mediaCacheByShortcode.set(shortcode, node);
    }

    for (const k of Object.keys(node)) {
      walk(node[k], currentOwner);
    }
  }

  walk(rootObj, fallbackUsername);
}

function recordStoryNode(node, ownerUser) {
  if (!node || typeof node !== "object") return;
  const pk = cleanPk(node.pk || node.id);
  if (!pk) return;

  const isVid = Boolean(
    node.media_type === 2 ||
    node.is_video === true ||
    (Array.isArray(node.video_versions) && node.video_versions.length > 0) ||
    node.video_url
  );

  let bestUrl = null;
  let ext = isVid ? "mp4" : "jpg";

  if (isVid) {
    if (Array.isArray(node.video_versions) && node.video_versions.length > 0) {
      const sorted = [...node.video_versions].sort(
        (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
      );
      bestUrl = sorted[0]?.url;
    } else if (node.video_url) {
      bestUrl = node.video_url;
    }
  } else {
    const candidates = node.image_versions2?.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const sorted = [...candidates].sort(
        (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
      );
      bestUrl = sorted[0]?.url;
    } else if (node.display_url) {
      bestUrl = node.display_url;
    }
  }

  if (!bestUrl) return;

  const sUser = (node.user?.username || node.owner?.username || ownerUser || "stories").toLowerCase();
  const storyItem = {
    username: sUser,
    uid: `story_${pk}`,
    storyPk: pk,
    section: "stories",
    url: bestUrl,
    baseFilename: `story_${pk}`,
    extHint: ext,
    filename: `story_${pk}.${ext}`
  };

  storyItemsByPk.set(pk, storyItem);
  if (!storyTraysByUser.has(sUser)) {
    storyTraysByUser.set(sUser, new Map());
  }
  storyTraysByUser.get(sUser).set(pk, storyItem);
}

function createOrShowHUD(username) {
  let hud = document.getElementById("instaswift-hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "instaswift-hud";
    hud.innerHTML = `
      <div class="is-hud-header">
        <span class="is-hud-title">⚡ InstaSwift — <strong id="is-hud-user">@${username}</strong></span>
        <button id="is-hud-close" title="Close">✕</button>
      </div>
      <div class="is-hud-status" id="is-hud-status">Ready</div>
      <div class="is-hud-grid-2">
        <div class="is-stat-box">
          <span class="is-stat-val" id="is-stat-posts">0</span>
          <span class="is-stat-lbl">1. Grid Posts Section</span>
        </div>
        <div class="is-stat-box">
          <span class="is-stat-val" id="is-stat-reels">0</span>
          <span class="is-stat-lbl">2. Reels Section (Unique)</span>
        </div>
      </div>
      <div class="is-hud-sub" id="is-hud-sub">PC Disk Saved: 0 / 0 files</div>
      <div class="is-hud-actions">
        <button id="is-hud-stop" class="is-stop-btn">Stop</button>
      </div>
    `;
    document.body.appendChild(hud);

    document.getElementById("is-hud-close").addEventListener("click", () => {
      hud.style.display = "none";
    });

    document.getElementById("is-hud-stop").addEventListener("click", async () => {
      await safeSendMessage({ action: "STOP_ALL" });
      updateHUDStatus("Stopped.");
    });
  } else {
    hud.style.display = "block";
    document.getElementById("is-hud-user").textContent = `@${username}`;
  }
}

function updateHUDStatus(text) {
  const el = document.getElementById("is-hud-status");
  if (el) el.textContent = text;
}

function renderStatsToHUD(stats) {
  if (!stats) return;
  const st = document.getElementById("is-hud-status");
  const pEl = document.getElementById("is-stat-posts");
  const rEl = document.getElementById("is-stat-reels");
  const sub = document.getElementById("is-hud-sub");
  const btn = document.getElementById("instaswift-download-btn");

  if (st) st.textContent = stats.status || "Idle";
  if (pEl) {
    pEl.textContent =
      stats.expectedPosts > 0
        ? `${stats.gridPostsMatched || 0} / ${stats.expectedPosts}`
        : `${stats.gridPostsMatched || 0}`;
  }
  if (rEl) {
    rEl.textContent = `${stats.uniqueReelsMatched || 0}`;
  }
  if (sub) {
    const remaining = Math.max(0, (stats.totalQueued || 0) - (stats.savedToDisk || 0) - (stats.failedDownloads || 0));
    sub.textContent = `PC Disk Saved: ${stats.savedToDisk || 0} / ${stats.totalQueued || 0} unique files (${remaining} in queue | ${stats.duplicatesSkipped || 0} dups skipped)`;
  }
  if (btn) {
    if (stats.isRunning) {
      btn.disabled = true;
      btn.textContent = "⚡ Running in Background...";
    } else {
      btn.disabled = false;
      btn.textContent = "⚡ Download All (Works Minimized / Background)";
    }
  }
}

try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "STATS_UPDATE" && msg.stats) {
      renderStatsToHUD(msg.stats);
      sendResponse({ ok: true });
      return false;
    }
    else if (msg.action === "TRIGGER_FROM_POPUP") {
      activateTabWakeLock();
      if (msg.format) {
        preferredImageFormat = msg.format;
        const sel = document.getElementById("instaswift-fmt-select");
        if (sel) sel.value = preferredImageFormat;
      }
      const username = getUsernameFromUrl();
      if (username) triggerBackgroundAutonomousJob(username);
      sendResponse({ ok: true });
      return false;
    }
    else if (msg.action === "EXEC_MAIN_WORLD_FETCH") {
      activateTabWakeLock();
      callMainWorld("MAIN_WORLD_FETCH", { url: msg.url, options: msg.options || {} }, msg.timeoutMs || 15000)
        .then((res) => {
          if (res?.meta) latestSessionMeta = { ...latestSessionMeta, ...res.meta };
          sendResponse(res);
        })
        .catch(() => sendResponse({ ok: false, status: 0, data: null }));
      return true;
    }
    else if (msg.action === "EXEC_SWITCH_TAB_AND_SCROLL") {
      activateTabWakeLock();
      (async () => {
        try {
          const targetTab = msg.tabType || "posts";
          const user = (msg.username || getUsernameFromUrl() || "").toLowerCase();

          const allTabLinks = Array.from(document.querySelectorAll('a[role="tab"], header ~ div a, main a'));
          if (targetTab === "posts" && window.location.pathname.includes("/reels")) {
            const postTab = allTabLinks.find((a) => {
              const h = (a.getAttribute("href") || "").toLowerCase();
              return h === `/${user}/` || h === `/${user}`;
            });
            if (postTab) postTab.click();
          } else if (targetTab === "reels" && !window.location.pathname.includes("/reels")) {
            const reelTab = allTabLinks.find((a) => {
              const h = (a.getAttribute("href") || "").toLowerCase();
              return h.includes(`/${user}/reels`);
            });
            if (reelTab) reelTab.click();
          }

          const gridLinks = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
          if (gridLinks.length > 0) {
            const lastEl = gridLinks[gridLinks.length - 1];
            lastEl.scrollIntoView({ behavior: "instant", block: "end" });
          }
          window.scrollBy(0, 2400);
          window.dispatchEvent(new Event("scroll", { bubbles: true }));

          await new Promise((r) => setTimeout(r, 450));
          const mRes = await callMainWorld("GET_SESSION_META", {}, 2000);
          if (mRes?.ok && mRes.meta) {
            latestSessionMeta = { ...latestSessionMeta, ...mRes.meta };
          }
          sendResponse({
            ok: true,
            meta: latestSessionMeta,
            domShortcodes: scrapeVisibleDomShortcodes(),
            scrollHeight: document.body.scrollHeight
          });
        } catch (_) {
          sendResponse({ ok: false });
        }
      })();
      return true;
    }
  });
} catch (_) {}