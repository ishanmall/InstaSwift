let isScanning = false;
let stopRequested = false;
let activeTargetUsername = "";
let activeTargetUserId = "";
let currentScanPhase = "posts"; // "posts" | "reels"

// =========================================================
// THE 3-SECTION STAGING ROOM ARCHITECTURE
// Sec 1: Grid Vault (Set G)
// Sec 2: Unique Reels Vault (Set R \ G)
// Sec 3: Duplicate Quarantine Vault (Set G \cap R)
// =========================================================
const stagingRoom = {
  gridVault: new Map(),
  reelsVault: new Map(),
  duplicateVault: new Map(),

  gridFingerprints: new Set(),
  gridShortcodes: new Set(),
  gridMediaPks: new Set(),
  gridBaseUrls: new Set(),

  reelsFingerprints: new Set(),

  reset() {
    this.gridVault.clear();
    this.reelsVault.clear();
    this.duplicateVault.clear();
    this.gridFingerprints.clear();
    this.gridShortcodes.clear();
    this.gridMediaPks.clear();
    this.gridBaseUrls.clear();
    this.reelsFingerprints.clear();
  }
};

// Passive Caches for HD Story Downloader & Single-Post Download Buttons
const storyItemsByPk = new Map();
const storyTraysByUser = new Map();
const mediaCacheByShortcode = new Map();

function fnv1a64Hash(str) {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const pendingDeepResolvePks = new Map();
const resolvedDeepPks = new Set();

const scopedInterceptBuffer = [];
let lastBufferUsername = "";

const pendingRpcMap = new Map();
let rpcCounter = 0;

const IG_APP_ID = "936619743392459";
const RESERVED_PATHS = new Set([
  "explore", "reels", "direct", "accounts", "p", "reel", "stories", "tv", "challenge"
]);

let tabAudioCtx = null;
function engageTabBackgroundLock() {
  try {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request("instaswift_tab_scan_lock", () => new Promise(() => {}));
    }
    if (!tabAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        tabAudioCtx = new Ctx();
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

function safeSendMessage(payload) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.id) {
        updateHUDStatus("⚠️ Extension updated! Press F5 to refresh this page.");
        resolve(null);
        return;
      }
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const localTimer = setTimeout(done, ms + 120);
    try {
      if (chrome?.runtime?.id) {
        chrome.runtime.sendMessage({ action: "BG_UNTHROTTLED_SLEEP", ms }, () => {
          clearTimeout(localTimer);
          done();
        });
      }
    } catch (_) {}
  });
}

function getCsrfToken() {
  const m = document.cookie.match(/csrftoken=([^;]+)/);
  return m ? m[1] : "";
}

async function directContentJsonFetch(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "x-ig-app-id": IG_APP_ID,
        "x-csrftoken": getCsrfToken(),
        "x-requested-with": "XMLHttpRequest",
        "accept": "*/*",
        ...(options.headers || {})
      },
      credentials: "include"
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    const txt = (await res.text()).trim();
    if (!txt.startsWith("{") && !txt.startsWith("[")) {
      return { ok: false, status: 200, data: null };
    }
    return { ok: true, status: 200, data: JSON.parse(txt) };
  } catch (_) {
    return { ok: false, status: 0, data: null };
  }
}

function callMainWorld(cmd, payload, timeoutMs = 5500) {
  return new Promise((resolve) => {
    const reqId = ++rpcCounter;
    let handled = false;

    const finish = (val) => {
      if (handled) return;
      handled = true;
      pendingRpcMap.delete(reqId);
      resolve(val);
    };

    sleep(timeoutMs).then(async () => {
      if (!handled && pendingRpcMap.has(reqId)) {
        const fallback = await runDirectFallback(cmd, payload);
        finish(fallback);
      }
    });

    pendingRpcMap.set(reqId, (result) => {
      finish(result);
    });

    window.postMessage({ source: "INSTASWIFT_CONTENT", cmd, reqId, payload }, "*");
  });
}

