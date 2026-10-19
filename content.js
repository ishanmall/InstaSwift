let isScanning = false;
let stopRequested = false;
let activeTargetUsername = "";
let activeTargetUserId = "";
let currentActiveScanPhase = "posts"; // "posts" | "reels"
let preferredImageFormat = "auto";

// Target header count (e.g., 602 posts)
let expectedProfilePostCount = 0;

// Clean 2-Section Shortcode Trackers
const gridPostShortcodes = new Set(); // Tracks unique Posts/Carousels/Grid-Reels in Posts Tab
const reelsTabShortcodes = new Set(); // Tracks Reels in Reels Tab

// Shared In-Memory Deduplication Sets (Guarantees NO duplicate between Grid Posts & Reels Tab)
const seenShortcodesGlobal = new Set();
const seenMediaPksGlobal = new Set();
const seenSlideKeysGlobal = new Set();
const seenAssetIdsGlobal = new Set();

// Deep resolution queues for multi-slide carousels
const pendingDeepResolvePks = new Set();
const pendingShortcodeResolves = new Set();
const resolvedDeepPks = new Set();

// Passive caches for single-post & manual story buttons
const mediaCacheByShortcode = new Map();
const storyItemsByKey = new Map();

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

function callMainWorld(cmd, payload, timeoutMs = 10000) {
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
  } else if (type === "INTERCEPTED_JSON") {
    const payload = event.data.payload;
    if (!payload) return;
    const reqUrl = event.data.url || "";
    rawInterceptBuffer.push({ url: reqUrl, payload });
    if (rawInterceptBuffer.length > 600) rawInterceptBuffer.shift();

    indexPassiveMediaAndStories(payload);

    if (isScanning && activeTargetUsername) {
      const sec = determineSectionFromPayloadOrState(payload, reqUrl);
      parseInstagramPayload(payload, activeTargetUsername, true, sec);
    }
  }
});

function determineSectionFromPayloadOrState(payload, reqUrl) {
  if (
    reqUrl.includes("clips") ||
    payload?.data?.xdt_api__v1__clips__user__connection_v2 ||
    window.location.pathname.includes("/reels")
  ) {
    return "reels";
  }
  if (
    payload?.data?.xdt_api__v1__feed__user_timeline_graphql_connection ||
    payload?.data?.user?.edge_owner_to_timeline_media
  ) {
    return "posts";
  }
  return currentActiveScanPhase;
}

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

