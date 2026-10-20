const IG_APP_ID = "936619743392459";

const POSTS_DOC_IDS = [
  "9310670392322965",
  "8756293921102652",
  "7950326061742207",
  "7663233860430175"
];

const REELS_DOC_IDS = [
  "7898261790222653",
  "8424592380963564",
  "7191572580905213"
];

const CLASSIC_POSTS_QUERY_HASH = "69cba40317214236af40e7efa697781d";
const FALLBACK_POSTS_QUERY_HASH = "e769aa130647d2354c40ea6a439bfc08";

let downloadQueue = [];
let activeDownloads = 0;
const MAX_CONCURRENT_DOWNLOADS = 4;

let stopRequested = false;
let isJobRunning = false;
let forcedImageFormat = "auto";
let activeIgTabId = null;

const gridPostShortcodes = new Set();
const uniqueReelShortcodes = new Set();
const seenShortcodesGlobal = new Set();
const seenMediaPksGlobal = new Set();
const seenSlideKeysGlobal = new Set();
const seenAssetIdsGlobal = new Set();
const pendingCarouselPks = new Set();
const resolvedCarouselPks = new Set();
const discoveredDomShortcodes = new Map();

let latestCapturedPostsCursor = null;
let latestCapturedReelsCursor = null;

const downloadMap = new Map();

let jobContext = {
  username: "",
  userId: "",
  csrfToken: "",
  lsdToken: "",
  wwwClaim: "0",
  postsDocId: "9310670392322965",
  reelsDocId: "7898261790222653",
  postsReqTemplate: "",
  reelsReqTemplate: ""
};

let stats = {
  username: "",
  status: "Idle",
  isRunning: false,
  expectedPosts: 0,
  gridPostsMatched: 0,
  uniqueReelsMatched: 0,
  gridPostsFiles: 0,
  reelsOnlyFiles: 0,
  duplicatesSkipped: 0,
  totalQueued: 0,
  savedToDisk: 0,
  failedDownloads: 0
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "instaswift_offscreen_port") {
    port.onMessage.addListener((msg) => {
      if (msg.type === "HEARTBEAT") {
        reconcileDownloads();
        if (downloadQueue.length > 0 && activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
          processQueue();
        }
      }
    });
  }
});

async function protectInstagramTabFromDiscard(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch (_) {}
}

async function ensureOffscreenKeepAlive() {
  try {
    if (chrome.offscreen) {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (!hasDoc) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["AUDIO_PLAYBACK", "BLOBS"],
          justification: "Keep background scanner and downloader running."
        });
      }
    }
  } catch (_) {
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Keep background downloader awake."
      });
    } catch (__) {}
  }
  try {
    chrome.alarms.create("instaswift_bg_watchdog", { periodInMinutes: 0.25 });
  } catch (_) {}
}

async function closeOffscreenKeepAlive() {
  try {
    chrome.alarms.clear("instaswift_bg_watchdog");
    if (chrome.offscreen) {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (hasDoc) await chrome.offscreen.closeDocument();
    }
  } catch (_) {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "instaswift_bg_watchdog") {
    reconcileDownloads();
    processQueue();
    broadcastStats();
  }
});

// FIXED: Never cancels active downloads! Only checks if any finished/interrupted events were missed.
function reconcileDownloads() {
  for (const [dlId, entry] of downloadMap.entries()) {
    chrome.downloads.search({ id: dlId }, (results) => {
      if (chrome.runtime.lastError || !results || results.length === 0) return;
      const dl = results[0];
      if (dl.state === "complete") {
        if (downloadMap.has(dlId)) {
          downloadMap.delete(dlId);
          activeDownloads = Math.max(0, downloadMap.size);
          stats.savedToDisk++;
          updateStatusText();
          broadcastStats();
          processQueue();
        }
      } else if (dl.state === "interrupted") {
        if (downloadMap.has(dlId)) {
          downloadMap.delete(dlId);
          handleFailure(entry.item);
        }
      }
    });
  }
  activeDownloads = downloadMap.size;
}

function bgSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanPk(raw) {
  if (!raw) return "";
  return String(raw).split("_")[0].trim();
}

function shortcodeToMediaPk(shortcode) {
  try {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = BigInt(0);
    const cleanCode = String(shortcode).split("/")[0].trim();
    for (let i = 0; i < Math.min(cleanCode.length, 11); i++) {
      const idx = alphabet.indexOf(cleanCode[i]);
      if (idx === -1) break;
      id = id * BigInt(64) + BigInt(idx);
    }
    return id > 0n ? id.toString() : "";
  } catch (_) {
    return "";
  }
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
  if (forcedImageFormat === "png") return "png";
  if (forcedImageFormat === "jpg") return "jpg";
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return "png";
    if (pathname.endsWith(".webp")) return "webp";
  } catch (_) {}
  return "jpg";
}