async function runDirectFallback(cmd, payload) {
  if (cmd === "FETCH_POSTS_PAGE") {
    const { username, userId, maxId } = payload;
    const baseUrl = (userId && maxId)
      ? `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/`
      : `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/`;
    const url = new URL(baseUrl);
    url.searchParams.set("count", "33");
    if (maxId) url.searchParams.set("max_id", maxId);
    return await directContentJsonFetch(url.toString());
  }
  if (cmd === "FETCH_REELS_PAGE") {
    const { userId, maxId } = payload;
    const body = new URLSearchParams({
      target_user_id: String(userId),
      page_size: "24",
      include_feed_video: "true"
    });
    if (maxId) body.set("max_id", maxId);
    return await directContentJsonFetch("https://www.instagram.com/api/v1/clips/user/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
  }
  if (cmd === "FETCH_MEDIA_INFO") {
    return await directContentJsonFetch(`https://www.instagram.com/api/v1/media/${encodeURIComponent(payload.mediaPk)}/info/`);
  }
  return { ok: false, status: 408, data: null };
}

function getUsernameFromPath(pathname) {
  const cleanPath = String(pathname || "").split("?")[0];
  const parts = cleanPath.split("/").filter(Boolean);
  if (parts.length >= 1 && !RESERVED_PATHS.has(parts[0].toLowerCase())) {
    return parts[0].toLowerCase();
  }
  return null;
}

function getUsernameFromUrl() {
  const cleanPath = window.location.pathname.split("?")[0];
  const parts = cleanPath.split("/").filter(Boolean);
  if (parts.length >= 1 && !RESERVED_PATHS.has(parts[0].toLowerCase())) {
    return parts[0];
  }
  return null;
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "INSTASWIFT_MAIN") return;
  const { type } = event.data;

  if (type === "CMD_RESPONSE") {
    const cb = pendingRpcMap.get(event.data.reqId);
    if (cb) cb(event.data.result);
  } else if (type === "INTERCEPTED_JSON") {
    const payload = event.data.payload;
    if (!payload) return;

    // Always index Stories & Media passively so Story Downloader has instant access to HD URLs
    indexPassiveMediaAndStories(payload);

    const pathUser = getUsernameFromPath(event.data.pagePath || window.location.pathname);
    if (pathUser) {
      if (pathUser !== lastBufferUsername) {
        scopedInterceptBuffer.length = 0;
        lastBufferUsername = pathUser;
      }
      scopedInterceptBuffer.push({
        url: event.data.url || "",
        pagePath: event.data.pagePath || "",
        payload
      });
      if (scopedInterceptBuffer.length > 160) scopedInterceptBuffer.shift();
    }

    if (isScanning && activeTargetUsername && (!pathUser || pathUser === activeTargetUsername)) {
      const isClips =
        (event.data.url || "").includes("clips") ||
        (event.data.pagePath || "").includes("/reels") ||
        Boolean(payload?.data?.xdt_api__v1__clips__user__connection_v2);
      routePayloadIntoStagingRoom(payload, activeTargetUsername, isClips ? "reels" : currentScanPhase);
    }
  }
});

// =========================================================
// UI INJECTORS: 1) Profile "Download All"  2) Story Bar  3) Per-Post "⬇ All"
// =========================================================
function runAllUiInjectors() {
  injectProfileButton();
  injectManualStoryButtons();
  injectGridPostDownloadButtons();
}

runAllUiInjectors();
setInterval(runAllUiInjectors, 1000);
const observer = new MutationObserver(() => runAllUiInjectors());
if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}

function injectProfileButton() {
  const username = getUsernameFromUrl();
  if (!username) return;

  const existingBtn = document.getElementById("instaswift-download-btn");
  if (existingBtn) return;

  const header = document.querySelector("header");
  if (!header) return;

  const actionSection = header.querySelector("section") || header;
  const btn = document.createElement("button");
  btn.id = "instaswift-download-btn";
  btn.className = "instaswift-btn";
  btn.innerHTML = isScanning ? "⏳ Scanning..." : "⚡ Download All";
  btn.disabled = isScanning;
  btn.addEventListener("click", () => {
    engageTabBackgroundLock();
    const currentUsername = getUsernameFromUrl();
    if (currentUsername) startProfileDownload(currentUsername);
  });

  actionSection.appendChild(btn);
}

// =========================================================
// RESTORED HD STORY & HIGHLIGHTS DOWNLOADER (NEVER DOWNLOADS PROFILE AVATAR!)
// =========================================================
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
  // /stories/<username>/<storyPk>/ or /stories/highlights/<highlightId>/
  const isHighlight = pathParts[1] === "highlights";
  const targetSlug = (pathParts[1] || "stories").toLowerCase();
  const urlStoryOrHighlightId = cleanPk(pathParts[2] || "");

  createOrShowHUD(targetSlug);
  updateHUDStatus("Resolving HD Story Video/Photo...");

  // 1. Scan embedded JSON scripts on the Story page
  const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
  for (const s of scripts) {
    const txt = (s.textContent || "").trim();
    if (txt.startsWith("{") && (txt.includes("video_versions") || txt.includes("image_versions2") || txt.includes("reels_media"))) {
      try {
        indexPassiveMediaAndStories(JSON.parse(txt), targetSlug);
      } catch (_) {}
    }
  }

  // 2. If user clicked "Download This Story" and URL has a numeric storyPk, fetch `/api/v1/media/{storyPk}/info/` directly!
  if (!downloadAllInReel && !isHighlight && urlStoryOrHighlightId && /^\d+$/.test(urlStoryOrHighlightId)) {
    if (!storyItemsByPk.has(urlStoryOrHighlightId)) {
      const mediaRes = await callMainWorld("FETCH_MEDIA_INFO", { mediaPk: urlStoryOrHighlightId }, 6500);
      if (mediaRes?.ok && mediaRes.data) {
        indexPassiveMediaAndStories(mediaRes.data, targetSlug);
      }
    }
  }

  // 3. Fetch full Story Reel Tray via `/api/v1/feed/reels_media/`
  if (isHighlight && urlStoryOrHighlightId) {
    const res = await callMainWorld("FETCH_STORIES_REEL", { reelId: `highlight:${urlStoryOrHighlightId}` }, 7000);
    if (res?.ok && res.data) indexPassiveMediaAndStories(res.data, targetSlug);
  } else if (!isHighlight && targetSlug) {
    let uid = findUserIdInDOM(targetSlug);
    if (!uid) {
      const profRes = await callMainWorld("FETCH_WEB_PROFILE_INFO", { username: targetSlug }, 6000);
      const u = profRes?.data?.data?.user || profRes?.data?.graphql?.user || profRes?.data?.user;
      if (u) uid = cleanPk(u.id || u.pk);
    }
    if (uid) {
      const sRes = await callMainWorld("FETCH_STORIES_REEL", { reelId: uid }, 7000);
      if (sRes?.ok && sRes.data) indexPassiveMediaAndStories(sRes.data, targetSlug);
    }
  }

  const batch = [];

  if (!downloadAllInReel) {
    if (!isHighlight && urlStoryOrHighlightId && storyItemsByPk.has(urlStoryOrHighlightId)) {
      batch.push(storyItemsByPk.get(urlStoryOrHighlightId));
    } else {
      const matched = findCurrentlyPlayingStoryItem(targetSlug, isHighlight);
      if (matched) batch.push(matched);
    }
  } else {
    const userTray = storyTraysByUser.get(targetSlug);
    if (userTray && userTray.size > 0) {
      for (const item of userTray.values()) batch.push(item);
    } else {
      for (const item of storyItemsByPk.values()) {
        if (!isHighlight && item.username && item.username !== targetSlug) continue;
        batch.push(item);
      }
    }
  }

  // 4. Safe DOM Fallback (Strictly blocks profile avatars: alt*="profile picture" or width < 250px)
  if (batch.length === 0) {
    const domItem = extractValidStoryCanvasMediaFromDOM(targetSlug, urlStoryOrHighlightId);
    if (domItem) {
      batch.push(domItem);
    } else {
      updateHUDStatus("⚠️ Story stream still loading. Wait 1s or click '⬇ All Stories in Tray'.");
      return;
    }
  }

  await safeSendMessage({
    action: "QUEUE_MEDIA",
    items: batch
  });
  await safeSendMessage({ action: "SCAN_FINISHED" });
  updateHUDStatus(`✅ Downloading ${batch.length} HD Story file(s) to Instagram/${targetSlug}/!`);
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
  const videoCandidates = candidates.filter((c) => c.filename.endsWith(".mp4"));
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
        shortcode: `story_${storyId}`,
        url: src,
        filename: `story_${storyId}.mp4`
      };
    }
  }

  // If a large MSE blob video is playing, never fall back to <img> (prevents grabbing the profile avatar!)
  if (videos.some((v) => v.clientHeight >= 250)) {
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
      shortcode: `story_${storyId}`,
      url: bestImg.src,
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

  const extracted = extractStrictMediaUrl(node, isVid);
  if (!extracted) return;

  const sUser = (node.user?.username || node.owner?.username || ownerUser || "stories").toLowerCase();
  const storyItem = {
    username: sUser,
    shortcode: `story_${pk}`,
    url: extracted.url,
    filename: `story_${pk}.${extracted.ext}`
  };

  storyItemsByPk.set(pk, storyItem);
  if (!storyTraysByUser.has(sUser)) {
    storyTraysByUser.set(sUser, new Map());
  }
  storyTraysByUser.get(sUser).set(pk, storyItem);
}