// =========================================================
// 1. PROFILE BUTTON & PHOTO FORMAT SELECTOR
// =========================================================
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
  btn.innerHTML = "⚡ Download All (Posts + Reels)";
  btn.addEventListener("click", () => {
    const currentUsername = getUsernameFromUrl();
    if (currentUsername) startProfileDownload(currentUsername);
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

// =========================================================
// 2. SINGLE POST DOWNLOAD BUTTONS (GRID HOVER + MODAL)
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

    const res = await callMainWorld("FETCH_FULL_POST_BY_SHORTCODE", { shortcode, isReel }, 8500);
    let targetNode = null;

    if (res && res.ok && res.data) {
      indexPassiveMediaAndStories(res.data);
      targetNode = mediaCacheByShortcode.get(shortcode);
    }

    if (!targetNode) {
      scanEmbeddedPageScripts(ownerFallback, isReel ? "reels" : "posts");
      targetNode = mediaCacheByShortcode.get(shortcode);
    }

    const discoveredBatch = [];
    if (targetNode) {
      const ownerUser = (
        targetNode.user?.username ||
        targetNode.owner?.username ||
        ownerFallback
      ).toLowerCase();
      extractSlidesFromMediaNode(
        targetNode,
        ownerUser,
        isReel ? "reels" : "posts",
        discoveredBatch,
        true
      );
    }

    if (discoveredBatch.length === 0) {
      updateHUDStatus(`⚠️ Could not extract media for ${shortcode}.`);
      return;
    }

    const preparedItems = await prepareItemsForFormat(discoveredBatch);
    await safeSendMessage({
      action: "DOWNLOAD_ITEMS",
      items: preparedItems
    });

    updateHUDStatus(`✅ Downloading ${preparedItems.length} file(s) from post ${shortcode}!`);
    if (btnEl) btnEl.innerHTML = `✓ (${preparedItems.length})`;
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

// =========================================================
// 3. MANUAL STORY DOWNLOADER (EXCLUDED FROM DOWNLOAD ALL)
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
  const isHighlight = pathParts[1] === "highlights";
  const targetSlug = (pathParts[1] || "stories").toLowerCase();
  const currentStoryPk = cleanPk(pathParts[2] || "");

  createOrShowHUD(targetSlug);
  updateHUDStatus("Fetching Story media...");

  scanEmbeddedPageScripts(targetSlug, "stories");

  if (isHighlight && pathParts[2]) {
    const res = await callMainWorld("FETCH_STORIES_REEL", { reelId: `highlight:${pathParts[2]}` });
    if (res?.ok && res?.data) indexPassiveMediaAndStories(res.data);
  } else if (!isHighlight && targetSlug) {
    const uid = findUserIdInDOM(targetSlug);
    if (uid) {
      const sRes = await callMainWorld("FETCH_STORIES_REEL", { reelId: uid });
      if (sRes?.ok && sRes?.data) indexPassiveMediaAndStories(sRes.data);
    }
  }

  const batch = [];
  if (!downloadAllInReel && currentStoryPk && storyItemsByKey.has(currentStoryPk)) {
    batch.push(storyItemsByKey.get(currentStoryPk));
  } else if (downloadAllInReel && storyItemsByKey.size > 0) {
    for (const item of storyItemsByKey.values()) {
      if (!isHighlight && item.username && item.username !== targetSlug) continue;
      batch.push(item);
    }
  }

  if (batch.length === 0) {
    const videoEl = document.querySelector("video");
    const imgEl = document.querySelector('img[decoding="sync"], section img');
    const storyId = currentStoryPk || `story_${Date.now()}`;

    if (videoEl && (videoEl.currentSrc || videoEl.src) && !(videoEl.currentSrc || videoEl.src).startsWith("blob:")) {
      const vUrl = videoEl.currentSrc || videoEl.src;
      batch.push({
        username: targetSlug,
        uid: `story_${storyId}`,
        section: "stories",
        url: vUrl,
        baseFilename: `story_${storyId}`,
        extHint: "mp4",
        filename: `story_${storyId}.mp4`
      });
    } else if (imgEl && imgEl.src) {
      const ext = detectExtensionHintFromUrl(imgEl.src, false);
      batch.push({
        username: targetSlug,
        uid: `story_${storyId}`,
        section: "stories",
        url: imgEl.src,
        baseFilename: `story_${storyId}`,
        extHint: ext,
        filename: `story_${storyId}.${ext}`
      });
    }
  }

  if (batch.length === 0) {
    updateHUDStatus("⚠️ Pause story for 1 second & click again.");
    return;
  }

  const prepared = await prepareItemsForFormat(batch);
  await safeSendMessage({
    action: "DOWNLOAD_ITEMS",
    items: prepared
  });
  updateHUDStatus(`✅ Downloading ${prepared.length} Story item(s)!`);
}

// =========================================================
// 4. CLEAN 2-BOX HUD (1. POSTS GRID  2. REELS SECTION)
// =========================================================
function createOrShowHUD(username) {
  let hud = document.getElementById("instaswift-hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "instaswift-hud";
    hud.innerHTML = `
      <div class="is-hud-header">
        <span class="is-hud-title">⚡ InstaSwift v10 — <strong id="is-hud-user">@${username}</strong></span>
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
      <div class="is-hud-sub" id="is-hud-sub">No Duplication Between Posts & Reels</div>
      <div class="is-hud-actions">
        <button id="is-hud-stop" class="is-stop-btn">Stop</button>
      </div>
    `;
    document.body.appendChild(hud);

    document.getElementById("is-hud-close").addEventListener("click", () => {
      hud.style.display = "none";
    });

    document.getElementById("is-hud-stop").addEventListener("click", async () => {
      stopRequested = true;
      isScanning = false;
      await safeSendMessage({ action: "STOP_ALL" });
      updateHUDStatus("Stopped.");
      resetButton();
    });
  } else {
    hud.style.display = "block";
    document.getElementById("is-hud-user").textContent = `@${username}`;
  }
}

function updateHUDStatus(text) {
  const el = document.getElementById("is-hud-status");
  if (el) el.textContent = text;
  updateHUDCounters();
}

function updateHUDCounters() {
  const domCount = parseExpectedPostsFromHeaderDOM();
  if (domCount > expectedProfilePostCount) {
    expectedProfilePostCount = domCount;
  }

  const pEl = document.getElementById("is-stat-posts");
  const rEl = document.getElementById("is-stat-reels");
  const sub = document.getElementById("is-hud-sub");

  if (pEl) {
    pEl.textContent =
      expectedProfilePostCount > 0
        ? `${gridPostShortcodes.size} / ${expectedProfilePostCount}`
        : `${gridPostShortcodes.size}`;
  }
  if (rEl) {
    rEl.textContent = `${reelsTabShortcodes.size}`;
  }
  if (sub) {
    sub.textContent = `Total Unique Files Downloading: ${seenSlideKeysGlobal.size} • Format: ${preferredImageFormat.toUpperCase()}`;
  }
}

try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "STATS_UPDATE" && msg.stats) {
      const st = document.getElementById("is-hud-status");
      if (st && !isScanning) st.textContent = msg.stats.status;
      updateHUDCounters();
    } else if (msg.action === "TRIGGER_FROM_POPUP") {
      if (msg.format) {
        preferredImageFormat = msg.format;
        const sel = document.getElementById("instaswift-fmt-select");
        if (sel) sel.value = preferredImageFormat;
      }
      const username = getUsernameFromUrl();
      if (username) startProfileDownload(username);
    }
  });
} catch (_) {}

