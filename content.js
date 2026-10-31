let isScanning = false;

const storyItemsByPk = new Map();
const storyTraysByUser = new Map();
const mediaCacheByShortcode = new Map();

const pendingRpcMap = new Map();
let rpcCounter = 0;

const RESERVED_PATHS = new Set([
  "explore", "reels", "direct", "accounts", "p", "reel", "stories", "tv", "challenge"
]);

function safeSendMessage(payload) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.id) {
        updateHUDStatus("⚠️ Extension updated! Press F5 to refresh this Instagram page.");
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

function callMainWorld(cmd, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const reqId = ++rpcCounter;
    let handled = false;

    const finish = (val) => {
      if (handled) return;
      handled = true;
      pendingRpcMap.delete(reqId);
      resolve(val);
    };

    setTimeout(() => {
      if (!handled) finish({ ok: false, status: 408, data: null });
    }, timeoutMs);

    pendingRpcMap.set(reqId, (result) => finish(result));
    window.postMessage({ source: "INSTASWIFT_CONTENT", cmd, reqId, payload }, "*");
  });
}

function getUsernameFromUrl() {
  const cleanPath = window.location.pathname.split("?")[0];
  const parts = cleanPath.split("/").filter(Boolean);
  if (parts.length >= 1 && !RESERVED_PATHS.has(parts[0].toLowerCase())) {
    return parts[0];
  }
  return null;
}

function getActiveSinglePostFromUrl() {
  const m = window.location.pathname.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  return {
    type: m[1] === "p" ? "post" : "reel",
    isReel: m[1] !== "p",
    shortcode: m[2]
  };
}

function cleanPk(raw) {
  if (!raw) return "";
  return String(raw).split("_")[0].trim();
}

function findUserIdInDOM(usernameLower) {
  const html = document.documentElement.innerHTML;
  const escaped = usernameLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes = [
    new RegExp(`"id":"(\\d+)"[^}]{0,250}"username":"${escaped}"`, "i"),
    new RegExp(`"username":"${escaped}"[^}]{0,250}"id":"(\\d+)"`, "i"),
    new RegExp(`"pk":"(\\d+)"[^}]{0,250}"username":"${escaped}"`, "i"),
    /"profilePage_(\d+)"/i
  ];
  for (const rx of regexes) {
    const m = html.match(rx);
    if (m && m[1]) return m[1];
  }
  return "";
}

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.data?.source !== "INSTASWIFT_MAIN") return;
  const { type } = event.data;

  if (type === "CMD_RESPONSE") {
    const cb = pendingRpcMap.get(event.data.reqId);
    if (cb) cb(event.data.result);
  }
  else if (type === "INTERCEPTED_JSON") {
    if (event.data.payload) {
      indexPassiveMediaAndStories(event.data.payload);
    }
  }
  else if (type === "MAIN_SCAN_PROGRESS") {
    const { status, gridCount, reelsCount, dupsCount } = event.data;
    updateRoomHUDCounters(gridCount, reelsCount, dupsCount);
    if (status) updateHUDStatus(status);
    safeSendMessage({
      action: "UPDATE_ROOM_COUNTS",
      gridCount,
      reelsCount,
      dupsCount,
      status
    });
  }
  else if (type === "MAIN_SCAN_COMPLETE") {
    const { username, gridCount, reelsCount, dupsCount, items } = event.data;
    updateRoomHUDCounters(gridCount, reelsCount, dupsCount);

    await safeSendMessage({
      action: "UPDATE_ROOM_COUNTS",
      gridCount,
      reelsCount,
      dupsCount
    });

    if (!items || items.length === 0) {
      isScanning = false;
      resetButton();
      await safeSendMessage({ action: "SCAN_FINISHED" });
      updateHUDStatus("⚠️ No media found to download.");
      return;
    }

    const btn = document.getElementById("instaswift-download-btn");
    if (btn) btn.textContent = "🚀 Downloading Unique...";
    updateHUDStatus(
      `Deduplication Complete! Grid (G): ${gridCount} | Unique Reels (R\\G): ${reelsCount} | Dups Blocked (G∩R): ${dupsCount}. Downloading ${items.length} unique files...`
    );

    const PACKET_SIZE = 250;
    for (let i = 0; i < items.length; i += PACKET_SIZE) {
      const packet = items.slice(i, i + PACKET_SIZE);
      await safeSendMessage({
        action: "QUEUE_MEDIA",
        items: packet
      });
    }

    isScanning = false;
    resetButton();
    await safeSendMessage({ action: "SCAN_FINISHED" });
  }
});