// =========================================================
// PER-POST "⬇ All" BUTTON ON GRID THUMBNAILS
// =========================================================
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
    postBtn.title = "Download all slides in this post";
    postBtn.innerHTML = "⬇ All";
    postBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      postBtn.disabled = true;
      postBtn.innerHTML = "⏳";
      const ownerFallback = (getUsernameFromUrl() || "instagram_saved").toLowerCase();
      createOrShowHUD(ownerFallback);
      const res = await callMainWorld("FETCH_FULL_POST_BY_SHORTCODE", { shortcode, isReel: type === "reel" }, 7000);
      if (res?.ok && res.data) {
        const singleItems = [];
        extractSinglePostSlides(res.data, ownerFallback, singleItems);
        if (singleItems.length > 0) {
          await safeSendMessage({ action: "QUEUE_MEDIA", items: singleItems });
          await safeSendMessage({ action: "SCAN_FINISHED" });
          updateHUDStatus(`✅ Downloading ${singleItems.length} file(s) from post ${shortcode}!`);
        }
      }
      postBtn.disabled = false;
      postBtn.innerHTML = "⬇ All";
    });

    a.appendChild(postBtn);
  }
}

function extractSinglePostSlides(rootObj, fallbackUser, outList) {
  const visited = new WeakSet();
  function walk(node) {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const shortcode = node.code || node.shortcode;
    if (shortcode && (node.image_versions2 || node.video_versions || node.carousel_media || node.edge_sidecar_to_children || node.display_url)) {
      const author = (node.user?.username || node.owner?.username || fallbackUser).toLowerCase();
      const slides = node.carousel_media || (node.edge_sidecar_to_children?.edges || []).map((e) => e?.node).filter(Boolean);
      if (Array.isArray(slides) && slides.length > 0) {
        slides.forEach((sl, idx) => {
          const isVid = sl.media_type === 2 || sl.is_video === true || Boolean(sl.video_versions?.length);
          const ext = extractStrictMediaUrl(sl, isVid);
          if (ext) {
            outList.push({
              username: author,
              shortcode: `${shortcode}_${idx + 1}`,
              url: ext.url,
              filename: `${shortcode}_${idx + 1}.${ext.ext}`
            });
          }
        });
      } else {
        const isVid = node.media_type === 2 || node.is_video === true || Boolean(node.video_versions?.length);
        const ext = extractStrictMediaUrl(node, isVid);
        if (ext) {
          outList.push({
            username: author,
            shortcode,
            url: ext.url,
            filename: `${shortcode}.${ext.ext}`
          });
        }
      }
      return;
    }
    Object.keys(node).forEach((k) => walk(node[k]));
  }
  walk(rootObj);
}