function cleanPk(raw) {
  if (!raw) return "";
  return String(raw).split("_")[0].trim();
}

function getNormalizedAssetId(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : u.pathname;
  } catch (_) {
    return url;
  }
}

function detectExtensionHintFromUrl(url, mustBeVideo) {
  if (mustBeVideo) return "mp4";
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return "png";
    if (pathname.endsWith(".webp")) return "webp";
  } catch (_) {}
  return "jpg";
}

function findUserIdInDOM(usernameLower) {
  const html = document.documentElement.innerHTML;
  const escaped = usernameLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes = [
    new RegExp(`"id":"(\\d+)"[^}]{0,250}"username":"${escaped}"`, "i"),
    new RegExp(`"username":"${escaped}"[^}]{0,250}"id":"(\\d+)"`, "i"),
    new RegExp(`"pk":"(\\d+)"[^}]{0,250}"username":"${escaped}"`, "i"),
    /"profilePage_(\d+)"/,
    /"target_id":"(\d+)"/
  ];
  for (const rx of regexes) {
    const m = html.match(rx);
    if (m && m[1]) return m[1];
  }
  return "";
}

async function prepareItemsForFormat(items) {
  if (preferredImageFormat === "auto") return items;

  const out = [];
  for (const item of items) {
    if (item.extHint === "mp4" || item.filename.endsWith(".mp4")) {
      out.push(item);
      continue;
    }
    const targetExt = preferredImageFormat === "png" ? "png" : "jpg";
    const conv = await callMainWorld("CONVERT_IMAGE_DATAURL", {
      url: item.url,
      format: targetExt
    }, 10000);

    if (conv && conv.ok && conv.dataUrl) {
      out.push({
        ...item,
        url: conv.dataUrl,
        convertedFormat: targetExt,
        extHint: targetExt,
        filename: `${item.baseFilename}.${targetExt}`
      });
    } else {
      out.push({
        ...item,
        convertedFormat: null,
        filename: `${item.baseFilename}.${item.extHint}`
      });
    }
  }
  return out;
}

function resetCleanSession() {
  gridPostShortcodes.clear();
  reelsTabShortcodes.clear();
  seenShortcodesGlobal.clear();
  seenMediaPksGlobal.clear();
  seenSlideKeysGlobal.clear();
  seenAssetIdsGlobal.clear();
  pendingDeepResolvePks.clear();
  pendingShortcodeResolves.clear();
  resolvedDeepPks.clear();
}

function scanEmbeddedPageScripts(usernameLower, sectionContext = "posts") {
  const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
  for (const s of scripts) {
    const txt = (s.textContent || "").trim();
    if (
      txt.startsWith("{") &&
      (txt.toLowerCase().includes(usernameLower) ||
        txt.includes("xdt_api__v1__") ||
        txt.includes("edge_owner_to_timeline_media") ||
        txt.includes("video_versions") ||
        txt.includes("image_versions2") ||
        txt.includes("reels_media"))
    ) {
      try {
        const parsed = JSON.parse(txt);
        indexPassiveMediaAndStories(parsed);
        if (isScanning && activeTargetUsername) {
          parseInstagramPayload(parsed, usernameLower, false, sectionContext);
        }
      } catch (_) {}
    }
  }
}

async function resolveProfileMetadata(username) {
  const headerCount = parseExpectedPostsFromHeaderDOM();
  if (headerCount > 0) {
    expectedProfilePostCount = headerCount;
  }

  activeTargetUserId = findUserIdInDOM(activeTargetUsername);

  const res = await callMainWorld("FETCH_WEB_PROFILE_INFO", { username });
  if (res && res.ok && res.data) {
    const userObj = res.data?.data?.user || res.data?.graphql?.user || res.data?.user;
    if (userObj) {
      if (userObj.id || userObj.pk) {
        activeTargetUserId = cleanPk(userObj.id || userObj.pk);
      }
      const apiPostCount =
        userObj.edge_owner_to_timeline_media?.count ??
        userObj.media_count ??
        0;
      if (apiPostCount > expectedProfilePostCount) {
        expectedProfilePostCount = apiPostCount;
      }
    }
    indexPassiveMediaAndStories(res.data);
    await parseInstagramPayload(res.data, activeTargetUsername, true, "posts");
  }
}