function runAllUiInjectors() {
  injectProfileButton();
  injectSingleVideoModalAndPageButton();
  injectReelsFeedActionButtons();
  injectGridPostDownloadButtons();
  injectManualStoryButtons();
}

runAllUiInjectors();
setInterval(runAllUiInjectors, 900);
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
    const currentUsername = getUsernameFromUrl();
    if (currentUsername) startProfileDownload(currentUsername);
  });

  actionSection.appendChild(btn);
}

async function startProfileDownload(username) {
  if (isScanning) return;

  if (
    document.body.innerText.includes("This account is private") ||
    document.body.innerText.includes("This Account is Private")
  ) {
    createOrShowHUD(username);
    updateHUDStatus("🔒 Private profile: Account must be public to download.");
    return;
  }

  isScanning = true;
  createOrShowHUD(username);
  updateHUDStatus("Initializing 4-Engine 3-Room Scanner (REST + Cloned GraphQL + Auto-Scroll)...");

  const btn = document.getElementById("instaswift-download-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Scanning...";
  }

  const initRes = await safeSendMessage({
    action: "INIT_SESSION",
    username: username.toLowerCase()
  });
  if (!initRes) {
    isScanning = false;
    resetButton();
    updateHUDStatus("⚠️ Extension updated! Press F5 to refresh this tab.");
    return;
  }

  window.postMessage(
    {
      source: "INSTASWIFT_CONTENT",
      cmd: "START_MAIN_WORLD_3ROOM_SCAN",
      payload: { username: username.toLowerCase() }
    },
    "*"
  );
}

function injectSingleVideoModalAndPageButton() {
  const singleRoute = getActiveSinglePostFromUrl();
  if (!singleRoute) return;

  const containers = document.querySelectorAll('div[role="dialog"], article, main');
  for (const container of containers) {
    if (container.querySelector(".is-single-modal-btn")) continue;

    const saveIcon = container.querySelector('svg[aria-label="Save"], svg[aria-label="Remove"]');
    const likeIcon = container.querySelector('svg[aria-label="Like"], svg[aria-label="Unlike"]');
    const anchorIcon = saveIcon || likeIcon;
    if (!anchorIcon) continue;

    const actionBar = anchorIcon.closest("section") || anchorIcon.parentElement?.parentElement?.parentElement;
    if (!actionBar || actionBar.querySelector(".is-single-modal-btn")) continue;

    const btn = document.createElement("button");
    btn.className = "is-single-modal-btn";
    btn.innerHTML = singleRoute.isReel ? "⚡ Download Video / Reel" : "⚡ Download Post / Video";
    btn.title = "Download this particular video, reel, or multi-slide post in highest quality";

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const activeRoute = getActiveSinglePostFromUrl() || singleRoute;
      await downloadParticularSingleMedia(activeRoute.shortcode, activeRoute.isReel, btn, container);
    });

    actionBar.appendChild(btn);
  }
}

function injectReelsFeedActionButtons() {
  if (!window.location.pathname.startsWith("/reels/") && !window.location.pathname.startsWith("/reel/")) {
    const existing = document.getElementById("instaswift-single-reel-bar");
    if (existing) existing.remove();
    return;
  }

  const singleRoute = getActiveSinglePostFromUrl();
  if (!singleRoute) return;

  let reelBar = document.getElementById("instaswift-single-reel-bar");
  if (!reelBar) {
    reelBar = document.createElement("div");
    reelBar.id = "instaswift-single-reel-bar";
    reelBar.innerHTML = `
      <button id="is-dl-particular-reel" class="is-particular-reel-btn">🎬 Download This Video</button>
    `;
    document.body.appendChild(reelBar);

    document.getElementById("is-dl-particular-reel").addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = document.getElementById("is-dl-particular-reel");
      const curr = getActiveSinglePostFromUrl();
      if (curr) {
        await downloadParticularSingleMedia(curr.shortcode, true, btn, document.body);
      }
    });
  }
}