// =========================================================
// THE 3-SECTION STAGING ROOM HUD
// =========================================================
function createOrShowHUD(username) {
  let hud = document.getElementById("instaswift-hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "instaswift-hud";
    hud.innerHTML = `
      <div class="is-hud-header">
        <span class="is-hud-title">⚡ InstaSwift v28 Room — <strong id="is-hud-user">@${username}</strong></span>
        <button id="is-hud-close" title="Close">✕</button>
      </div>
      <div class="is-hud-status" id="is-hud-status">Initializing 3-Section Staging Room...</div>
      <div class="is-hud-grid-3">
        <div class="is-stat-box is-room-grid">
          <span class="is-stat-val" id="is-stat-posts">0</span>
          <span class="is-stat-lbl">Sec 1: Grid Vault</span>
        </div>
        <div class="is-stat-box is-room-reels">
          <span class="is-stat-val" id="is-stat-reels">0</span>
          <span class="is-stat-lbl">Sec 2: Reels Vault</span>
        </div>
        <div class="is-stat-box is-room-dups">
          <span class="is-stat-val" id="is-stat-dups">0</span>
          <span class="is-stat-lbl">Sec 3: Duplicates</span>
        </div>
      </div>
      <div class="is-disk-line" id="is-disk-line">Staging Room: One-pass scan in progress...</div>
      <button id="is-hud-stop" class="is-stop-btn">Stop</button>
    `;
    document.body.appendChild(hud);

    document.getElementById("is-hud-close").addEventListener("click", () => {
      hud.style.display = "none";
    });

    document.getElementById("is-hud-stop").addEventListener("click", async () => {
      stopRequested = true;
      isScanning = false;
      await safeSendMessage({ action: "USER_EXPLICIT_STOP" });
      updateHUDStatus("Stopped by user.");
      resetButton();
    });
  } else {
    hud.style.display = "block";
    document.getElementById("is-hud-user").textContent = `@${username}`;
  }
  updateRoomHUDCounters();
}

function updateRoomHUDCounters() {
  const pEl = document.getElementById("is-stat-posts");
  const rEl = document.getElementById("is-stat-reels");
  const dEl = document.getElementById("is-stat-dups");

  if (pEl) pEl.textContent = stagingRoom.gridVault.size;
  if (rEl) rEl.textContent = stagingRoom.reelsVault.size;
  if (dEl) dEl.textContent = stagingRoom.duplicateVault.size;
}

function updateHUDStatus(text) {
  const el = document.getElementById("is-hud-status");
  if (el) el.textContent = text;
}

try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "STATS_UPDATE" && msg.stats) {
      const diskEl = document.getElementById("is-disk-line");
      const st = document.getElementById("is-hud-status");
      if (diskEl && msg.stats.scanned > 0) {
        const vel = msg.stats.velocityFps ? `${msg.stats.velocityFps} files/s` : "Max Speed";
        diskEl.textContent = `Saved: ${msg.stats.downloaded} / ${msg.stats.scanned} • Speed: ${vel} (${msg.stats.concurrency || 6}x streams)`;
      }
      if (st && !isScanning && msg.stats.status) {
        st.textContent = msg.stats.status;
      }
    } else if (msg.action === "TRIGGER_FROM_POPUP") {
      engageTabBackgroundLock();
      const username = getUsernameFromUrl();
      if (username) startProfileDownload(username);
    }
  });
} catch (_) {}

function cleanPk(raw) {
  if (!raw) return "";
  return String(raw).split("_")[0].trim();
}

function getBaseCdnPath(url) {
  try {
    return new URL(url).pathname;
  } catch (_) {
    return url;
  }
}

function findUserIdInDOM(usernameLower) {
  const html = document.documentElement.innerHTML;
  const escaped = usernameLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes = [
    new RegExp(`"id":"(\\d+)"[^}]{0,250}"username":"${escaped}"`, "i"),
    new RegExp(`"username":"${escaped}"[^}]{0,250}"id":"(\\d+)"`, "i"),
    new RegExp(`"pk":"(\\d+)"[^}]{0,250}"username":"${escaped}"`, "i")
  ];
  for (const rx of regexes) {
    const m = html.match(rx);
    if (m && m[1]) return m[1];
  }
  return "";
}

function scanEmbeddedPageScripts(usernameLower, phaseTag) {
  const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
  for (const s of scripts) {
    const txt = (s.textContent || "").trim();
    if (
      txt.startsWith("{") &&
      txt.toLowerCase().includes(`"${usernameLower}"`) &&
      (txt.includes("xdt_api__v1__") ||
        txt.includes("edge_owner_to_timeline_media") ||
        txt.includes("video_versions") ||
        txt.includes("image_versions2"))
    ) {
      try {
        routePayloadIntoStagingRoom(JSON.parse(txt), usernameLower, phaseTag);
      } catch (_) {}
    }
  }
}