// =========================================================
// 5. MAIN 2-STEP WORKFLOW:
//    STEP 1 -> GRID POSTS SECTION
//    STEP 2 -> REELS SECTION (SKIPPING ANY REEL ALREADY IN GRID)
// =========================================================
async function startProfileDownload(username) {
  if (isScanning) return;
  isScanning = true;
  stopRequested = false;
  activeTargetUsername = username.toLowerCase();
  expectedProfilePostCount = parseExpectedPostsFromHeaderDOM();
  resetCleanSession();

  createOrShowHUD(username);
  updateHUDStatus("Starting: Resolving profile info...");

  const btn = document.getElementById("instaswift-download-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Downloading...";
  }

  try {
    const initRes = await safeSendMessage({
      action: "INIT_SESSION",
      username: activeTargetUsername,
      format: preferredImageFormat
    });
    if (!initRes) {
      updateHUDStatus("⚠️ Please press F5 to refresh this Instagram tab.");
      return;
    }

    if (
      document.body.innerText.includes("This account is private") ||
      document.body.innerText.includes("This Account is Private")
    ) {
      updateHUDStatus("🔒 Private profile.");
      return;
    }

    await resolveProfileMetadata(username);

    for (const entry of rawInterceptBuffer) {
      const sec = determineSectionFromPayloadOrState(entry.payload, entry.url || "");
      await parseInstagramPayload(entry.payload, activeTargetUsername, false, sec);
    }

    // LOGIC 1: Scan Main Grid Posts Section (Photos, Carousels, Collab Posts, Grid-Reels)
    if (!stopRequested) {
      currentActiveScanPhase = "posts";
      updateHUDStatus(`Logic 1/2: Scanning Grid Posts Section (${expectedProfilePostCount || "All"} posts)...`);
      await scanPostsTabCompletely(username);
    }

    // LOGIC 2: Scan Reels Section (Only downloads Reels not already found in Grid Posts)
    if (!stopRequested) {
      currentActiveScanPhase = "reels";
      updateHUDStatus("Logic 2/2: Scanning Reels Section (Skipping duplicates from Grid)...");
      await scanReelsTabCompletely(username);
    }

    // Expand any Carousels or Videos that needed full slide info
    if (!stopRequested && (pendingDeepResolvePks.size > 0 || pendingShortcodeResolves.size > 0)) {
      updateHUDStatus(
        `Expanding ${pendingDeepResolvePks.size + pendingShortcodeResolves.size} multi-slide posts...`
      );
      await resolvePendingDeepMedia(activeTargetUsername);
    }

    if (!stopRequested) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      await safeSendMessage({
        action: "SCAN_FINISHED",
        gridPostsCount: gridPostShortcodes.size,
        reelsCount: reelsTabShortcodes.size
      });
      updateHUDStatus(
        `Scan Done! Grid Posts: ${gridPostShortcodes.size} • Reels: ${reelsTabShortcodes.size} (Zero Duplicates)`
      );
    }
  } catch (err) {
    updateHUDStatus(`Error: ${err.message}`);
  } finally {
    isScanning = false;
    resetButton();
  }
}

async function scanPostsTabCompletely(username) {
  await switchProfileTab(username, "posts");
  scanEmbeddedPageScripts(activeTargetUsername, "posts");

  // 1. GraphQL Timeline Pagination
  await paginatePostsViaGraphql(username);

  // 2. REST Feed Pagination if more remain
  const reachedTargetAfterGql =
    expectedProfilePostCount > 0 && gridPostShortcodes.size >= expectedProfilePostCount;

  if (!stopRequested && !reachedTargetAfterGql) {
    await paginatePostsViaRest(username);
  }

  // 3. Auto-Scroll Main Grid until all 602+ posts are captured
  const reachedTargetAfterRest =
    expectedProfilePostCount > 0 && gridPostShortcodes.size >= expectedProfilePostCount;

  if (!stopRequested && !reachedTargetAfterRest) {
    await patientGridScrollExtractor(username, "posts");
  }
}