async function getCsrfFromCookies() {
  try {
    const cookie = await chrome.cookies.get({
      url: "https://www.instagram.com",
      name: "csrftoken"
    });
    return cookie?.value || jobContext.csrfToken || "";
  } catch (_) {
    return jobContext.csrfToken || "";
  }
}

async function findActiveInstagramTabId() {
  if (activeIgTabId) {
    try {
      const tab = await chrome.tabs.get(activeIgTabId);
      if (tab && tab.url && tab.url.includes("instagram.com")) {
        return activeIgTabId;
      }
    } catch (_) {
      activeIgTabId = null;
    }
  }
  try {
    const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
    if (tabs && tabs.length > 0) {
      activeIgTabId = tabs[0].id;
      await protectInstagramTabFromDiscard(activeIgTabId);
      return activeIgTabId;
    }
  } catch (_) {}
  return null;
}

function syncMetaFromTab(meta) {
  if (!meta) return;
  if (meta.postsDocId) jobContext.postsDocId = meta.postsDocId;
  if (meta.reelsDocId) jobContext.reelsDocId = meta.reelsDocId;
  if (meta.lsdToken) jobContext.lsdToken = meta.lsdToken;
  if (meta.wwwClaim && meta.wwwClaim !== "0") jobContext.wwwClaim = meta.wwwClaim;
  if (meta.postsReqTemplate) jobContext.postsReqTemplate = meta.postsReqTemplate;
  if (meta.reelsReqTemplate) jobContext.reelsReqTemplate = meta.reelsReqTemplate;
}

async function bgIgJsonFetch(url, options = {}) {
  const tabId = await findActiveInstagramTabId();
  if (tabId) {
    try {
      const tabRes = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 9000);
        chrome.tabs.sendMessage(
          tabId,
          { action: "EXEC_MAIN_WORLD_FETCH", url, options, timeoutMs: 8500 },
          (resp) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError || !resp) {
              resolve(null);
            } else {
              if (resp.meta) syncMetaFromTab(resp.meta);
              resolve(resp);
            }
          }
        );
      });
      if (tabRes && (tabRes.ok || tabRes.status === 429 || tabRes.status === 404)) {
        return tabRes;
      }
    } catch (_) {}
  }

  try {
    const csrf = await getCsrfFromCookies();
    const headers = {
      "x-ig-app-id": IG_APP_ID,
      "x-csrftoken": csrf,
      "x-requested-with": "XMLHttpRequest",
      "x-asbd-id": "129477",
      "x-ig-www-claim": jobContext.wwwClaim || "0",
      "accept": "*/*",
      ...(options.headers || {})
    };
    if (jobContext.lsdToken) {
      headers["x-fb-lsd"] = jobContext.lsdToken;
    }

    const res = await fetch(url, {
      ...options,
      headers,
      credentials: "include"
    });

    if (!res.ok) return { ok: false, status: res.status, data: null };
    const txt = (await res.text()).trim();
    if (!txt.startsWith("{") && !txt.startsWith("[")) {
      return { ok: false, status: res.status, data: null };
    }
    return { ok: true, status: res.status, data: JSON.parse(txt) };
  } catch (_) {
    return { ok: false, status: 0, data: null };
  }
}

async function triggerTabScrollAssist(tabType) {
  const tabId = await findActiveInstagramTabId();
  if (!tabId) return null;
  try {
    return await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 2000);
      chrome.tabs.sendMessage(
        tabId,
        { action: "EXEC_SWITCH_TAB_AND_SCROLL", tabType, username: jobContext.username },
        (res) => {
          clearTimeout(t);
          if (res?.meta) syncMetaFromTab(res.meta);
          if (Array.isArray(res?.domShortcodes)) {
            for (const item of res.domShortcodes) {
              if (item?.shortcode) {
                discoveredDomShortcodes.set(item.shortcode, Boolean(item.isReel));
              }
            }
          }
          resolve(res);
        }
      );
    });
  } catch (_) {
    return null;
  }
}

function buildGraphqlBody(templateStr, fallbackDocId, friendlyName, variablesObj) {
  const params = new URLSearchParams(templateStr || "");
  if (jobContext.lsdToken && !params.get("lsd")) {
    params.set("lsd", jobContext.lsdToken);
  }
  params.set("fb_api_req_friendly_name", friendlyName);
  params.set("variables", JSON.stringify(variablesObj));
  params.set("server_timestamps", "true");
  params.set("doc_id", fallbackDocId);
  return params.toString();
}