function injectGridPostDownloadButtons() {
  const anchors = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
  for (const a of anchors) {
    if (a.dataset.instaswiftBound === "1") continue;
    const match = (a.getAttribute("href") || "").match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (!match) continue;
    if (!a.querySelector("img, video")) continue;

    a.dataset.instaswiftBound = "1";
    const isReel = match[1] === "reel";
    const shortcode = match[2];

    if (window.getComputedStyle(a).position === "static") {
      a.style.position = "relative";
    }

    const postBtn = document.createElement("button");
    postBtn.className = "is-grid-post-btn";
    postBtn.title = "Download only this particular video/post";
    postBtn.innerHTML = "⬇ Download";
    postBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await downloadParticularSingleMedia(shortcode, isReel, postBtn, a);
    });

    a.appendChild(postBtn);
  }
}

async function downloadParticularSingleMedia(shortcode, isReel, btnEl, domContainer = null) {
  const origLabel = btnEl ? btnEl.innerHTML : "";
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = "⏳ Fetching...";
  }

  try {
    const ownerFallback = (getUsernameFromUrl() || "instagram_videos").toLowerCase();
    createOrShowHUD(ownerFallback);
    updateHUDStatus(`Fetching HD stream for particular video/post (${shortcode})...`);

    const singleItems = [];

    const cachedNode = mediaCacheByShortcode.get(shortcode);
    if (
      cachedNode &&
      (cachedNode.video_versions?.length ||
        cachedNode.carousel_media?.length ||
        cachedNode.edge_sidecar_to_children?.edges?.length)
    ) {
      extractSinglePostSlides(cachedNode, ownerFallback, singleItems);
    }

    if (singleItems.length === 0) {
      const res = await callMainWorld("FETCH_FULL_POST_BY_SHORTCODE", { shortcode, isReel }, 8000);
      if (res?.ok && res.data) {
        indexPassiveMediaAndStories(res.data, ownerFallback);
        extractSinglePostSlides(res.data, ownerFallback, singleItems);
      }
    }

    if (singleItems.length === 0 && domContainer) {
      const vEl = domContainer.querySelector("video");
      if (vEl && (vEl.currentSrc || vEl.src) && !(vEl.currentSrc || vEl.src).startsWith("blob:")) {
        singleItems.push({
          username: ownerFallback,
          shortcode,
          url: vEl.currentSrc || vEl.src,
          filename: `${shortcode}.mp4`
        });
      } else {
        const imgEl = domContainer.querySelector("img");
        if (imgEl && imgEl.src && imgEl.src.startsWith("http")) {
          singleItems.push({
            username: ownerFallback,
            shortcode,
            url: imgEl.src,
            filename: `${shortcode}.jpg`
          });
        }
      }
    }

    if (singleItems.length === 0) {
      updateHUDStatus(`⚠️ Could not extract direct stream for ${shortcode}. Try refreshing (F5).`);
      if (btnEl) btnEl.innerHTML = "⚠️ Retry";
      return;
    }

    const targetFolderUser = singleItems[0].username || ownerFallback;
    await safeSendMessage({
      action: "QUEUE_SINGLE_MEDIA",
      items: singleItems
    });

    updateHUDStatus(
      `✅ Downloading ${singleItems.length} file(s) from ${shortcode} to Instagram/${targetFolderUser}/!`
    );
    if (btnEl) btnEl.innerHTML = `✓ Saved (${singleItems.length})`;
  } catch (err) {
    updateHUDStatus(`Error downloading ${shortcode}: ${err.message}`);
    if (btnEl) btnEl.innerHTML = "⚠️ Error";
  } finally {
    setTimeout(() => {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = origLabel;
      }
    }, 2200);
  }
}