async function paginatePostsViaGraphql(username) {
  let afterCursor = null;
  let page = 0;
  const visitedCursors = new Set();

  while (!stopRequested) {
    page++;
    updateHUDStatus(
      `Grid Posts Section — Page ${page} (${gridPostShortcodes.size}/${expectedProfilePostCount || "?"})...`
    );

    let res = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      res = await callMainWorld("FETCH_POSTS_GRAPHQL", { username, afterCursor });
      if (res && res.ok && res.data) break;
      await sleep(950 * attempt);
    }

    const conn = res?.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    if (!conn) return;

    await parseInstagramPayload(res.data, activeTargetUsername, true, "posts");

    const hasNext = Boolean(conn.page_info?.has_next_page);
    const endCursor = conn.page_info?.end_cursor || null;

    if (hasNext && endCursor && !visitedCursors.has(String(endCursor))) {
      visitedCursors.add(String(endCursor));
      afterCursor = String(endCursor);
      await sleep(650 + Math.random() * 300);
    } else {
      return;
    }
  }
}

async function paginatePostsViaRest(username) {
  let maxId = null;
  let page = 0;
  const visitedCursors = new Set();

  while (!stopRequested) {
    page++;
    updateHUDStatus(
      `Grid Posts Section — Feed Page ${page} (${gridPostShortcodes.size}/${expectedProfilePostCount || "?"})...`
    );

    const res = await callMainWorld("FETCH_POSTS_REST", {
      username,
      userId: activeTargetUserId,
      maxId
    });

    if (!res || !res.ok || !res.data) return;

    const data = res.data;
    if (!activeTargetUserId && data.user?.pk) {
      activeTargetUserId = cleanPk(data.user.pk);
    }

    await parseInstagramPayload(data, activeTargetUsername, true, "posts");

    const nextCursor = data.next_max_id || data.paging_info?.max_id || null;
    const moreAvailable = Boolean(data.more_available || data.paging_info?.more_available);

    if (moreAvailable && nextCursor && !visitedCursors.has(String(nextCursor))) {
      visitedCursors.add(String(nextCursor));
      maxId = String(nextCursor);
      await sleep(700 + Math.random() * 300);
    } else {
      return;
    }
  }
}

async function scanReelsTabCompletely(username) {
  const switched = await switchProfileTab(username, "reels");
  if (!switched && !window.location.pathname.includes("/reels")) {
    return;
  }

  scanEmbeddedPageScripts(activeTargetUsername, "reels");

  if (!activeTargetUserId) {
    activeTargetUserId = findUserIdInDOM(activeTargetUsername);
  }

  let apiExhausted = false;
  if (activeTargetUserId) {
    apiExhausted = await paginateReelsUntilExhausted(activeTargetUserId);
  }

  if (!stopRequested && !apiExhausted) {
    await patientGridScrollExtractor(username, "reels");
  }
}

async function paginateReelsUntilExhausted(userId) {
  let maxId = null;
  let page = 0;
  const visitedCursors = new Set();

  while (!stopRequested) {
    page++;
    updateHUDStatus(`Reels Section — Page ${page} (${reelsTabShortcodes.size} Reels scanned)...`);

    let res = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await callMainWorld("FETCH_REELS_PAGE", { userId, maxId });
      if (res && res.ok && res.data) break;
      await sleep(1050 * attempt);
    }

    if (!res || !res.ok || !res.data) {
      return false;
    }

    const data = res.data;
    const paging = data.paging_info || {};
    const nextCursor = paging.max_id || data.next_max_id || null;
    const moreAvailable = Boolean(paging.more_available || data.more_available);

    await parseInstagramPayload(data, activeTargetUsername, true, "reels");

    if (moreAvailable && nextCursor && !visitedCursors.has(String(nextCursor))) {
      visitedCursors.add(String(nextCursor));
      maxId = String(nextCursor);
      await sleep(750 + Math.random() * 300);
    } else if (!moreAvailable) {
      return true;
    } else {
      return false;
    }
  }
  return false;
}

async function switchProfileTab(username, section) {
  const lowerUser = username.toLowerCase();
  const currentPath = window.location.pathname.toLowerCase().replace(/\/$/, "");
  const desiredPath = section === "reels" ? `/${lowerUser}/reels` : `/${lowerUser}`;

  if (currentPath === desiredPath) return true;

  const allLinks = Array.from(document.querySelectorAll("a[href]"));
  const targetLink = allLinks.find((a) => {
    const href = (a.getAttribute("href") || "").toLowerCase().split("?")[0].replace(/\/$/, "");
    return href === desiredPath;
  });

  if (targetLink) {
    targetLink.click();
    await sleep(1800);
    scanEmbeddedPageScripts(activeTargetUsername, section);
    return true;
  }
  return false;
}