async function runAutonomousProfileScan(initPayloads, initialDomCodes) {
  isJobRunning = true;
  stopRequested = false;
  stats.isRunning = true;
  latestCapturedPostsCursor = null;
  latestCapturedReelsCursor = null;
  await ensureOffscreenKeepAlive();

  try {
    if (Array.isArray(initialDomCodes)) {
      for (const item of initialDomCodes) {
        if (item?.shortcode) discoveredDomShortcodes.set(item.shortcode, Boolean(item.isReel));
      }
    }

    for (const item of initPayloads || []) {
      if (stopRequested) break;
      const pUrl = (item?.url || "").toLowerCase();
      const rawPayload = item?.payload || item;
      const isClipsPayload =
        pUrl.includes("clips") ||
        pUrl.includes("/reels") ||
        Boolean(rawPayload?.data?.xdt_api__v1__clips__user__connection_v2);
      parseAndQueuePayload(rawPayload, jobContext.username, true, isClipsPayload ? "reels" : "posts");
    }

    if (!stopRequested) {
      stats.status = "Background Scanner: Locking target User ID & total posts...";
      broadcastStats();
      const profRes = await bgIgJsonFetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(jobContext.username)}`
      );
      if (profRes.ok && profRes.data) {
        const u = profRes.data?.data?.user || profRes.data?.graphql?.user || profRes.data?.user;
        if (u) {
          if (u.id || u.pk) jobContext.userId = cleanPk(u.id || u.pk);
          const count = u.edge_owner_to_timeline_media?.count ?? u.media_count ?? 0;
          if (count > stats.expectedPosts) stats.expectedPosts = count;
        }
        parseAndQueuePayload(profRes.data, jobContext.username, true, "posts");
      }
    }

    if (!stopRequested) {
      await bgScanAllGridPosts();
    }

    if (!stopRequested) {
      await bgScanAllReels();
    }

    if (!stopRequested && discoveredDomShortcodes.size > 0) {
      for (const [sc, isReel] of discoveredDomShortcodes.entries()) {
        if (stopRequested) break;
        if (seenShortcodesGlobal.has(sc)) continue;
        const pk = shortcodeToMediaPk(sc);
        if (pk) {
          const mRes = await bgIgJsonFetch(`https://www.instagram.com/api/v1/media/${encodeURIComponent(pk)}/info/`);
          if (mRes.ok && mRes.data) {
            parseAndQueuePayload(mRes.data, jobContext.username, true, isReel ? "reels" : "posts");
          }
          await bgSleep(300);
        }
      }
    }

    if (!stopRequested && pendingCarouselPks.size > 0) {
      const pks = Array.from(pendingCarouselPks).filter((pk) => !resolvedCarouselPks.has(pk));
      let idx = 0;
      for (const pk of pks) {
        if (stopRequested) break;
        idx++;
        resolvedCarouselPks.add(pk);
        stats.status = `Background Scanner: Expanding Carousel (${idx}/${pks.length})...`;
        broadcastStats();

        const mRes = await bgIgJsonFetch(`https://www.instagram.com/api/v1/media/${encodeURIComponent(pk)}/info/`);
        if (mRes.ok && mRes.data) {
          parseAndQueuePayload(mRes.data, jobContext.username, true, "posts");
        }
        await bgSleep(380);
      }
    }
  } catch (err) {
    console.error("[InstaSwift Autonomous Error]:", err);
  } finally {
    isJobRunning = false;
    stats.isRunning = false;
    updateStatusText();
    broadcastStats();
    processQueue();
  }
}