// =========================================================
// ONE-PASS 3-ROOM WORKFLOW (NO STOP-RESCAN-STOP LOOP!)
// Pass 1: Continuous Grid Scan -> Sec 1
// Pass 2: Continuous Reels Scan -> Sec 2 & Sec 3 (Duplicates)
// Pass 3: Instant Bulk Download
// =========================================================
async function startProfileDownload(username) {
  if (isScanning) return;
  isScanning = true;
  stopRequested = false;
  activeTargetUsername = username.toLowerCase();
  engageTabBackgroundLock();

  stagingRoom.reset();
  pendingDeepResolvePks.clear();
  resolvedDeepPks.clear();

  createOrShowHUD(username);
  updateHUDStatus("Pass 1/2: Locking Profile ID & Scanning Grid Posts...");

  const diskEl = document.getElementById("is-disk-line");
  if (diskEl) {
    diskEl.textContent = "One-Pass Room Active: Collecting Grid & Reels before bulk download...";
  }

  const btn = document.getElementById("instaswift-download-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Pass 1: Grid...";
  }

  try {
    const initRes = await safeSendMessage({
      action: "INIT_SESSION",
      username: activeTargetUsername
    });
    if (!initRes) {
      updateHUDStatus("⚠️ Please press F5 to refresh this Instagram tab.");
      return;
    }

    if (
      document.body.innerText.includes("This account is private") ||
      document.body.innerText.includes("This Account is Private")
    ) {
      updateHUDStatus("🔒 Private profile: Account public hone par hi download hoga.");
      return;
    }

    activeTargetUserId = findUserIdInDOM(activeTargetUsername);

    // Fetch web_profile_info once at the start so activeTargetUserId is 100% locked before Reels Pass
    const profRes = await callMainWorld("FETCH_WEB_PROFILE_INFO", { username: activeTargetUsername }, 5000);
    if (profRes?.ok && profRes.data) {
      const u = profRes.data?.data?.user || profRes.data?.graphql?.user || profRes.data?.user;
      if (u && (u.id || u.pk)) {
        activeTargetUserId = cleanPk(u.id || u.pk);
      }
      routePayloadIntoStagingRoom(profRes.data, activeTargetUsername, "posts");
    }

    const startsOnReelsTab = window.location.pathname.toLowerCase().includes("/reels");
    currentScanPhase = startsOnReelsTab ? "reels" : "posts";

    scanEmbeddedPageScripts(activeTargetUsername, currentScanPhase);
    if (lastBufferUsername === activeTargetUsername) {
      for (const entry of scopedInterceptBuffer) {
        const isClips = (entry.url || "").includes("clips") || (entry.pagePath || "").includes("/reels");
        routePayloadIntoStagingRoom(entry.payload, activeTargetUsername, isClips ? "reels" : "posts");
      }
    }

    // ---------------------------------------------------------
    // PASS 1: CONTINUOUS SINGLE-PASS GRID SCAN (Sec 1)
    // ---------------------------------------------------------
    if (!stopRequested) {
      currentScanPhase = "posts";
      if (btn) btn.textContent = "⏳ Pass 1: Grid...";
      await scanGridSinglePass(username);
    }

    // ---------------------------------------------------------
    // PASS 2: CONTINUOUS SINGLE-PASS REELS SCAN (Sec 2 & Sec 3)
    // ---------------------------------------------------------
    if (!stopRequested) {
      currentScanPhase = "reels";
      if (btn) btn.textContent = "⏳ Pass 2: Reels...";
      await scanReelsSinglePass(username);
    }

    // Expand any truncated multi-slide carousels
    if (!stopRequested && pendingDeepResolvePks.size > 0) {
      await resolvePendingDeepMedia(activeTargetUsername);
    }

    if (stopRequested) return;

    // ---------------------------------------------------------
    // PASS 3: FLUSH STAGING ROOM -> HIGH-SPEED BULK DOWNLOAD
    // ---------------------------------------------------------
    const finalBulkItems = [
      ...Array.from(stagingRoom.gridVault.values()),
      ...Array.from(stagingRoom.reelsVault.values())
    ];

    window.scrollTo(0, 0);
    updateRoomHUDCounters();

    await safeSendMessage({
      action: "UPDATE_ROOM_COUNTS",
      gridCount: stagingRoom.gridVault.size,
      reelsCount: stagingRoom.reelsVault.size,
      dupsCount: stagingRoom.duplicateVault.size
    });

    if (finalBulkItems.length === 0) {
      await safeSendMessage({ action: "SCAN_FINISHED" });
      updateHUDStatus("⚠️ No media found to download.");
      return;
    }

    if (btn) btn.textContent = "🚀 Downloading All...";
    updateHUDStatus(
      `Room Ready! Grid: ${stagingRoom.gridVault.size} | Reels: ${stagingRoom.reelsVault.size} | Dups Blocked: ${stagingRoom.duplicateVault.size}. Downloading All...`
    );

    const PACKET_SIZE = 200;
    for (let i = 0; i < finalBulkItems.length; i += PACKET_SIZE) {
      if (stopRequested) break;
      const packet = finalBulkItems.slice(i, i + PACKET_SIZE);
      await safeSendMessage({
        action: "QUEUE_MEDIA",
        items: packet
      });
    }

    if (!stopRequested) {
      await safeSendMessage({ action: "SCAN_FINISHED" });
    }
  } catch (err) {
    console.error("[InstaSwift Error]:", err);
    updateHUDStatus(`Error: ${err.message}`);
  } finally {
    isScanning = false;
    resetButton();
  }
}