async function patientGridScrollExtractor(username, section) {
  let idleRounds = 0;
  const maxIdleRounds = 18;
  let lastCount = section === "reels" ? reelsTabShortcodes.size : gridPostShortcodes.size;

  while (!stopRequested && idleRounds < maxIdleRounds) {
    if (
      section === "posts" &&
      expectedProfilePostCount > 0 &&
      gridPostShortcodes.size >= expectedProfilePostCount
    ) {
      return;
    }

    await harvestVisibleGridAnchors(section);

    const anchors = document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]');
    if (anchors.length > 0) {
      anchors[anchors.length - 1].scrollIntoView({ behavior: "smooth", block: "end" });
    }
    window.scrollBy({ top: 700, behavior: "smooth" });
    await sleep(1200);

    await harvestVisibleGridAnchors(section);

    const hasLoadingSpinner = Boolean(
      document.querySelector(
        'main [role="progressbar"], main svg[aria-label="Loading..."], [data-visualcompletion="loading-state"]'
      )
    );

    const currentCount = section === "reels" ? reelsTabShortcodes.size : gridPostShortcodes.size;
    updateHUDStatus(
      section === "posts"
        ? `Scrolling Grid Posts Section (${currentCount}/${expectedProfilePostCount || "?"})...`
        : `Scrolling Reels Section (${currentCount} Reels)...`
    );

    if (currentCount > lastCount) {
      idleRounds = 0;
      lastCount = currentCount;
    } else if (hasLoadingSpinner) {
      idleRounds = Math.max(0, idleRounds - 1);
      await sleep(1300);
    } else {
      idleRounds++;
      if (idleRounds % 4 === 0) {
        window.scrollBy({ top: -450, behavior: "instant" });
        await sleep(300);
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        await sleep(950);
      }
    }
  }
}

async function harvestVisibleGridAnchors(sectionContext) {
  const anchors = Array.from(document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]'));

  for (const a of anchors) {
    if (stopRequested) break;
    const href = a.getAttribute("href") || "";
    const match = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (!match) continue;

    const shortcode = match[2];

    if (sectionContext === "reels") {
      // Only count in Reels if not already in Grid Posts, or track all Reels Tab items
      reelsTabShortcodes.add(shortcode);
    } else {
      gridPostShortcodes.add(shortcode);
    }

    const slide1Key = `${shortcode}_slide_1`;
    if (seenShortcodesGlobal.has(shortcode) || seenSlideKeysGlobal.has(slide1Key)) {
      continue;
    }

    const cachedNode = mediaCacheByShortcode.get(shortcode);
    if (cachedNode) {
      await parseInstagramPayload(cachedNode, activeTargetUsername, true, sectionContext);
    } else {
      pendingShortcodeResolves.add(shortcode);
    }
  }
  updateHUDCounters();
}

async function resolvePendingDeepMedia(usernameLower) {
  const pks = Array.from(pendingDeepResolvePks).filter((pk) => !resolvedDeepPks.has(pk));
  let idx = 0;

  for (const pk of pks) {
    if (stopRequested) break;
    idx++;
    resolvedDeepPks.add(pk);
    updateHUDStatus(`Fetching Carousel slides (${idx}/${pks.length})...`);

    const res = await callMainWorld("FETCH_MEDIA_INFO", { mediaPk: pk });
    if (res && res.ok && res.data) {
      await parseInstagramPayload(res.data, usernameLower, true, currentActiveScanPhase);
    }
    await sleep(550 + Math.random() * 250);
  }

  const codes = Array.from(pendingShortcodeResolves).filter(
    (c) => !seenShortcodesGlobal.has(c) && !seenSlideKeysGlobal.has(`${c}_slide_1`)
  );
  let cIdx = 0;
  for (const shortcode of codes) {
    if (stopRequested) break;
    cIdx++;
    updateHUDStatus(`Fetching Post (${cIdx}/${codes.length}): ${shortcode}...`);
    const res = await callMainWorld("FETCH_FULL_POST_BY_SHORTCODE", { shortcode, isReel: false });
    if (res && res.ok && res.data) {
      await parseInstagramPayload(res.data, usernameLower, true, currentActiveScanPhase);
    }
    await sleep(600 + Math.random() * 250);
  }
}

function indexPassiveMediaAndStories(rootObj) {
  const visited = new WeakSet();

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const pk = cleanPk(node.pk || node.id);
    const isStoryItem =
      pk &&
      !node.code &&
      !node.shortcode &&
      (node.expiring_at || node.story_cta || node.reel_type) &&
      (node.video_versions || node.image_versions2);

    if (isStoryItem) {
      const isVid = Boolean(node.media_type === 2 || (node.video_versions && node.video_versions.length > 0));
      const media = extractBestMediaUrl(node, isVid);
      if (media) {
        const sUser = (node.user?.username || node.owner?.username || "story").toLowerCase();
        storyItemsByKey.set(pk, {
          username: sUser,
          uid: `story_${pk}`,
          section: "stories",
          url: media.url,
          baseFilename: `story_${pk}`,
          extHint: media.ext,
          filename: `story_${pk}.${media.ext}`
        });
      }
    }

    const shortcode = node.code || node.shortcode;
    if (
      shortcode &&
      (node.media_type !== undefined ||
        node.__typename ||
        node.image_versions2 ||
        node.video_versions ||
        node.carousel_media ||
        node.edge_sidecar_to_children ||
        node.display_url)
    ) {
      const existing = mediaCacheByShortcode.get(shortcode);
      const hasNewSlides =
        Array.isArray(node.carousel_media) ||
        Boolean(node.edge_sidecar_to_children?.edges?.length);
      if (!existing || hasNewSlides) {
        mediaCacheByShortcode.set(shortcode, node);
      }
    }

    for (const k of Object.keys(node)) {
      walk(node[k]);
    }
  }

  walk(rootObj);
}