function extractSinglePostSlides(rootObj, fallbackUser, outList) {
  const visited = new WeakSet();
  const addedKeys = new Set();

  function walk(node) {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const shortcode = node.code || node.shortcode;
    if (
      shortcode &&
      (node.image_versions2 ||
        node.video_versions ||
        node.carousel_media ||
        node.edge_sidecar_to_children ||
        node.display_url ||
        node.video_url)
    ) {
      const author = (node.user?.username || node.owner?.username || fallbackUser).toLowerCase();
      const slides =
        node.carousel_media ||
        (node.edge_sidecar_to_children?.edges || []).map((e) => e?.node).filter(Boolean);

      if (Array.isArray(slides) && slides.length > 0) {
        slides.forEach((sl, idx) => {
          const isVid =
            sl.media_type === 2 ||
            sl.is_video === true ||
            sl.__typename === "GraphVideo" ||
            sl.__typename === "XDTGraphVideo" ||
            Boolean(sl.video_versions?.length);
          const ext = extractStrictMediaUrl(sl, isVid);
          const itemCode = `${shortcode}_${idx + 1}`;
          if (ext && !addedKeys.has(itemCode)) {
            addedKeys.add(itemCode);
            outList.push({
              username: author,
              shortcode: itemCode,
              url: ext.url,
              filename: `${itemCode}.${ext.ext}`
            });
          }
        });
      } else {
        const isVid =
          node.media_type === 2 ||
          node.is_video === true ||
          node.product_type === "clips" ||
          node.__typename === "GraphVideo" ||
          node.__typename === "XDTGraphVideo" ||
          Boolean(node.video_versions?.length);
        const ext = extractStrictMediaUrl(node, isVid);
        if (ext && !addedKeys.has(shortcode)) {
          addedKeys.add(shortcode);
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
  updateHUDStatus("Resolving HD Story Video/Photo...");

  if (!downloadAllInReel && !isHighlight && urlStoryOrHighlightId && /^\d+$/.test(urlStoryOrHighlightId)) {
    if (!storyItemsByPk.has(urlStoryOrHighlightId)) {
      const mediaRes = await callMainWorld("FETCH_MEDIA_INFO", { mediaPk: urlStoryOrHighlightId }, 7500);
      if (mediaRes?.ok && mediaRes.data) {
        indexPassiveMediaAndStories(mediaRes.data, targetSlug);
      }
    }
  }

  if (isHighlight && urlStoryOrHighlightId) {
    const res = await callMainWorld("FETCH_STORIES_REEL", { reelId: `highlight:${urlStoryOrHighlightId}` }, 7500);
    if (res?.ok && res.data) indexPassiveMediaAndStories(res.data, targetSlug);
  } else if (!isHighlight && targetSlug) {
    let uid = findUserIdInDOM(targetSlug);
    if (!uid) {
      const profRes = await callMainWorld("FETCH_WEB_PROFILE_INFO", { username: targetSlug }, 6500);
      const u = profRes?.data?.data?.user || profRes?.data?.graphql?.user || profRes?.data?.user;
      if (u) uid = cleanPk(u.id || u.pk);
    }
    if (uid) {
      const sRes = await callMainWorld("FETCH_STORIES_REEL", { reelId: uid }, 7500);
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
    action: "QUEUE_SINGLE_MEDIA",
    items: batch
  });
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
      const existing = mediaCacheByShortcode.get(shortcode);
      const hasRichMedia =
        Boolean(node.video_versions?.length) ||
        Boolean(node.carousel_media?.length) ||
        Boolean(node.edge_sidecar_to_children?.edges?.length);
      if (!existing || hasRichMedia) {
        mediaCacheByShortcode.set(shortcode, node);
      }
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

function createOrShowHUD(username) {
  let hud = document.getElementById("instaswift-hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "instaswift-hud";
    hud.innerHTML = `
      <div class="is-hud-header">
        <span class="is-hud-title">⚡ InstaSwift v38 Room — <strong id="is-hud-user">@${username}</strong></span>
        <button id="is-hud-close" title="Close">✕</button>
      </div>
      <div class="is-hud-status" id="is-hud-status">Initializing 4-Engine 3-Room Scanner...</div>
      <div class="is-hud-grid-3">
        <div class="is-stat-box is-room-grid">
          <span class="is-stat-val" id="is-stat-posts">0</span>
          <span class="is-stat-lbl">Room 1: Grid (G)</span>
        </div>
        <div class="is-stat-box is-room-reels">
          <span class="is-stat-val" id="is-stat-reels">0</span>
          <span class="is-stat-lbl">Room 2: Reels (R\\G)</span>
        </div>
        <div class="is-stat-box is-room-dups">
          <span class="is-stat-val" id="is-stat-dups">0</span>
          <span class="is-stat-lbl">Room 3: Dups (G∩R)</span>
        </div>
      </div>
      <div class="is-disk-line" id="is-disk-line">Cloned GraphQL + Auto-Scroll + Observer Hook Active</div>
      <button id="is-hud-stop" class="is-stop-btn">Stop</button>
    `;
    document.body.appendChild(hud);

    document.getElementById("is-hud-close").addEventListener("click", () => {
      hud.style.display = "none";
    });

    document.getElementById("is-hud-stop").addEventListener("click", async () => {
      isScanning = false;
      window.postMessage({ source: "INSTASWIFT_CONTENT", cmd: "STOP_MAIN_WORLD_SCAN" }, "*");
      await safeSendMessage({ action: "USER_EXPLICIT_STOP" });
      updateHUDStatus("Stopped manually by user.");
      resetButton();
    });
  } else {
    hud.style.display = "block";
    document.getElementById("is-hud-user").textContent = `@${username}`;
  }
}

function updateRoomHUDCounters(gridCount, reelsCount, dupsCount) {
  const pEl = document.getElementById("is-stat-posts");
  const rEl = document.getElementById("is-stat-reels");
  const dEl = document.getElementById("is-stat-dups");

  if (pEl && gridCount !== undefined) pEl.textContent = gridCount;
  if (rEl && reelsCount !== undefined) rEl.textContent = reelsCount;
  if (dEl && dupsCount !== undefined) dEl.textContent = dupsCount;
}

function updateHUDStatus(text) {
  const el = document.getElementById("is-hud-status");
  if (el) el.textContent = text;
}

try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "STATS_UPDATE" && msg.stats) {
      updateRoomHUDCounters(msg.stats.gridCount, msg.stats.reelsCount, msg.stats.dupsCount);
      const diskEl = document.getElementById("is-disk-line");
      const st = document.getElementById("is-hud-status");
      if (diskEl && msg.stats.scanned > 0) {
        const vel = msg.stats.velocityFps ? `${msg.stats.velocityFps} files/s` : "Max Speed";
        const accel = msg.stats.accelerationFps2 ? ` (a=${msg.stats.accelerationFps2}/s²)` : "";
        diskEl.textContent = `Saved: ${msg.stats.downloaded}/${msg.stats.scanned} • v=${vel}${accel} • W=${msg.stats.concurrency || 8}x`;
      }
      if (st && !isScanning && msg.stats.status) {
        st.textContent = msg.stats.status;
      }
    } else if (msg.action === "TRIGGER_FROM_POPUP") {
      const username = getUsernameFromUrl();
      if (username) startProfileDownload(username);
    } else if (msg.action === "TRIGGER_SINGLE_FROM_POPUP") {
      const singleRoute = getActiveSinglePostFromUrl();
      if (singleRoute) {
        downloadParticularSingleMedia(singleRoute.shortcode, singleRoute.isReel, null, document.body);
        sendResponse({ ok: true, shortcode: singleRoute.shortcode });
      } else {
        sendResponse({ ok: false });
      }
      return false;
    }
  });
} catch (_) {}

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