// Continuous Single-Pass Grid Scanner (No stop-rescan loops!)
async function scanGridSinglePass(username) {
  let maxId = null;
  let page = 0;
  let apiExhausted = false;
  const seenCursors = new Set();

  while (!stopRequested) {
    page++;
    updateHUDStatus(
      `Pass 1 (Grid Section): Page ${page} • Sec 1 Vault: ${stagingRoom.gridVault.size} files...`
    );

    const res = await callMainWorld("FETCH_POSTS_PAGE", {
      username,
      userId: activeTargetUserId,
      maxId
    });

    if (!res || !res.ok || !res.data) {
      break;
    }

    const data = res.data;
    if (!activeTargetUserId && data.user?.pk) {
      activeTargetUserId = cleanPk(data.user.pk);
    }
    if (!activeTargetUserId && data.items?.[0]?.user?.pk) {
      activeTargetUserId = cleanPk(data.items[0].user.pk);
    }

    routePayloadIntoStagingRoom(data, activeTargetUsername, "posts");

    const nextCursor = data.next_max_id || data.paging_info?.max_id || null;
    if (data.more_available && nextCursor && !seenCursors.has(String(nextCursor))) {
      seenCursors.add(String(nextCursor));
      maxId = String(nextCursor);
      await sleep(320);
    } else {
      apiExhausted = true;
      break;
    }
  }

  // Only scroll if REST API was blocked before finishing
  if (!stopRequested && !apiExhausted) {
    await switchProfileTab(username, "posts");
    await continuousNonStopScroll("posts");
  }
}

// Continuous Single-Pass Reels Scanner (REST Clips + GraphQL Clips — No per-item stop-rescan!)
async function scanReelsSinglePass(username) {
  if (!activeTargetUserId) {
    activeTargetUserId = findUserIdInDOM(activeTargetUsername);
  }

  let maxId = null;
  let page = 0;
  let apiExhausted = false;
  const seenCursors = new Set();

  // 1. Primary Fast REST Clips Stream (`/api/v1/clips/user/`)
  if (activeTargetUserId) {
    while (!stopRequested) {
      page++;
      updateHUDStatus(
        `Pass 2 (Reels Section): Page ${page} • Unique Reels: ${stagingRoom.reelsVault.size} | Dups: ${stagingRoom.duplicateVault.size}...`
      );

      const res = await callMainWorld("FETCH_REELS_PAGE", {
        userId: activeTargetUserId,
        maxId
      });

      if (!res || !res.ok || !res.data) {
        break;
      }

      const data = res.data;
      routePayloadIntoStagingRoom(data, activeTargetUsername, "reels");

      const paging = data.paging_info || {};
      const nextCursor = paging.max_id || data.next_max_id || null;
      if ((paging.more_available || data.more_available) && nextCursor && !seenCursors.has(String(nextCursor))) {
        seenCursors.add(String(nextCursor));
        maxId = String(nextCursor);
        await sleep(320);
      } else {
        apiExhausted = true;
        break;
      }
    }
  }

  // 2. Secondary Fast GraphQL Clips Stream if REST stopped early
  if (!stopRequested && !apiExhausted && activeTargetUserId) {
    let afterCursor = null;
    let gqlPage = 0;
    const seenGqlCursors = new Set();

    while (!stopRequested) {
      gqlPage++;
      updateHUDStatus(
        `Pass 2 (Reels GraphQL): Page ${gqlPage} • Unique Reels: ${stagingRoom.reelsVault.size} | Dups: ${stagingRoom.duplicateVault.size}...`
      );

      const res = await callMainWorld("FETCH_REELS_GRAPHQL", {
        userId: activeTargetUserId,
        afterCursor
      });

      const conn = res?.data?.data?.xdt_api__v1__clips__user__connection_v2;
      if (!conn) break;

      routePayloadIntoStagingRoom(res.data, activeTargetUsername, "reels");

      const hasNext = Boolean(conn.page_info?.has_next_page);
      const endCursor = conn.page_info?.end_cursor || null;
      if (hasNext && endCursor && !seenGqlCursors.has(String(endCursor))) {
        seenGqlCursors.add(String(endCursor));
        afterCursor = String(endCursor);
        await sleep(320);
      } else {
        apiExhausted = true;
        break;
      }
    }
  }

  // 3. If both APIs stopped early, switch to Reels tab and run one smooth continuous scroll (relying on passive GraphQL interception, NO per-anchor blocking!)
  if (!stopRequested && !apiExhausted) {
    await switchProfileTab(username, "reels");
    await continuousNonStopScroll("reels");
  }
}

// Strict 4-Tab Selector: Only clicks Grid (`/[user]/`) or Reels (`/[user]/reels/`), NEVER clicks Reposts or Tagged!
async function switchProfileTab(username, section) {
  const lowerUser = username.toLowerCase();
  const allLinks = Array.from(document.querySelectorAll("a[href]"));

  const targetLink = allLinks.find((a) => {
    const rawHref = (a.getAttribute("href") || "").toLowerCase();
    const cleanHref = rawHref.split("?")[0].replace(/\/$/, "");
    if (section === "reels") {
      return cleanHref === `/${lowerUser}/reels`;
    } else {
      return cleanHref === `/${lowerUser}`;
    }
  });

  if (targetLink) {
    targetLink.click();
    await sleep(1000);
    scanEmbeddedPageScripts(activeTargetUsername, section);
    return true;
  }
  return false;
}