// =========================================================
// 6. PAYLOAD PARSER & ZERO-DUPLICATION FILTER BETWEEN POSTS & REELS
// =========================================================
async function parseInstagramPayload(
  rootObj,
  targetUserLower,
  isFromTrustedProfileFeed = false,
  sectionContext = "posts"
) {
  const discoveredBatch = [];
  const visited = new WeakSet();

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    if (node.reels_media || node.tray || node.story_ranking_token) {
      return;
    }

    if (node.media && typeof node.media === "object" && (node.media.code || node.media.pk || node.media.shortcode)) {
      walk(node.media);
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
      if (isOwnedOrCollabWithTarget(node, targetUserLower, isFromTrustedProfileFeed)) {
        extractSlidesFromMediaNode(
          node,
          targetUserLower,
          sectionContext,
          discoveredBatch,
          false
        );
      }
      return;
    }

    for (const k of Object.keys(node)) {
      if (k === "reels_media" || k === "stories") continue;
      walk(node[k]);
    }
  }

  walk(rootObj);

  if (discoveredBatch.length > 0) {
    const prepared = await prepareItemsForFormat(discoveredBatch);
    await safeSendMessage({
      action: "DOWNLOAD_ITEMS",
      items: prepared
    });
  }
  updateHUDCounters();
}

function isOwnedOrCollabWithTarget(item, targetUserLower, isFromTrustedProfileFeed) {
  if (item.repost_info || item.original_media_id) return false;
  if (isFromTrustedProfileFeed) return true;

  const ownerUsername = (item.user?.username || item.owner?.username || "").toLowerCase();
  const ownerPk = cleanPk(item.user?.pk || item.user?.id || item.owner?.id || item.owner?.pk);

  if (ownerUsername === targetUserLower) {
    if (ownerPk && !activeTargetUserId) activeTargetUserId = ownerPk;
    return true;
  }

  if (activeTargetUserId && ownerPk && ownerPk === activeTargetUserId) {
    return true;
  }

  const coauthors = [
    ...(Array.isArray(item.coauthor_producers) ? item.coauthor_producers : []),
    ...(Array.isArray(item.invited_coauthor_producers) ? item.invited_coauthor_producers : []),
    ...(Array.isArray(item.edge_media_to_tagged_user?.edges)
      ? item.edge_media_to_tagged_user.edges.map((e) => e?.node?.user).filter(Boolean)
      : [])
  ];

  for (const ca of coauthors) {
    const caUser = (ca?.username || "").toLowerCase();
    const caPk = cleanPk(ca?.pk || ca?.id);
    if (caUser === targetUserLower || (activeTargetUserId && caPk === activeTargetUserId)) {
      return true;
    }
  }

  if (!ownerUsername && !ownerPk) return true;
  return false;
}