async function bgScanAllGridPosts() {
  for (const mode of ["byUsername", "byId"]) {
    if (stopRequested) break;
    if (stats.expectedPosts > 0 && gridPostShortcodes.size >= stats.expectedPosts) return;
    if (mode === "byId" && !jobContext.userId) continue;

    let maxId = null;
    let page = 0;
    const visitedRest = new Set();

    while (!stopRequested) {
      if (stats.expectedPosts > 0 && gridPostShortcodes.size >= stats.expectedPosts) return;
      page++;
      stats.status = `Bg Scanning 1. Grid Posts (REST Page ${page}: ${gridPostShortcodes.size}/${stats.expectedPosts || "?"})...`;
      broadcastStats();

      const baseUrl =
        mode === "byUsername"
          ? `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(jobContext.username)}/username/`
          : `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(jobContext.userId)}/`;

      const url = new URL(baseUrl);
      url.searchParams.set("count", "33");
      if (maxId) url.searchParams.set("max_id", maxId);

      let res = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        res = await bgIgJsonFetch(url.toString());
        if (res.ok && res.data) break;
        if (res.status === 429) {
          await bgSleep(4500);
        } else {
          await bgSleep(600);
        }
      }

      if (!res || !res.ok || !res.data) break;

      const data = res.data;
      if (data.user?.pk) {
        jobContext.userId = cleanPk(data.user.pk);
      }

      parseAndQueuePayload(data, jobContext.username, true, "posts");

      const nextCursor = data.next_max_id || data.paging_info?.max_id || null;
      const moreAvailable = Boolean(data.more_available || data.paging_info?.more_available);

      if (moreAvailable && nextCursor && !visitedRest.has(String(nextCursor))) {
        visitedRest.add(String(nextCursor));
        maxId = String(nextCursor);
        await bgSleep(420);
      } else {
        break;
      }
    }
  }

  if (!stopRequested && (stats.expectedPosts === 0 || gridPostShortcodes.size < stats.expectedPosts)) {
    await triggerTabScrollAssist("posts");
    await bgSleep(500);

    const candidateDocIds = Array.from(new Set([jobContext.postsDocId, ...POSTS_DOC_IDS])).filter(Boolean);

    for (const activeDocId of candidateDocIds) {
      if (stopRequested) break;
      if (stats.expectedPosts > 0 && gridPostShortcodes.size >= stats.expectedPosts) return;

      let afterCursor = latestCapturedPostsCursor || null;
      let gqlPage = 0;
      const visitedGql = new Set();

      while (!stopRequested) {
        if (stats.expectedPosts > 0 && gridPostShortcodes.size >= stats.expectedPosts) return;
        gqlPage++;
        stats.status = `Bg Scanning 1. Grid Posts (GraphQL Page ${gqlPage}: ${gridPostShortcodes.size}/${stats.expectedPosts || "?"})...`;
        broadcastStats();

        let variables = {
          data: {
            count: 12,
            include_relationship_info: true,
            latest_besties_reel_media: true,
            latest_reel_media: true
          },
          username: String(jobContext.username),
          __relay_internal__pv__PolarisIsLoggedInrelayprovider: true,
          __relay_internal__pv__PolarisShareSheetV3relayprovider: true
        };

        if (jobContext.postsReqTemplate) {
          try {
            const tplParams = new URLSearchParams(jobContext.postsReqTemplate);
            const tplVars = JSON.parse(tplParams.get("variables") || "{}");
            variables = { ...tplVars, username: String(jobContext.username) };
          } catch (_) {}
        }

        if (afterCursor) {
          variables.after = String(afterCursor);
          variables.first = 12;
          variables.last = null;
          variables.before = null;
        }

        const friendlyName = afterCursor
          ? "PolarisProfilePostsTabContentQuery_connection"
          : "PolarisProfilePostsQuery";

        const bodyStr = buildGraphqlBody(
          jobContext.postsReqTemplate,
          activeDocId,
          friendlyName,
          variables
        );

        const res = await bgIgJsonFetch("https://www.instagram.com/graphql/query", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-fb-friendly-name": friendlyName
          },
          body: bodyStr
        });

        const conn =
          res?.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection ||
          res?.data?.data?.user?.edge_owner_to_timeline_media;
        if (!conn) break;

        parseAndQueuePayload(res.data, jobContext.username, true, "posts");

        const hasNext = Boolean(conn.page_info?.has_next_page);
        const endCursor = conn.page_info?.end_cursor || null;

        if (hasNext && endCursor && !visitedGql.has(String(endCursor))) {
          visitedGql.add(String(endCursor));
          afterCursor = String(endCursor);
          latestCapturedPostsCursor = afterCursor;
          await bgSleep(450);
        } else {
          break;
        }
      }
    }
  }

  if (
    !stopRequested &&
    jobContext.userId &&
    (stats.expectedPosts === 0 || gridPostShortcodes.size < stats.expectedPosts)
  ) {
    for (const qHash of [CLASSIC_POSTS_QUERY_HASH, FALLBACK_POSTS_QUERY_HASH]) {
      if (stopRequested) break;
      if (stats.expectedPosts > 0 && gridPostShortcodes.size >= stats.expectedPosts) return;

      let endCursor = latestCapturedPostsCursor || null;
      let qPage = 0;
      const visitedClassic = new Set();

      while (!stopRequested) {
        if (stats.expectedPosts > 0 && gridPostShortcodes.size >= stats.expectedPosts) return;
        qPage++;
        stats.status = `Bg Scanning 1. Grid Posts (Deep GraphQL Page ${qPage}: ${gridPostShortcodes.size}/${stats.expectedPosts || "?"})...`;
        broadcastStats();

        const vars = {
          id: String(jobContext.userId),
          first: 50
        };
        if (endCursor) vars.after = String(endCursor);

        const qUrl = new URL("https://www.instagram.com/graphql/query/");
        qUrl.searchParams.set("query_hash", qHash);
        qUrl.searchParams.set("variables", JSON.stringify(vars));

        const res = await bgIgJsonFetch(qUrl.toString());
        const mediaConn = res?.data?.data?.user?.edge_owner_to_timeline_media;
        if (!mediaConn) break;

        parseAndQueuePayload(res.data, jobContext.username, true, "posts");

        const hasNext = Boolean(mediaConn.page_info?.has_next_page);
        const nextCur = mediaConn.page_info?.end_cursor || null;

        if (hasNext && nextCur && !visitedClassic.has(String(nextCur))) {
          visitedClassic.add(String(nextCur));
          endCursor = String(nextCur);
          await bgSleep(480);
        } else {
          break;
        }
      }
    }
  }

  if (!stopRequested && stats.expectedPosts > 0 && gridPostShortcodes.size < stats.expectedPosts) {
    let staleRounds = 0;

    while (!stopRequested && gridPostShortcodes.size < stats.expectedPosts && staleRounds < 14) {
      const prevCount = gridPostShortcodes.size;
      stats.status = `Bg Auto-Scrolling Grid (${gridPostShortcodes.size}/${stats.expectedPosts} posts found)...`;
      broadcastStats();

      await triggerTabScrollAssist("posts");
      await bgSleep(750);

      if (jobContext.postsReqTemplate && latestCapturedPostsCursor) {
        let cur = latestCapturedPostsCursor;
        const seen = new Set();
        while (!stopRequested && gridPostShortcodes.size < stats.expectedPosts && cur && !seen.has(cur)) {
          seen.add(cur);
          let vars = {};
          try {
            const p = new URLSearchParams(jobContext.postsReqTemplate);
            vars = JSON.parse(p.get("variables") || "{}");
          } catch (_) {}
          vars.username = String(jobContext.username);
          vars.after = String(cur);
          vars.first = 12;
          vars.last = null;
          vars.before = null;

          const bStr = buildGraphqlBody(
            jobContext.postsReqTemplate,
            jobContext.postsDocId,
            "PolarisProfilePostsTabContentQuery_connection",
            vars
          );
          const gRes = await bgIgJsonFetch("https://www.instagram.com/graphql/query", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-fb-friendly-name": "PolarisProfilePostsTabContentQuery_connection"
            },
            body: bStr
          });
          const conn = gRes?.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
          if (!conn) break;
          parseAndQueuePayload(gRes.data, jobContext.username, true, "posts");
          if (conn.page_info?.has_next_page && conn.page_info?.end_cursor) {
            cur = String(conn.page_info.end_cursor);
            latestCapturedPostsCursor = cur;
            stats.status = `Bg Fast-Paginating Grid (${gridPostShortcodes.size}/${stats.expectedPosts})...`;
            broadcastStats();
            await bgSleep(420);
          } else {
            break;
          }
        }
      }

      if (gridPostShortcodes.size > prevCount) {
        staleRounds = 0;
      } else {
        staleRounds++;
      }
    }
  }
}