// Fast Continuous Scroll (Zero per-item network calls -> Never pauses/rescans!)
async function continuousNonStopScroll(phaseTag) {
  let idleTicks = 0;
  let lastTotalRoomSize =
    stagingRoom.gridVault.size + stagingRoom.reelsVault.size + stagingRoom.duplicateVault.size;
  let lastScrollHeight = 0;

  while (!stopRequested && idleTicks < 5) {
    window.scrollTo(0, document.body.scrollHeight);
    window.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(700);

    const hasSpinner = Boolean(
      document.querySelector('main [role="progressbar"], main svg[aria-label="Loading..."]')
    );

    const currentRoomSize =
      stagingRoom.gridVault.size + stagingRoom.reelsVault.size + stagingRoom.duplicateVault.size;
    const currentHeight = document.body.scrollHeight;

    updateHUDStatus(
      `Fast Scrolling ${phaseTag.toUpperCase()} • Sec1: ${stagingRoom.gridVault.size} | Sec2: ${stagingRoom.reelsVault.size} | Sec3 Dups: ${stagingRoom.duplicateVault.size}`
    );

    if (currentRoomSize > lastTotalRoomSize || currentHeight > lastScrollHeight) {
      idleTicks = 0;
      lastTotalRoomSize = currentRoomSize;
      lastScrollHeight = currentHeight;
    } else if (hasSpinner) {
      await sleep(750);
      idleTicks++;
    } else {
      idleTicks++;
    }
  }
}

async function resolvePendingDeepMedia(usernameLower) {
  const entries = Array.from(pendingDeepResolvePks.entries()).filter(([pk]) => !resolvedDeepPks.has(pk));
  let idx = 0;

  for (const [pk, phaseTag] of entries) {
    if (stopRequested) break;
    idx++;
    resolvedDeepPks.add(pk);
    updateHUDStatus(`Expanding Carousel (${idx}/${entries.length})...`);

    const res = await callMainWorld("FETCH_MEDIA_INFO", { mediaPk: pk });
    if (res && res.ok && res.data) {
      routePayloadIntoStagingRoom(res.data, usernameLower, phaseTag);
    }
    await sleep(350);
  }
}

// =========================================================
// 3-ROOM PARTITION ROUTER (Places each item into Sec 1, Sec 2, or Sec 3)
// =========================================================
function routePayloadIntoStagingRoom(rootObj, targetUserLower, phaseTag = "posts") {
  const visited = new WeakSet();

  function walk(node, activePhase = phaseTag) {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, activePhase);
      return;
    }

    if (node.reels_media || node.tray || node.story_ranking_token) return;

    if (node.xdt_api__v1__clips__user__connection_v2) {
      walk(node.xdt_api__v1__clips__user__connection_v2, "reels");
      return;
    }
    if (node.xdt_api__v1__feed__user_timeline_graphql_connection || node.edge_owner_to_timeline_media) {
      walk(
        node.xdt_api__v1__feed__user_timeline_graphql_connection || node.edge_owner_to_timeline_media,
        "posts"
      );
      return;
    }

    if (node.media && typeof node.media === "object" && (node.media.code || node.media.pk || node.media.shortcode)) {
      walk(node.media, activePhase);
    }

    const shortcode = node.code || node.shortcode;
    const isMediaItem =
      shortcode &&
      !node.expiring_at &&
      (node.media_type !== undefined ||
        node.__typename ||
        node.image_versions2 ||
        node.video_versions ||
        node.carousel_media ||
        node.edge_sidecar_to_children ||
        node.display_url ||
        node.video_url);

    if (isMediaItem) {
      partitionMediaNodeIntoRoom(node, targetUserLower, activePhase);
      return;
    }

    for (const k of Object.keys(node)) {
      if (k === "reels_media" || k === "stories") continue;
      walk(node[k], activePhase);
    }
  }

  walk(rootObj, phaseTag);
  updateRoomHUDCounters();
}