function extractSlidesFromMediaNode(
  item,
  folderUsername,
  sectionContext,
  discoveredOut,
  bypassDedupForManualClick = false
) {
  const shortcode = String(item.code || item.shortcode).trim();
  const parentPk = cleanPk(item.pk || item.id);

  // Track under Section 1 (Grid Posts) or Section 2 (Reels)
  if (sectionContext === "reels") {
    if (!gridPostShortcodes.has(shortcode)) {
      reelsTabShortcodes.add(shortcode);
    }
  } else {
    gridPostShortcodes.add(shortcode);
  }

  const isCarousel =
    item.media_type === 8 ||
    item.__typename === "GraphSidecar" ||
    item.__typename === "XDTGraphSidecar" ||
    Array.isArray(item.carousel_media) ||
    Boolean(item.edge_sidecar_to_children) ||
    (item.carousel_media_count && item.carousel_media_count > 1);

  if (isCarousel) {
    const slides =
      item.carousel_media ||
      (item.edge_sidecar_to_children?.edges || []).map((e) => e?.node).filter(Boolean) ||
      [];

    const expectedCount = item.carousel_media_count || slides.length;

    if (slides.length === 0 || (expectedCount > 1 && slides.length < expectedCount)) {
      if (parentPk && !resolvedDeepPks.has(parentPk)) {
        pendingDeepResolvePks.add(parentPk);
      } else {
        pendingShortcodeResolves.add(shortcode);
      }
      return;
    }

    slides.forEach((slide, index) => {
      const slideNum = index + 1;
      const slideKey = `${shortcode}_slide_${slideNum}`;
      const slidePk = cleanPk(slide.pk || slide.id) || `${parentPk}_s${slideNum}`;

      const slideIsVideo =
        slide.media_type === 2 ||
        slide.is_video === true ||
        slide.__typename === "GraphVideo" ||
        slide.__typename === "XDTGraphVideo" ||
        (Array.isArray(slide.video_versions) && slide.video_versions.length > 0);

      const extracted = extractBestMediaUrl(slide, slideIsVideo);
      if (!extracted) {
        if (parentPk && !resolvedDeepPks.has(parentPk)) {
          pendingDeepResolvePks.add(parentPk);
        }
        return;
      }

      const assetId = getNormalizedAssetId(extracted.url);

      if (
        !bypassDedupForManualClick &&
        (seenMediaPksGlobal.has(slidePk) ||
          seenSlideKeysGlobal.has(slideKey) ||
          seenAssetIdsGlobal.has(assetId))
      ) {
        return;
      }

      seenMediaPksGlobal.add(slidePk);
      seenSlideKeysGlobal.add(slideKey);
      seenAssetIdsGlobal.add(assetId);

      discoveredOut.push({
        username: folderUsername,
        uid: slideKey,
        section: sectionContext,
        url: extracted.url,
        baseFilename: `${shortcode}_${slideNum}`,
        extHint: extracted.ext,
        filename: `${shortcode}_${slideNum}.${extracted.ext}`
      });
    });

    seenShortcodesGlobal.add(shortcode);
    return;
  }

  // SINGLE PHOTO, VIDEO, OR REEL (Strict Deduplication Between Grid Posts & Reels Tab)
  const singleSlideKey = `${shortcode}_slide_1`;
  const singlePk = parentPk || shortcode;

  const isVideoItem =
    item.media_type === 2 ||
    item.is_video === true ||
    item.product_type === "clips" ||
    item.product_type === "igtv" ||
    item.__typename === "GraphVideo" ||
    item.__typename === "XDTGraphVideo" ||
    (Array.isArray(item.video_versions) && item.video_versions.length > 0);

  const extracted = extractBestMediaUrl(item, isVideoItem);
  if (!extracted) {
    if (parentPk && !resolvedDeepPks.has(parentPk)) {
      pendingDeepResolvePks.add(parentPk);
    } else if (!resolvedDeepPks.has(shortcode)) {
      resolvedDeepPks.add(shortcode);
      pendingShortcodeResolves.add(shortcode);
    }
    return;
  }

  const assetId = getNormalizedAssetId(extracted.url);

  // If this Reel/Post was already picked up in Section 1 (Grid Posts), skip it in Section 2 (Reels Tab)!
  if (
    !bypassDedupForManualClick &&
    (seenShortcodesGlobal.has(shortcode) ||
      seenMediaPksGlobal.has(singlePk) ||
      seenSlideKeysGlobal.has(singleSlideKey) ||
      seenAssetIdsGlobal.has(assetId))
  ) {
    return;
  }

  seenShortcodesGlobal.add(shortcode);
  seenMediaPksGlobal.add(singlePk);
  seenSlideKeysGlobal.add(singleSlideKey);
  seenAssetIdsGlobal.add(assetId);

  discoveredOut.push({
    username: folderUsername,
    uid: singleSlideKey,
    section: sectionContext,
    url: extracted.url,
    baseFilename: shortcode,
    extHint: extracted.ext,
    filename: `${shortcode}.${extracted.ext}`
  });
}

function extractBestMediaUrl(node, mustBeVideo) {
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
    if (sorted[0]?.url) {
      return {
        url: sorted[0].url,
        ext: detectExtensionHintFromUrl(sorted[0].url, false)
      };
    }
  }
  if (Array.isArray(node.display_resources) && node.display_resources.length > 0) {
    const last = node.display_resources[node.display_resources.length - 1];
    if (last?.src) {
      return {
        url: last.src,
        ext: detectExtensionHintFromUrl(last.src, false)
      };
    }
  }
  if (node.display_url) {
    return {
      url: node.display_url,
      ext: detectExtensionHintFromUrl(node.display_url, false)
    };
  }

  return null;
}

function resetButton() {
  const btn = document.getElementById("instaswift-download-btn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "⚡ Download All (Posts + Reels)";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}