async function bgScanAllReels() {
  if (!jobContext.userId) {
    const profRes = await bgIgJsonFetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(jobContext.username)}`
    );
    const u = profRes?.data?.data?.user || profRes?.data?.graphql?.user || profRes?.data?.user;
    if (u && (u.id || u.pk)) {
      jobContext.userId = cleanPk(u.id || u.pk);
    }
  }

  if (!jobContext.userId) return;

  let maxId = null;
  let page = 0;
  const visitedReels = new Set();

  while (!stopRequested) {
    page++;
    stats.status = `Bg Scanning 2. Reels Section (Page ${page}: ${uniqueReelShortcodes.size} unique Reels)...`;
    broadcastStats();

    const body = new URLSearchParams({
      target_user_id: String(jobContext.userId),
      page_size: "24",
      include_feed_video: "true"
    });
    if (maxId) body.set("max_id", maxId);

    let res = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      res = await bgIgJsonFetch("https://www.instagram.com/api/v1/clips/user/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString()
      });
      if (res.ok && res.data) break;
      if (res.status === 429) {
        await bgSleep(4500);
      } else {
        await bgSleep(600);
      }
    }

    if (!res || !res.ok || !res.data) break;

    const data = res.data;
    parseAndQueuePayload(data, jobContext.username, true, "reels");

    const paging = data.paging_info || {};
    const nextCursor = paging.max_id || data.next_max_id || null;
    const moreAvailable = Boolean(paging.more_available || data.more_available);

    if (moreAvailable && nextCursor && !visitedReels.has(String(nextCursor))) {
      visitedReels.add(String(nextCursor));
      maxId = String(nextCursor);
      await bgSleep(420);
    } else {
      break;
    }
  }

  if (!stopRequested && jobContext.userId) {
    await triggerTabScrollAssist("reels");
    await bgSleep(500);

    const candidateReelsDocIds = Array.from(new Set([jobContext.reelsDocId, ...REELS_DOC_IDS])).filter(Boolean);

    for (const rDocId of candidateReelsDocIds) {
      if (stopRequested) break;
      let afterCursor = latestCapturedReelsCursor || null;
      let rPage = 0;
      const visitedGqlReels = new Set();

      while (!stopRequested) {
        rPage++;
        stats.status = `Bg Scanning 2. Reels Section (GraphQL Page ${rPage}: ${uniqueReelShortcodes.size} unique Reels)...`;
        broadcastStats();

        let variables = {
          data: {
            include_feed_video: true,
            page_size: 12,
            target_user_id: String(jobContext.userId)
          }
        };

        if (jobContext.reelsReqTemplate) {
          try {
            const tplParams = new URLSearchParams(jobContext.reelsReqTemplate);
            const tplVars = JSON.parse(tplParams.get("variables") || "{}");
            variables = {
              ...tplVars,
              data: {
                ...(tplVars.data || {}),
                include_feed_video: true,
                page_size: 12,
                target_user_id: String(jobContext.userId)
              }
            };
          } catch (_) {}
        }

        if (afterCursor) {
          variables.after = String(afterCursor);
          variables.first = 12;
          variables.last = null;
          variables.before = null;
        }

        const bodyStr = buildGraphqlBody(
          jobContext.reelsReqTemplate,
          rDocId,
          "PolarisProfileReelsTabContentQuery_connection",
          variables
        );

        const res = await bgIgJsonFetch("https://www.instagram.com/graphql/query", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-fb-friendly-name": "PolarisProfileReelsTabContentQuery_connection"
          },
          body: bodyStr
        });

        const conn = res?.data?.data?.xdt_api__v1__clips__user__connection_v2;
        if (!conn) break;

        parseAndQueuePayload(res.data, jobContext.username, true, "reels");

        const hasNext = Boolean(conn.page_info?.has_next_page);
        const endCursor = conn.page_info?.end_cursor || null;

        if (hasNext && endCursor && !visitedGqlReels.has(String(endCursor))) {
          visitedGqlReels.add(String(endCursor));
          afterCursor = String(endCursor);
          latestCapturedReelsCursor = afterCursor;
          await bgSleep(450);
        } else {
          break;
        }
      }
    }
  }
}

function parseAndQueuePayload(rootObj, targetUserLower, isTrustedFeed, sectionContext, bypassDedup = false) {
  const discoveredBatch = [];
  const visited = new WeakSet();

  function walk(node, activeSection = sectionContext) {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, activeSection);
      return;
    }

    if (node.reels_media || node.tray || node.story_ranking_token) return;

    if (node.xdt_api__v1__clips__user__connection_v2) {
      const c = node.xdt_api__v1__clips__user__connection_v2;
      if (c.page_info?.end_cursor) {
        latestCapturedReelsCursor = String(c.page_info.end_cursor);
      }
      walk(c, "reels");
      return;
    }
    if (node.xdt_api__v1__feed__user_timeline_graphql_connection || node.edge_owner_to_timeline_media) {
      const c = node.xdt_api__v1__feed__user_timeline_graphql_connection || node.edge_owner_to_timeline_media;
      if (c.page_info?.end_cursor) {
        latestCapturedPostsCursor = String(c.page_info.end_cursor);
      }
      walk(c, "posts");
      return;
    }

    if (node.media && typeof node.media === "object" && (node.media.code || node.media.pk || node.media.shortcode)) {
      walk(node.media, activeSection);
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
      if (isOwnedOrCollab(node, targetUserLower, isTrustedFeed)) {
        extractSlidesFromNode(node, targetUserLower, activeSection, discoveredBatch, bypassDedup);
      }
      return;
    }

    for (const k of Object.keys(node)) {
      if (k === "reels_media" || k === "stories") continue;
      walk(node[k], activeSection);
    }
  }

  walk(rootObj, sectionContext);

  if (discoveredBatch.length > 0) {
    enqueueItemsForDownload(discoveredBatch);
  }
  stats.gridPostsMatched = gridPostShortcodes.size;
  stats.uniqueReelsMatched = uniqueReelShortcodes.size;
  broadcastStats();
}

function isOwnedOrCollab(item, targetUserLower, isTrustedFeed) {
  if (item.repost_info || item.original_media_id) return false;
  if (isTrustedFeed) return true;

  const ownerUsername = (item.user?.username || item.owner?.username || "").toLowerCase();
  const ownerPk = cleanPk(item.user?.pk || item.user?.id || item.owner?.id || item.owner?.pk);

  if (ownerUsername === targetUserLower) {
    if (ownerPk && !jobContext.userId) jobContext.userId = ownerPk;
    return true;
  }

  if (jobContext.userId && ownerPk && ownerPk === jobContext.userId) return true;

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
    if (caUser === targetUserLower || (jobContext.userId && caPk === jobContext.userId)) {
      return true;
    }
  }

  if (!ownerUsername && !ownerPk) return true;
  return false;
}

function extractSlidesFromNode(item, folderUsername, sectionContext, discoveredOut, bypassDedup) {
  const shortcode = String(item.code || item.shortcode).trim();
  const parentPk = cleanPk(item.pk || item.id);

  if (sectionContext === "reels") {
    if (!gridPostShortcodes.has(shortcode)) {
      uniqueReelShortcodes.add(shortcode);
    }
  } else {
    gridPostShortcodes.add(shortcode);
    if (uniqueReelShortcodes.has(shortcode)) {
      uniqueReelShortcodes.delete(shortcode);
    }
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
      if (parentPk && !resolvedCarouselPks.has(parentPk)) {
        pendingCarouselPks.add(parentPk);
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
        if (parentPk && !resolvedCarouselPks.has(parentPk)) {
          pendingCarouselPks.add(parentPk);
        }
        return;
      }

      const assetId = getNormalizedAssetId(extracted.url);

      if (
        !bypassDedup &&
        (seenMediaPksGlobal.has(slidePk) ||
          seenSlideKeysGlobal.has(slideKey) ||
          seenAssetIdsGlobal.has(assetId))
      ) {
        stats.duplicatesSkipped++;
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
    if (parentPk && !resolvedCarouselPks.has(parentPk)) {
      pendingCarouselPks.add(parentPk);
    }
    return;
  }

  const assetId = getNormalizedAssetId(extracted.url);

  if (
    !bypassDedup &&
    (seenShortcodesGlobal.has(shortcode) ||
      seenMediaPksGlobal.has(singlePk) ||
      seenSlideKeysGlobal.has(singleSlideKey) ||
      seenAssetIdsGlobal.has(assetId))
  ) {
    stats.duplicatesSkipped++;
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

function enqueueItemsForDownload(items) {
  for (const item of items) {
    if (item.section === "reels") {
      stats.reelsOnlyFiles++;
    } else if (item.section === "posts") {
      stats.gridPostsFiles++;
    }
    stats.totalQueued++;
    downloadQueue.push({ ...item, retries: 0 });
  }
  processQueue();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender?.tab?.id && sender.tab.url?.includes("instagram.com")) {
    activeIgTabId = sender.tab.id;
    protectInstagramTabFromDiscard(activeIgTabId);
  }

  if (message.action === "OFFSCREEN_HEARTBEAT") {
    reconcileDownloads();
    if (downloadQueue.length > 0 && activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
      processQueue();
    }
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "SET_IMAGE_FORMAT") {
    forcedImageFormat = message.format || "auto";
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "START_AUTONOMOUS_PROFILE_JOB") {
    if (isJobRunning) {
      sendResponse({ ok: true, alreadyRunning: true });
      return false;
    }

    if (sender?.tab?.id) {
      activeIgTabId = sender.tab.id;
      protectInstagramTabFromDiscard(activeIgTabId);
    }

    downloadQueue = [];
    downloadMap.clear();
    activeDownloads = 0;
    gridPostShortcodes.clear();
    uniqueReelShortcodes.clear();
    seenShortcodesGlobal.clear();
    seenMediaPksGlobal.clear();
    seenSlideKeysGlobal.clear();
    seenAssetIdsGlobal.clear();
    pendingCarouselPks.clear();
    resolvedCarouselPks.clear();
    discoveredDomShortcodes.clear();

    if (message.format) forcedImageFormat = message.format;

    jobContext = {
      username: message.username,
      userId: message.userId || "",
      csrfToken: message.meta?.csrfToken || "",
      lsdToken: message.meta?.lsdToken || "",
      wwwClaim: message.meta?.wwwClaim || "0",
      postsDocId: message.meta?.postsDocId || "9310670392322965",
      reelsDocId: message.meta?.reelsDocId || "7898261790222653",
      postsReqTemplate: message.meta?.postsReqTemplate || "",
      reelsReqTemplate: message.meta?.reelsReqTemplate || ""
    };

    stats = {
      username: message.username,
      status: "Background Scanner started...",
      isRunning: true,
      expectedPosts: message.expectedPosts || 0,
      gridPostsMatched: 0,
      uniqueReelsMatched: 0,
      gridPostsFiles: 0,
      reelsOnlyFiles: 0,
      duplicatesSkipped: 0,
      totalQueued: 0,
      savedToDisk: 0,
      failedDownloads: 0
    };

    broadcastStats();
    runAutonomousProfileScan(message.initialPayloads || [], message.domShortcodes || []);
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "PASSIVE_JSON_CHUNK") {
    if (message.meta) syncMetaFromTab(message.meta);
    if (isJobRunning && jobContext.username && message.payload) {
      const sec = (message.url || "").includes("clips") ? "reels" : "posts";
      parseAndQueuePayload(message.payload, jobContext.username, true, sec, false);
    }
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "DOWNLOAD_SINGLE_POST_PAYLOAD") {
    ensureOffscreenKeepAlive();
    parseAndQueuePayload(message.payload, message.username, true, "posts", true);
    updateStatusText();
    broadcastStats();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "QUEUE_STORY_ITEMS") {
    ensureOffscreenKeepAlive();
    enqueueItemsForDownload(message.items || []);
    updateStatusText();
    broadcastStats();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "STOP_ALL") {
    stopRequested = true;
    isJobRunning = false;
    stats.isRunning = false;
    downloadQueue = [];
    for (const [downloadId] of downloadMap.entries()) {
      downloadMap.delete(downloadId);
      try {
        chrome.downloads.cancel(downloadId, () => {});
      } catch (_) {}
    }
    activeDownloads = 0;
    stats.status = "Stopped";
    closeOffscreenKeepAlive();
    broadcastStats();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "GET_STATS") {
    sendResponse(stats);
    return false;
  }
  return false;
});

function processQueue() {
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length > 0 && !stopRequested) {
    const item = downloadQueue.shift();
    activeDownloads++;
    startDownload(item);
  }
}

// FIXED: Passes strict sanitized relative path + `saveAs: false` + `conflictAction: "uniquify"` directly (NO `onDeterminingFilename` race condition!)
function startDownload(item) {
  const cleanUser = String(item.username || "instagram").replace(/[^a-zA-Z0-9._-]/g, "_");
  const baseName = String(item.baseFilename || item.filename || `media_${Date.now()}`)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_");

  let finalExt = item.extHint || "jpg";
  if (finalExt !== "mp4") {
    if (forcedImageFormat === "png") finalExt = "png";
    else if (forcedImageFormat === "jpg") finalExt = "jpg";
  }

  const safeFilePath = `Instagram/${cleanUser}/${baseName}.${finalExt}`;

  try {
    chrome.downloads.download(
      {
        url: item.url,
        filename: safeFilePath,
        conflictAction: "uniquify",
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          handleFailure(item);
        } else {
          downloadMap.set(downloadId, { item, startedAt: Date.now() });
        }
      }
    );
  } catch (_) {
    handleFailure(item);
  }
}

function handleFailure(item) {
  activeDownloads = Math.max(0, downloadMap.size);
  if (item.retries < 3 && stats.status !== "Stopped" && !stopRequested) {
    item.retries++;
    downloadQueue.push(item);
  } else {
    stats.failedDownloads++;
  }
  updateStatusText();
  broadcastStats();
  processQueue();
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!downloadMap.has(delta.id)) return;
  const entry = downloadMap.get(delta.id);

  if (delta.state && delta.state.current === "complete") {
    downloadMap.delete(delta.id);
    activeDownloads = Math.max(0, downloadMap.size);
    stats.savedToDisk++;
    updateStatusText();
    broadcastStats();
    processQueue();
  } else if (delta.state && delta.state.current === "interrupted") {
    downloadMap.delete(delta.id);
    handleFailure(entry.item);
  }
});

function updateStatusText() {
  if (stats.status === "Stopped") return;
  const remaining = downloadQueue.length + downloadMap.size;
  if (!isJobRunning && remaining === 0) {
    stats.status = `✅ Completed! Saved ${stats.savedToDisk} / ${stats.totalQueued} unique files to PC.`;
    closeOffscreenKeepAlive();
  } else if (!isJobRunning) {
    stats.status = `Saving to PC (Background): ${stats.savedToDisk} / ${stats.totalQueued} (${remaining} remaining)...`;
  }
}

function broadcastStats() {
  chrome.tabs.query({ url: "https://www.instagram.com/*" }, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { action: "STATS_UPDATE", stats }).catch(() => {});
    }
  });
}