function partitionMediaNodeIntoRoom(item, targetUserLower, phaseTag) {
  // Strictly skip Reposts tab items!
  if (item.repost_info || item.original_media_id) return;

  const ownerUsername = (item.user?.username || item.owner?.username || "").toLowerCase();
  const ownerPk = cleanPk(item.user?.pk || item.user?.id || item.owner?.id || item.owner?.pk);

  if (ownerUsername === targetUserLower && ownerPk && !activeTargetUserId) {
    activeTargetUserId = ownerPk;
  }

  let isTargetOwner = false;
  if (ownerUsername === targetUserLower) {
    isTargetOwner = true;
  } else if (!ownerUsername && activeTargetUserId && ownerPk === activeTargetUserId) {
    isTargetOwner = true;
  } else {
    const coauthors = [
      ...(Array.isArray(item.coauthor_producers) ? item.coauthor_producers : []),
      ...(Array.isArray(item.invited_coauthor_producers) ? item.invited_coauthor_producers : [])
    ];
    for (const ca of coauthors) {
      if ((ca?.username || "").toLowerCase() === targetUserLower) {
        isTargetOwner = true;
        break;
      }
    }
  }

  if (!isTargetOwner) return;

  const shortcode = String(item.code || item.shortcode).trim();
  const mediaPk = cleanPk(item.pk || item.id);

  const isCarousel =
    item.media_type === 8 ||
    item.__typename === "GraphSidecar" ||
    item.__typename === "XDTGraphSidecar" ||
    Array.isArray(item.carousel_media) ||
    Boolean(item.edge_sidecar_to_children);

  if (isCarousel) {
    const slides =
      item.carousel_media ||
      (item.edge_sidecar_to_children?.edges || []).map((e) => e?.node).filter(Boolean) ||
      [];

    const expectedCount = item.carousel_media_count || slides.length;
    if ((slides.length === 0 || slides.length < expectedCount) && mediaPk && !resolvedDeepPks.has(mediaPk)) {
      pendingDeepResolvePks.set(mediaPk, phaseTag);
      return;
    }

    slides.forEach((slide, index) => {
      const slideNum = index + 1;
      const slideKey = `${shortcode}_slide_${slideNum}`;
      const slidePk = cleanPk(slide.pk || slide.id) || `${mediaPk}_s${slideNum}`;

      const slideIsVideo =
        slide.media_type === 2 ||
        slide.is_video === true ||
        slide.__typename === "GraphVideo" ||
        slide.__typename === "XDTGraphVideo" ||
        (Array.isArray(slide.video_versions) && slide.video_versions.length > 0);

      const extracted = extractStrictMediaUrl(slide, slideIsVideo);
      if (!extracted) {
        if (slideIsVideo && mediaPk && !resolvedDeepPks.has(mediaPk)) {
          pendingDeepResolvePks.set(mediaPk, phaseTag);
        }
        return;
      }

      const baseUrl = getBaseCdnPath(extracted.url);
      const filename = `${shortcode}_${slideNum}.${extracted.ext}`;
      const fpHash = fnv1a64Hash(`${slidePk}|${slideKey}|${baseUrl}`);

      const mediaRecord = {
        username: targetUserLower,
        shortcode: `${shortcode}_${slideNum}`,
        url: extracted.url,
        filename
      };

      placeSlideIntoRoomSection(
        phaseTag,
        shortcode,
        slideKey,
        slidePk,
        baseUrl,
        fpHash,
        true,
        mediaRecord
      );
    });
    return;
  }

  const singleSlideKey = `${shortcode}_slide_1`;
  const singlePk = mediaPk || shortcode;

  const isVideoItem =
    item.media_type === 2 ||
    item.is_video === true ||
    item.product_type === "clips" ||
    item.product_type === "igtv" ||
    item.__typename === "GraphVideo" ||
    item.__typename === "XDTGraphVideo" ||
    (Array.isArray(item.video_versions) && item.video_versions.length > 0);

  const extracted = extractStrictMediaUrl(item, isVideoItem);
  if (!extracted) {
    if (isVideoItem && mediaPk && !resolvedDeepPks.has(mediaPk)) {
      pendingDeepResolvePks.set(mediaPk, phaseTag);
    }
    return;
  }

  const baseUrl = getBaseCdnPath(extracted.url);
  const filename = `${shortcode}.${extracted.ext}`;
  const fpHash = fnv1a64Hash(`${singlePk}|${singleSlideKey}|${baseUrl}`);

  const mediaRecord = {
    username: targetUserLower,
    shortcode,
    url: extracted.url,
    filename
  };

  placeSlideIntoRoomSection(
    phaseTag,
    shortcode,
    singleSlideKey,
    singlePk,
    baseUrl,
    fpHash,
    false,
    mediaRecord
  );
}

function placeSlideIntoRoomSection(
  phaseTag,
  rootShortcode,
  slideKey,
  mediaPk,
  baseUrl,
  fpHash,
  isCarousel,
  mediaRecord
) {
  if (phaseTag === "posts") {
    if (
      stagingRoom.gridVault.has(slideKey) ||
      stagingRoom.gridFingerprints.has(fpHash) ||
      stagingRoom.gridMediaPks.has(mediaPk) ||
      stagingRoom.gridBaseUrls.has(baseUrl)
    ) {
      return;
    }

    stagingRoom.gridVault.set(slideKey, mediaRecord);
    stagingRoom.gridFingerprints.add(fpHash);
    stagingRoom.gridMediaPks.add(mediaPk);
    stagingRoom.gridBaseUrls.add(baseUrl);
    if (!isCarousel) stagingRoom.gridShortcodes.add(rootShortcode);

    if (stagingRoom.reelsVault.has(slideKey)) {
      stagingRoom.reelsVault.delete(slideKey);
      stagingRoom.duplicateVault.set(slideKey, mediaRecord);
    }
  } else {
    const existsInGridVault =
      stagingRoom.gridVault.has(slideKey) ||
      stagingRoom.gridShortcodes.has(rootShortcode) ||
      stagingRoom.gridFingerprints.has(fpHash) ||
      stagingRoom.gridMediaPks.has(mediaPk) ||
      stagingRoom.gridBaseUrls.has(baseUrl);

    if (existsInGridVault) {
      stagingRoom.duplicateVault.set(slideKey, mediaRecord);
      return;
    }

    if (stagingRoom.reelsVault.has(slideKey) || stagingRoom.reelsFingerprints.has(fpHash)) {
      return;
    }

    stagingRoom.reelsVault.set(slideKey, mediaRecord);
    stagingRoom.reelsFingerprints.add(fpHash);
  }
}

function extractStrictMediaUrl(node, mustBeVideo) {
  if (!node) return null;

  if (mustBeVideo) {
    if (Array.isArray(node.video_versions) && node.video_versions.length > 0) {
      const sorted = [...node.video_versions].sort(
        (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
      );
      if (sorted[0]?.url) return { url: sorted[0].url, ext: "mp4" };
    }
    if (node.video_url) return { url: node.video_url, ext: "mp4" };
    return null;
  }

  const candidates = node.image_versions2?.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const sorted = [...candidates].sort(
      (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
    );
    if (sorted[0]?.url) return { url: sorted[0].url, ext: "jpg" };
  }
  if (Array.isArray(node.display_resources) && node.display_resources.length > 0) {
    const last = node.display_resources[node.display_resources.length - 1];
    if (last?.src) return { url: last.src, ext: "jpg" };
  }
  if (node.display_url) return { url: node.display_url, ext: "jpg" };

  return null;
}

function resetButton() {
  const btn = document.getElementById("instaswift-download-btn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "⚡ Download All";
  }
}