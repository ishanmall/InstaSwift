(function () {
  if (window.__instaswiftV38Loaded) return;
  window.__instaswiftV38Loaded = true;

  // 1. Spoof Page Visibility & Focus so Instagram React NEVER pauses rendering
  try {
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    Object.defineProperty(document, "webkitHidden", { get: () => false, configurable: true });
    document.hasFocus = () => true;
    window.addEventListener("visibilitychange", (e) => e.stopImmediatePropagation(), true);
    window.addEventListener("blur", (e) => e.stopImmediatePropagation(), true);
  } catch (_) {}

  // 2. Hook IntersectionObserver so Instagram's infinite-scroll loader triggers even when window is minimized or in background!
  const activeIntersectionCallbacks = new Set();
  try {
    const OrigIO = window.IntersectionObserver;
    if (OrigIO) {
      window.IntersectionObserver = function (callback, options) {
        const instance = new OrigIO(callback, options);
        const trackedElements = new Set();
        const origObserve = instance.observe.bind(instance);
        const origUnobserve = instance.unobserve.bind(instance);
        const origDisconnect = instance.disconnect.bind(instance);

        instance.observe = function (el) {
          trackedElements.add(el);
          return origObserve(el);
        };
        instance.unobserve = function (el) {
          trackedElements.delete(el);
          return origUnobserve(el);
        };
        instance.disconnect = function () {
          trackedElements.clear();
          activeIntersectionCallbacks.delete(triggerEntry);
          return origDisconnect();
        };

        const triggerEntry = () => {
          try {
            const entries = [];
            for (const el of trackedElements) {
              if (document.body.contains(el)) {
                entries.push({
                  isIntersecting: true,
                  intersectionRatio: 1,
                  target: el,
                  time: performance.now(),
                  boundingClientRect: el.getBoundingClientRect(),
                  intersectionRect: el.getBoundingClientRect(),
                  rootBounds: null
                });
              }
            }
            if (entries.length > 0) callback(entries, instance);
          } catch (_) {}
        };

        activeIntersectionCallbacks.add(triggerEntry);
        return instance;
      };
      window.IntersectionObserver.prototype = OrigIO.prototype;
    }
  } catch (_) {}

  function fireAllIntersectionObservers() {
    for (const trigger of activeIntersectionCallbacks) {
      try { trigger(); } catch (_) {}
    }
  }

  const IG_APP_ID = "936619743392459";

  // Stores exact outgoing GraphQL request bodies & headers captured from Instagram's own frontend
  const capturedGraphql = {
    postsDocId: "",
    reelsDocId: "",
    lsdToken: "",
    postsTemplateBody: "",
    reelsTemplateBody: "",
    anyTemplateBody: "",
    extraHeaders: {},
    lastPostsEndCursor: "",
    lastReelsEndCursor: "",
    postsHasNextPage: true,
    reelsHasNextPage: true
  };

  let workerClock = null;
  const workerTimers = new Map();
  let workerTimerId = 0;

  function ensureWorkerClock() {
    if (workerClock) return workerClock;
    try {
      const blob = new Blob(
        [
          `
          self.onmessage = function(e) {
            const { id, ms } = e.data;
            setTimeout(() => {
              self.postMessage({ id });
            }, Math.max(15, ms || 50));
          };
          `
        ],
        { type: "application/javascript" }
      );
      workerClock = new Worker(URL.createObjectURL(blob));
      workerClock.onmessage = (e) => {
        const cb = workerTimers.get(e.data.id);
        if (cb) {
          workerTimers.delete(e.data.id);
          cb();
        }
      };
    } catch (_) {
      workerClock = null;
    }
    return workerClock;
  }

  function unthrottledSleep(ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      const w = ensureWorkerClock();
      if (w) {
        const id = ++workerTimerId;
        workerTimers.set(id, finish);
        w.postMessage({ id, ms });
      }
      setTimeout(finish, ms + 60);
    });
  }

  let liveAudioCtx = null;
  let liveAudioEl = null;
  function engageMainWorldMediaLock() {
    ensureWorkerClock();
    try {
      if (navigator.locks && navigator.locks.request) {
        navigator.locks.request("instaswift_v38_main_lock", () => new Promise(() => {}));
      }
    } catch (_) {}

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        if (!liveAudioCtx) {
          liveAudioCtx = new Ctx();
          const osc = liveAudioCtx.createOscillator();
          const gain = liveAudioCtx.createGain();
          gain.gain.value = 0.0001;
          osc.frequency.value = 20;
          osc.connect(gain);
          gain.connect(liveAudioCtx.destination);

          if (typeof liveAudioCtx.createMediaStreamDestination === "function") {
            const streamDest = liveAudioCtx.createMediaStreamDestination();
            gain.connect(streamDest);
            liveAudioEl = document.createElement("audio");
            liveAudioEl.srcObject = streamDest.stream;
            liveAudioEl.volume = 0.01;
            liveAudioEl.autoplay = true;
            liveAudioEl.style.display = "none";
            document.documentElement.appendChild(liveAudioEl);
            liveAudioEl.play().catch(() => {});
          }
          osc.start();
        } else if (liveAudioCtx.state === "suspended") {
          liveAudioCtx.resume().catch(() => {});
        }
        if (liveAudioEl && liveAudioEl.paused) {
          liveAudioEl.play().catch(() => {});
        }
      }
    } catch (_) {}
  }

  function getCsrfToken() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : "";
  }

  function getLsdToken() {
    if (capturedGraphql.lsdToken) return capturedGraphql.lsdToken;
    const html = document.documentElement?.innerHTML || "";
    const m =
      html.match(/\["LSD",\[\],\{"token":"([^"]+)"\}/) ||
      html.match(/"lsd":"([^"]+)"/) ||
      html.match(/name="lsd"\s+value="([^"]+)"/);
    if (m && m[1]) capturedGraphql.lsdToken = m[1];
    return capturedGraphql.lsdToken;
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

  function cleanPk(raw) {
    if (!raw) return "";
    return String(raw).split("_")[0].trim();
  }

  function getBaseCdnPath(url) {
    try {
      return new URL(url).pathname;
    } catch (_) {
      return String(url || "");
    }
  }

  function emitToContent(type, data) {
    window.postMessage(
      {
        source: "INSTASWIFT_MAIN",
        type,
        pagePath: window.location.pathname,
        ...data
      },
      "*"
    );
  }

  const mainWorldPassiveBuffer = [];

  function inspectOutgoingGraphql(bodyStr, reqHeaders = {}) {
    try {
      if (typeof bodyStr !== "string" || !bodyStr.includes("doc_id=")) return;
      const params = new URLSearchParams(bodyStr);
      const friendly = params.get("fb_api_req_friendly_name") || "";
      const docId = params.get("doc_id") || "";
      const lsd = params.get("lsd") || "";
      const vars = params.get("variables") || "";

      if (lsd) capturedGraphql.lsdToken = lsd;
      capturedGraphql.anyTemplateBody = bodyStr;

      if (docId) {
        if (
          friendly.includes("Posts") ||
          friendly.includes("Timeline") ||
          (vars.includes('"username"') && vars.includes('"count"'))
        ) {
          capturedGraphql.postsDocId = docId;
          capturedGraphql.postsTemplateBody = bodyStr;
        } else if (
          friendly.includes("Reels") ||
          friendly.includes("Clips") ||
          vars.includes("target_user_id")
        ) {
          capturedGraphql.reelsDocId = docId;
          capturedGraphql.reelsTemplateBody = bodyStr;
        }
      }
    } catch (_) {}
  }

  function extractCursorsFromPayload(payload) {
    try {
      const postsConn =
        payload?.data?.xdt_api__v1__feed__user_timeline_graphql_connection ||
        payload?.data?.user?.edge_owner_to_timeline_media;
      if (postsConn?.page_info) {
        capturedGraphql.postsHasNextPage = Boolean(postsConn.page_info.has_next_page);
        if (postsConn.page_info.end_cursor) {
          capturedGraphql.lastPostsEndCursor = String(postsConn.page_info.end_cursor);
        }
      }
      const reelsConn = payload?.data?.xdt_api__v1__clips__user__connection_v2;
      if (reelsConn?.page_info) {
        capturedGraphql.reelsHasNextPage = Boolean(reelsConn.page_info.has_next_page);
        if (reelsConn.page_info.end_cursor) {
          capturedGraphql.lastReelsEndCursor = String(reelsConn.page_info.end_cursor);
        }
      }
    } catch (_) {}
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const pagePathAtStart = window.location.pathname;
    try {
      if (typeof args[1]?.body === "string") inspectOutgoingGraphql(args[1].body, args[1].headers);
    } catch (_) {}

    const response = await origFetch.apply(this, args);
    try {
      const reqUrl = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
      if (reqUrl.includes("/graphql") || reqUrl.includes("/api/v1/") || reqUrl.includes("query")) {
        const clone = response.clone();
        clone.text().then((txt) => {
          const t = txt.trim();
          if (t.startsWith("{") || t.startsWith("[")) {
            try {
              const parsed = JSON.parse(t);
              extractCursorsFromPayload(parsed);
              mainWorldPassiveBuffer.push({
                url: reqUrl,
                pagePath: pagePathAtStart,
                payload: parsed
              });
              if (mainWorldPassiveBuffer.length > 250) mainWorldPassiveBuffer.shift();

              if (mainScanState.isRunning && mainScanState.targetUser) {
                const isClips =
                  reqUrl.includes("clips") ||
                  pagePathAtStart.includes("/reels") ||
                  Boolean(parsed?.data?.xdt_api__v1__clips__user__connection_v2);
                routePayloadIntoMainRoom(
                  parsed,
                  mainScanState.targetUser,
                  isClips ? "reels" : mainScanState.currentPhase
                );
              }

              emitToContent("INTERCEPTED_JSON", {
                url: reqUrl,
                pagePath: pagePathAtStart,
                payload: parsed
              });
            } catch (_) {}
          }
        }).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__isUrl = typeof url === "string" ? url : String(url || "");
    this.__pagePath = window.location.pathname;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (typeof args[0] === "string") inspectOutgoingGraphql(args[0]);
    } catch (_) {}

    this.addEventListener("load", function () {
      try {
        const url = this.__isUrl || "";
        if (url.includes("/graphql") || url.includes("/api/v1/") || url.includes("query")) {
          const t = (this.responseText || "").trim();
          if (t.startsWith("{") || t.startsWith("[")) {
            const parsed = JSON.parse(t);
            extractCursorsFromPayload(parsed);
            mainWorldPassiveBuffer.push({
              url,
              pagePath: this.__pagePath || window.location.pathname,
              payload: parsed
            });
            if (mainWorldPassiveBuffer.length > 250) mainWorldPassiveBuffer.shift();

            if (mainScanState.isRunning && mainScanState.targetUser) {
              const isClips =
                url.includes("clips") ||
                (this.__pagePath || "").includes("/reels") ||
                Boolean(parsed?.data?.xdt_api__v1__clips__user__connection_v2);
              routePayloadIntoMainRoom(
                parsed,
                mainScanState.targetUser,
                isClips ? "reels" : mainScanState.currentPhase
              );
            }

            emitToContent("INTERCEPTED_JSON", {
              url,
              pagePath: this.__pagePath || window.location.pathname,
              payload: parsed
            });
          }
        }
      } catch (_) {}
    });
    return origSend.apply(this, args);
  };

  async function mainWorldJsonFetch(url, options = {}) {
    const t0 = performance.now();
    try {
      const lsd = getLsdToken();
      const headers = {
        "x-ig-app-id": IG_APP_ID,
        "x-csrftoken": getCsrfToken(),
        "x-requested-with": "XMLHttpRequest",
        "x-asbd-id": "129477",
        "x-ig-www-claim": sessionStorage.getItem("www-claim-v2") || "0",
        "accept": "*/*",
        ...(options.headers || {})
      };
      if (lsd) headers["x-fb-lsd"] = lsd;

      const res = await origFetch(url, {
        ...options,
        headers,
        credentials: "include"
      });
      const rttMs = Math.max(20, Math.round(performance.now() - t0));
      if (!res.ok) return { ok: false, status: res.status, rttMs, data: null };
      const txt = (await res.text()).trim();
      if (!txt.startsWith("{") && !txt.startsWith("[")) {
        return { ok: false, status: 200, rttMs, data: null };
      }
      const parsed = JSON.parse(txt);
      extractCursorsFromPayload(parsed);
      return { ok: true, status: 200, rttMs, data: parsed };
    } catch (_) {
      return { ok: false, status: 0, rttMs: 500, data: null };
    }
  }

  // =========================================================
  // PHYSICS PACING & 3-SECTION STAGING ROOM
  // =========================================================
  const mainScanPhysics = {
    alpha: 0.35,
    ewmaRttMs: 160,
    ewmaVelocityFps: 0,
    lastTickTs: Date.now(),
    lastCount: 0,

    recordRtt(rttMs) {
      if (rttMs > 0) {
        this.ewmaRttMs = Math.round(this.alpha * rttMs + (1 - this.alpha) * this.ewmaRttMs);
      }
    },

    computeGapMs(currentCount) {
      const now = Date.now();
      const dtSec = Math.max(0.05, (now - this.lastTickTs) / 1000);
      const dN = Math.max(0, currentCount - this.lastCount);
      const instVel = dN / dtSec;
      this.ewmaVelocityFps = Number((this.alpha * instVel + (1 - this.alpha) * this.ewmaVelocityFps).toFixed(1));
      this.lastTickTs = now;
      this.lastCount = currentCount;

      const baseDelay = 110;
      const rttPenalty = Math.max(0, (this.ewmaRttMs - 140) * 0.22);
      const speedBoost = Math.min(40, this.ewmaVelocityFps * 1.1);
      return Math.max(75, Math.min(300, Math.round(baseDelay + rttPenalty - speedBoost)));
    },

    reset() {
      this.ewmaRttMs = 160;
      this.ewmaVelocityFps = 0;
      this.lastTickTs = Date.now();
      this.lastCount = 0;
    }
  };

  const mainRoom = {
    gridVault: new Map(),       // Room 1: Grid Set G
    rawReelsStaging: new Map(), // Raw Reels Set R
    reelsVault: new Map(),      // Room 2: Unique Reels (R \ G)
    duplicateVault: new Map(),  // Room 3: Duplicates (G \cap R)

    gridUniquePosts: new Set(),
    gridFingerprints: new Set(),
    gridShortcodes: new Set(),
    gridMediaPks: new Set(),
    gridBaseUrls: new Set(),
    reelsFingerprints: new Set(),

    pendingDeepResolvePks: new Map(),
    resolvedDeepPks: new Set(),

    reset() {
      this.gridVault.clear();
      this.rawReelsStaging.clear();
      this.reelsVault.clear();
      this.duplicateVault.clear();
      this.gridUniquePosts.clear();
      this.gridFingerprints.clear();
      this.gridShortcodes.clear();
      this.gridMediaPks.clear();
      this.gridBaseUrls.clear();
      this.reelsFingerprints.clear();
      this.pendingDeepResolvePks.clear();
      this.resolvedDeepPks.clear();
    }
  };

  const mainScanState = {
    isRunning: false,
    stopRequested: false,
    targetUser: "",
    targetUserId: "",
    expectedPosts: 0,
    currentPhase: "posts"
  };

  function sendRoomProgress(statusText) {
    emitToContent("MAIN_SCAN_PROGRESS", {
      status: statusText,
      gridCount: mainRoom.gridVault.size,
      reelsCount: mainRoom.reelsVault.size,
      dupsCount: mainRoom.duplicateVault.size,
      velocityFps: mainScanPhysics.ewmaVelocityFps,
      rttMs: mainScanPhysics.ewmaRttMs
    });
  }

  function findUserIdInDOM(usernameLower) {
    const html = document.documentElement?.innerHTML || "";
    const escaped = usernameLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regexes = [
      new RegExp(`"id":"(\\d+)"[^}]{0,250}"username":"${escaped}"`, "i"),
      new RegExp(`"username":"${escaped}"[^}]{0,250}"id":"(\\d+)"`, "i"),
      new RegExp(`"pk":"(\\d+)"[^}]{0,250}"username":"${escaped}"`, "i"),
      /"profilePage_(\d+)"/i,
      /"target_id":"(\d+)"/i
    ];
    for (const rx of regexes) {
      const m = html.match(rx);
      if (m && m[1]) return m[1];
    }
    return "";
  }

  function findExpectedPostsInDOM() {
    try {
      const text = document.body?.innerText || "";
      const m = text.match(/([\d,]+)\s+posts/i);
      if (m && m[1]) {
        return Number(m[1].replace(/,/g, "")) || 0;
      }
    } catch (_) {}
    return 0;
  }

  function scanEmbeddedScriptsInMainWorld(usernameLower, phaseTag) {
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
          const parsed = JSON.parse(txt);
          extractCursorsFromPayload(parsed);
          routePayloadIntoMainRoom(parsed, usernameLower, phaseTag);
        } catch (_) {}
      }
    }
  }

  // =========================================================
  // TAB SWITCHER & SYNTHETIC AUTO-SCROLLER (BYPASSES 17-ITEM LIMIT!)
  // =========================================================
  async function switchProfileTabInDOM(username, section) {
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
      await unthrottledSleep(900);
      scanEmbeddedScriptsInMainWorld(lowerUser, section);
      return true;
    }
    return false;
  }

  // High-speed Auto-Scroll + IntersectionObserver Trigger
  // Captures Instagram's live GraphQL doc_id & template while scrolling and collects all posts/reels!
  async function runAutoScrollAndObserverHarvest(phaseTag, maxIdleRounds = 12) {
    let idleTicks = 0;
    let lastCount =
      phaseTag === "posts"
        ? mainRoom.gridVault.size
        : mainRoom.reelsVault.size + mainRoom.duplicateVault.size;
    let lastScrollHeight = 0;
    let step = 0;

    while (!mainScanState.stopRequested && idleTicks < maxIdleRounds) {
      step++;
      // 1. Scroll window to bottom
      window.scrollTo(0, document.body.scrollHeight + 2000);
      window.dispatchEvent(new Event("scroll", { bubbles: true }));
      window.dispatchEvent(new WheelEvent("wheel", { deltaY: 1200, bubbles: true }));

      // 2. Fire all IntersectionObservers directly (so even if tab is in background, React triggers the next GraphQL page load!)
      fireAllIntersectionObservers();

      await unthrottledSleep(420);

      // 3. If scrolling just captured a live GraphQL template + cursor, immediately accelerate with Cloned GraphQL API!
      if (phaseTag === "posts" && capturedGraphql.postsTemplateBody && capturedGraphql.lastPostsEndCursor) {
        await runClonedGraphqlPagination("posts");
      } else if (phaseTag === "reels" && capturedGraphql.reelsTemplateBody && capturedGraphql.lastReelsEndCursor) {
        await runClonedGraphqlPagination("reels");
      }

      const currentCount =
        phaseTag === "posts"
          ? mainRoom.gridVault.size
          : mainRoom.reelsVault.size + mainRoom.duplicateVault.size;
      const currentHeight = document.body.scrollHeight;
      const hasSpinner = Boolean(
        document.querySelector('main [role="progressbar"], main svg[aria-label="Loading..."]')
      );

      if (phaseTag === "posts") {
        const postProg = mainScanState.expectedPosts
          ? `(${mainRoom.gridUniquePosts.size}/${mainScanState.expectedPosts} posts)`
          : "";
        sendRoomProgress(
          `Step 1/3 (Grid Auto-Scroll + GraphQL): ${postProg} • Room 1 (G): ${mainRoom.gridVault.size} files`
        );
        if (
          mainScanState.expectedPosts > 0 &&
          mainRoom.gridUniquePosts.size >= mainScanState.expectedPosts
        ) {
          break;
        }
      } else {
        sendRoomProgress(
          `Step 2/3 (Reels Auto-Scroll + GraphQL): Room 2 (R\\G): ${mainRoom.reelsVault.size} | Room 3 Dups (G∩R): ${mainRoom.duplicateVault.size}`
        );
      }

      if (currentCount > lastCount || currentHeight > lastScrollHeight) {
        idleTicks = 0;
        lastCount = currentCount;
        lastScrollHeight = currentHeight;
      } else if (hasSpinner) {
        await unthrottledSleep(450);
        idleTicks++;
      } else {
        idleTicks++;
      }
    }
  }

  // Clones Instagram's exact outgoing GraphQL request body (preserving __hs, __rev, __dyn, lsd, doc_id)
  async function runClonedGraphqlPagination(phaseTag) {
    const isPosts = phaseTag === "posts";
    const templateStr = isPosts
      ? (capturedGraphql.postsTemplateBody || capturedGraphql.anyTemplateBody)
      : (capturedGraphql.reelsTemplateBody || capturedGraphql.anyTemplateBody);

    if (!templateStr) return;

    let cursor = isPosts ? capturedGraphql.lastPostsEndCursor : capturedGraphql.lastReelsEndCursor;
    const seenCursors = new Set();
    let page = 0;

    while (!mainScanState.stopRequested && cursor && !seenCursors.has(cursor)) {
      seenCursors.add(cursor);
      page++;

      const total = mainRoom.gridVault.size + mainRoom.reelsVault.size + mainRoom.duplicateVault.size;
      const gapMs = mainScanPhysics.computeGapMs(total);

      if (isPosts) {
        const postProg = mainScanState.expectedPosts
          ? `(${mainRoom.gridUniquePosts.size}/${mainScanState.expectedPosts} posts)`
          : "";
        sendRoomProgress(
          `Step 1/3 (Cloned Grid GraphQL): Page ${page} ${postProg} • Room 1 (G): ${mainRoom.gridVault.size} files • v=${mainScanPhysics.ewmaVelocityFps}/s`
        );
      } else {
        sendRoomProgress(
          `Step 2/3 (Cloned Reels GraphQL): Page ${page} • Room 2 (R\\G): ${mainRoom.reelsVault.size} | Room 3 Dups (G∩R): ${mainRoom.duplicateVault.size}`
        );
      }

      const params = new URLSearchParams(templateStr);
      let baseVars = {};
      try {
        baseVars = JSON.parse(params.get("variables") || "{}");
      } catch (_) {}

      if (isPosts) {
        baseVars.username = mainScanState.targetUser;
        baseVars.after = String(cursor);
        baseVars.first = 33;
        if (!baseVars.data) {
          baseVars.data = {
            count: 33,
            include_relationship_info: true,
            latest_besties_reel_media: true,
            latest_reel_media: true
          };
        }
        params.set("fb_api_req_friendly_name", "PolarisProfilePostsTabContentQuery_connection");
        if (capturedGraphql.postsDocId) params.set("doc_id", capturedGraphql.postsDocId);
      } else {
        baseVars.after = String(cursor);
        baseVars.first = 24;
        if (!baseVars.data) {
          baseVars.data = {
            include_feed_video: true,
            page_size: 24,
            target_user_id: String(mainScanState.targetUserId)
          };
        } else {
          baseVars.data.target_user_id = String(mainScanState.targetUserId);
        }
        params.set("fb_api_req_friendly_name", "PolarisProfileReelsTabContentQuery_connection");
        if (capturedGraphql.reelsDocId) params.set("doc_id", capturedGraphql.reelsDocId);
      }

      params.set("variables", JSON.stringify(baseVars));

      const friendlyHeader = params.get("fb_api_req_friendly_name") || "";
      const res = await mainWorldJsonFetch("https://www.instagram.com/graphql/query", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": friendlyHeader
        },
        body: params.toString()
      });

      if (!res.ok || !res.data) break;
      mainScanPhysics.recordRtt(res.rttMs);
      routePayloadIntoMainRoom(res.data, mainScanState.targetUser, phaseTag);

      const conn = isPosts
        ? (res.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection ||
           res.data?.data?.user?.edge_owner_to_timeline_media)
        : res.data?.data?.xdt_api__v1__clips__user__connection_v2;

      if (!conn || !conn.page_info?.has_next_page || !conn.page_info?.end_cursor) {
        break;
      }

      cursor = String(conn.page_info.end_cursor);
      await unthrottledSleep(gapMs);
    }
  }

  // =========================================================
  // MASTER 3-ROOM SCANNER
  // =========================================================
  async function runMainWorld3RoomScan(username) {
    if (mainScanState.isRunning) return;
    mainScanState.isRunning = true;
    mainScanState.stopRequested = false;
    mainScanState.targetUser = username.toLowerCase();
    mainScanState.targetUserId = findUserIdInDOM(mainScanState.targetUser);
    mainScanState.expectedPosts = findExpectedPostsInDOM();

    engageMainWorldMediaLock();
    mainRoom.reset();
    mainScanPhysics.reset();

    sendRoomProgress("Step 1/3: Locking Profile ID & Scanning ALL Grid Posts...");

    try {
      const startsOnReels = window.location.pathname.toLowerCase().includes("/reels");
      scanEmbeddedScriptsInMainWorld(mainScanState.targetUser, startsOnReels ? "reels" : "posts");

      for (const entry of mainWorldPassiveBuffer) {
        const isClips = (entry.url || "").includes("clips") || (entry.pagePath || "").includes("/reels");
        routePayloadIntoMainRoom(entry.payload, mainScanState.targetUser, isClips ? "reels" : "posts");
      }

      // Try Web Profile Info (single attempt so if rate-limited we don't waste time)
      const profRes = await mainWorldJsonFetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(mainScanState.targetUser)}`
      );
      if (profRes.ok && profRes.data) {
        const u = profRes.data?.data?.user || profRes.data?.graphql?.user || profRes.data?.user;
        if (u && (u.id || u.pk)) mainScanState.targetUserId = cleanPk(u.id || u.pk);
        if (u?.edge_owner_to_timeline_media?.count) {
          mainScanState.expectedPosts = Number(u.edge_owner_to_timeline_media.count) || mainScanState.expectedPosts;
        } else if (u?.media_count) {
          mainScanState.expectedPosts = Number(u.media_count) || mainScanState.expectedPosts;
        }
        routePayloadIntoMainRoom(profRes.data, mainScanState.targetUser, "posts");
      }

      // =====================================================
      // STEP 1: SCAN ALL GRID SECTION FIRST (Room 1: Set G)
      // =====================================================
      if (!mainScanState.stopRequested) {
        mainScanState.currentPhase = "posts";
        if (window.location.pathname.toLowerCase().includes("/reels")) {
          await switchProfileTabInDOM(mainScanState.targetUser, "posts");
        }
        await scanGridInMainWorld(mainScanState.targetUser);
      }

      if (!mainScanState.stopRequested && mainRoom.pendingDeepResolvePks.size > 0) {
        await resolveDeepCarouselsInMainWorld("posts");
      }

      // =====================================================
      // STEP 2: SCAN ALL REELS SECTION SECOND (Room 2 & 3)
      // =====================================================
      if (!mainScanState.stopRequested) {
        mainScanState.currentPhase = "reels";
        await scanReelsInMainWorld(mainScanState.targetUser);
      }

      if (!mainScanState.stopRequested && mainRoom.pendingDeepResolvePks.size > 0) {
        await resolveDeepCarouselsInMainWorld("reels");
      }

      if (mainScanState.stopRequested) return;

      // =====================================================
      // STEP 3: STRICT SET-THEORY DEDUPLICATION PASS
      // =====================================================
      runMainWorldFinalDeduplication();
      window.scrollTo(0, 0);

      const finalUniqueItems = [
        ...Array.from(mainRoom.gridVault.values()),
        ...Array.from(mainRoom.reelsVault.values())
      ];

      emitToContent("MAIN_SCAN_COMPLETE", {
        username: mainScanState.targetUser,
        gridCount: mainRoom.gridVault.size,
        reelsCount: mainRoom.reelsVault.size,
        dupsCount: mainRoom.duplicateVault.size,
        items: finalUniqueItems
      });
    } catch (err) {
      sendRoomProgress(`⚠️ Scan Error: ${err.message}`);
    } finally {
      mainScanState.isRunning = false;
    }
  }

  async function scanGridInMainWorld(username) {
    let maxId = null;
    let page = 0;
    let restExhaustedCleanly = false;
    const seenCursors = new Set();

    // 1. Try REST Grid Feed (Fast fail in 2 tries if rate-limited so we immediately switch to Cloned GraphQL + Auto-Scroll!)
    while (!mainScanState.stopRequested) {
      page++;
      const gapMs = mainScanPhysics.computeGapMs(mainRoom.gridVault.size);
      const postProgress = mainScanState.expectedPosts
        ? `(${mainRoom.gridUniquePosts.size}/${mainScanState.expectedPosts} posts)`
        : "";
      sendRoomProgress(
        `Step 1/3 (Grid API): Page ${page} ${postProgress} • Room 1 (G): ${mainRoom.gridVault.size} files`
      );

      const baseUrl = (mainScanState.targetUserId && maxId)
        ? `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(mainScanState.targetUserId)}/`
        : `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/`;

      const url = new URL(baseUrl);
      url.searchParams.set("count", "33");
      if (maxId) url.searchParams.set("max_id", maxId);

      let res = await mainWorldJsonFetch(url.toString());
      if (!res.ok && mainScanState.targetUserId) {
        const altUrl = new URL(`https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/`);
        altUrl.searchParams.set("count", "33");
        if (maxId) altUrl.searchParams.set("max_id", maxId);
        res = await mainWorldJsonFetch(altUrl.toString());
      }

      if (!res.ok || !res.data) break;
      mainScanPhysics.recordRtt(res.rttMs);

      const data = res.data;
      if (!mainScanState.targetUserId && data.user?.pk) {
        mainScanState.targetUserId = cleanPk(data.user.pk);
      }
      if (!mainScanState.targetUserId && data.items?.[0]?.user?.pk) {
        mainScanState.targetUserId = cleanPk(data.items[0].user.pk);
      }

      routePayloadIntoMainRoom(data, mainScanState.targetUser, "posts");

      const nextCursor = data.next_max_id || data.paging_info?.max_id || null;
      if (data.more_available && nextCursor && !seenCursors.has(String(nextCursor))) {
        seenCursors.add(String(nextCursor));
        maxId = String(nextCursor);
        await unthrottledSleep(gapMs);
      } else {
        restExhaustedCleanly = !data.more_available;
        break;
      }
    }

    // 2. If REST was rate-limited (e.g., stuck at 17 items!), run Cloned GraphQL + Auto-Scroll + IntersectionObserver!
    const needsMoreGrid =
      !restExhaustedCleanly ||
      mainRoom.gridVault.size <= 35 ||
      (mainScanState.expectedPosts > 0 && mainRoom.gridUniquePosts.size < mainScanState.expectedPosts - 10);

    if (!mainScanState.stopRequested && needsMoreGrid) {
      if (capturedGraphql.postsTemplateBody && capturedGraphql.lastPostsEndCursor) {
        await runClonedGraphqlPagination("posts");
      }
      const stillNeedsMore =
        mainRoom.gridVault.size <= 35 ||
        (mainScanState.expectedPosts > 0 && mainRoom.gridUniquePosts.size < mainScanState.expectedPosts - 10);

      if (!mainScanState.stopRequested && stillNeedsMore) {
        await runAutoScrollAndObserverHarvest("posts", 14);
      }
    }
  }

  async function scanReelsInMainWorld(username) {
    if (!mainScanState.targetUserId) {
      mainScanState.targetUserId = findUserIdInDOM(mainScanState.targetUser);
    }

    let maxId = null;
    let page = 0;
    let apiExhausted = false;
    const seenCursors = new Set();

    if (mainScanState.targetUserId) {
      while (!mainScanState.stopRequested) {
        page++;
        const total = mainRoom.gridVault.size + mainRoom.reelsVault.size + mainRoom.duplicateVault.size;
        const gapMs = mainScanPhysics.computeGapMs(total);
        sendRoomProgress(
          `Step 2/3 (Reels API): Page ${page} • Room 2 Reels (R\\G): ${mainRoom.reelsVault.size} | Room 3 Dups (G∩R): ${mainRoom.duplicateVault.size}`
        );

        const body = new URLSearchParams({
          target_user_id: String(mainScanState.targetUserId),
          page_size: "24",
          include_feed_video: "true"
        });
        if (maxId) body.set("max_id", maxId);

        const res = await mainWorldJsonFetch("https://www.instagram.com/api/v1/clips/user/", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString()
        });

        if (!res.ok || !res.data) break;
        mainScanPhysics.recordRtt(res.rttMs);

        const data = res.data;
        routePayloadIntoMainRoom(data, mainScanState.targetUser, "reels");

        const paging = data.paging_info || {};
        const nextCursor = paging.max_id || data.next_max_id || null;
        if ((paging.more_available || data.more_available) && nextCursor && !seenCursors.has(String(nextCursor))) {
          seenCursors.add(String(nextCursor));
          maxId = String(nextCursor);
          await unthrottledSleep(gapMs);
        } else {
          apiExhausted = !(paging.more_available || data.more_available);
          break;
        }
      }
    }

    // If Reels REST API was rate-limited, switch to the Reels Tab in DOM, capture live GraphQL template, and scroll/paginate!
    if (!mainScanState.stopRequested && !apiExhausted) {
      await switchProfileTabInDOM(username, "reels");
      if (capturedGraphql.reelsTemplateBody && capturedGraphql.lastReelsEndCursor) {
        await runClonedGraphqlPagination("reels");
      }
      await runAutoScrollAndObserverHarvest("reels", 12);
    }
  }

  async function resolveDeepCarouselsInMainWorld(targetPhase) {
    const entries = Array.from(mainRoom.pendingDeepResolvePks.entries()).filter(
      ([pk, phase]) => !mainRoom.resolvedDeepPks.has(pk) && (!targetPhase || phase === targetPhase)
    );
    let idx = 0;
    for (const [pk, phaseTag] of entries) {
      if (mainScanState.stopRequested) break;
      idx++;
      mainRoom.resolvedDeepPks.add(pk);
      sendRoomProgress(`Expanding Full Carousel (${idx}/${entries.length})...`);

      const res = await mainWorldJsonFetch(
        `https://www.instagram.com/api/v1/media/${encodeURIComponent(pk)}/info/`
      );
      if (res.ok && res.data) {
        routePayloadIntoMainRoom(res.data, mainScanState.targetUser, phaseTag);
      } else {
        break; // Stop deep resolve if media/info endpoint is rate-limited
      }
      await unthrottledSleep(110);
    }
  }

  function runMainWorldFinalDeduplication() {
    for (const [slideKey, reelEntry] of mainRoom.rawReelsStaging.entries()) {
      const { rootShortcode, mediaPk, baseUrl, fpHash, mediaRecord } = reelEntry;
      const existsInGridSetG =
        mainRoom.gridVault.has(slideKey) ||
        mainRoom.gridShortcodes.has(rootShortcode) ||
        mainRoom.gridFingerprints.has(fpHash) ||
        mainRoom.gridMediaPks.has(mediaPk) ||
        mainRoom.gridBaseUrls.has(baseUrl);

      if (existsInGridSetG) {
        mainRoom.reelsVault.delete(slideKey);
        mainRoom.duplicateVault.set(slideKey, mediaRecord);
      } else {
        mainRoom.reelsVault.set(slideKey, mediaRecord);
      }
    }
  }

  function routePayloadIntoMainRoom(rootObj, targetUserLower, phaseTag = "posts") {
    const visited = new WeakSet();

    function walk(node, activePhase = phaseTag) {
      if (!node || typeof node !== "object" || visited.has(node)) return;
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
        partitionMediaNodeIntoMainRoom(node, targetUserLower, activePhase);
        return;
      }

      for (const k of Object.keys(node)) {
        if (k === "reels_media" || k === "stories") continue;
        walk(node[k], activePhase);
      }
    }

    walk(rootObj, phaseTag);
    sendRoomProgress();
  }

  function partitionMediaNodeIntoMainRoom(item, targetUserLower, phaseTag) {
    if (item.repost_info || item.original_media_id) return;

    const ownerUsername = (item.user?.username || item.owner?.username || "").toLowerCase();
    const ownerPk = cleanPk(item.user?.pk || item.user?.id || item.owner?.id || item.owner?.pk);

    if (ownerUsername === targetUserLower && ownerPk && !mainScanState.targetUserId) {
      mainScanState.targetUserId = ownerPk;
    }

    let isTargetOwner = false;
    if (ownerUsername === targetUserLower) {
      isTargetOwner = true;
    } else if (!ownerUsername && mainScanState.targetUserId && ownerPk === mainScanState.targetUserId) {
      isTargetOwner = true;
    } else if (!ownerUsername && !ownerPk) {
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

    if (phaseTag === "posts" && shortcode) {
      mainRoom.gridUniquePosts.add(shortcode);
    }

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
      if ((slides.length === 0 || slides.length < expectedCount) && mediaPk && !mainRoom.resolvedDeepPks.has(mediaPk)) {
        mainRoom.pendingDeepResolvePks.set(mediaPk, phaseTag);
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
          if (slideIsVideo && mediaPk && !mainRoom.resolvedDeepPks.has(mediaPk)) {
            mainRoom.pendingDeepResolvePks.set(mediaPk, phaseTag);
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

        placeSlideIntoMainSection(phaseTag, shortcode, slideKey, slidePk, baseUrl, fpHash, true, mediaRecord);
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
      if (isVideoItem && mediaPk && !mainRoom.resolvedDeepPks.has(mediaPk)) {
        mainRoom.pendingDeepResolvePks.set(mediaPk, phaseTag);
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

    placeSlideIntoMainSection(phaseTag, shortcode, singleSlideKey, singlePk, baseUrl, fpHash, false, mediaRecord);
  }

  function placeSlideIntoMainSection(phaseTag, rootShortcode, slideKey, mediaPk, baseUrl, fpHash, isCarousel, mediaRecord) {
    if (phaseTag === "posts") {
      if (
        mainRoom.gridVault.has(slideKey) ||
        mainRoom.gridFingerprints.has(fpHash) ||
        mainRoom.gridMediaPks.has(mediaPk) ||
        mainRoom.gridBaseUrls.has(baseUrl)
      ) {
        return;
      }

      mainRoom.gridVault.set(slideKey, mediaRecord);
      mainRoom.gridFingerprints.add(fpHash);
      mainRoom.gridMediaPks.add(mediaPk);
      mainRoom.gridBaseUrls.add(baseUrl);
      if (!isCarousel) mainRoom.gridShortcodes.add(rootShortcode);

      if (mainRoom.reelsVault.has(slideKey)) {
        mainRoom.reelsVault.delete(slideKey);
        mainRoom.duplicateVault.set(slideKey, mediaRecord);
      }
    } else {
      if (!mainRoom.rawReelsStaging.has(slideKey)) {
        mainRoom.rawReelsStaging.set(slideKey, {
          rootShortcode,
          slideKey,
          mediaPk,
          baseUrl,
          fpHash,
          mediaRecord
        });
      }

      const existsInGridVault =
        mainRoom.gridVault.has(slideKey) ||
        mainRoom.gridShortcodes.has(rootShortcode) ||
        mainRoom.gridFingerprints.has(fpHash) ||
        mainRoom.gridMediaPks.has(mediaPk) ||
        mainRoom.gridBaseUrls.has(baseUrl);

      if (existsInGridVault) {
        mainRoom.reelsVault.delete(slideKey);
        mainRoom.duplicateVault.set(slideKey, mediaRecord);
        return;
      }

      if (mainRoom.reelsVault.has(slideKey) || mainRoom.reelsFingerprints.has(fpHash)) {
        return;
      }

      mainRoom.reelsVault.set(slideKey, mediaRecord);
      mainRoom.reelsFingerprints.add(fpHash);
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

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== "INSTASWIFT_CONTENT") return;
    const { cmd, reqId, payload } = event.data;

    if (cmd === "START_MAIN_WORLD_3ROOM_SCAN") {
      runMainWorld3RoomScan(payload.username);
    }
    else if (cmd === "STOP_MAIN_WORLD_SCAN") {
      mainScanState.stopRequested = true;
      mainScanState.isRunning = false;
    }
    else if (cmd === "FETCH_WEB_PROFILE_INFO") {
      const result = await mainWorldJsonFetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(payload.username)}`
      );
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_MEDIA_INFO") {
      const result = await mainWorldJsonFetch(
        `https://www.instagram.com/api/v1/media/${encodeURIComponent(payload.mediaPk)}/info/`
      );
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_FULL_POST_BY_SHORTCODE") {
      const { shortcode, isReel } = payload;
      const derivedPk = shortcodeToMediaPk(shortcode);
      if (derivedPk) {
        const pkRes = await mainWorldJsonFetch(
          `https://www.instagram.com/api/v1/media/${encodeURIComponent(derivedPk)}/info/`
        );
        if (pkRes.ok && pkRes.data) {
          emitToContent("CMD_RESPONSE", { reqId, result: pkRes });
          return;
        }
      }
      const path = isReel ? "reel" : "p";
      const result = await mainWorldJsonFetch(
        `https://www.instagram.com/${path}/${encodeURIComponent(shortcode)}/?__a=1&__d=dis`
      );
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_STORIES_REEL") {
      const url = new URL("https://www.instagram.com/api/v1/feed/reels_media/");
      url.searchParams.set("reel_ids", String(payload.reelId));
      const result = await mainWorldJsonFetch(url.toString());
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
  });
})();