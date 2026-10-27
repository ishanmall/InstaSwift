(function () {
  if (window.__instaswiftV29Loaded) return;
  window.__instaswiftV29Loaded = true;

  try {
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    Object.defineProperty(document, "webkitHidden", { get: () => false, configurable: true });
    document.hasFocus = () => true;
    window.addEventListener("visibilitychange", (e) => e.stopImmediatePropagation(), true);
    window.addEventListener("blur", (e) => e.stopImmediatePropagation(), true);
  } catch (_) {}

  const IG_APP_ID = "936619743392459";

  const capturedGraphql = {
    postsDocId: "9310670392322965",
    reelsDocId: "7898261790222653",
    lsdToken: "",
    postsTemplate: "",
    reelsTemplate: ""
  };

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

  function inspectOutgoingGraphql(bodyStr) {
    try {
      if (typeof bodyStr !== "string" || !bodyStr.includes("doc_id=")) return;
      const params = new URLSearchParams(bodyStr);
      const friendly = params.get("fb_api_req_friendly_name") || "";
      const docId = params.get("doc_id") || "";
      const lsd = params.get("lsd") || "";
      const vars = params.get("variables") || "";
      if (lsd) capturedGraphql.lsdToken = lsd;
      if (docId) {
        if (friendly.includes("Posts") || friendly.includes("Timeline") || vars.includes('"username"')) {
          capturedGraphql.postsDocId = docId;
          capturedGraphql.postsTemplate = bodyStr;
        } else if (friendly.includes("Reels") || friendly.includes("Clips") || vars.includes("target_user_id")) {
          capturedGraphql.reelsDocId = docId;
          capturedGraphql.reelsTemplate = bodyStr;
        }
      }
    } catch (_) {}
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const pagePathAtStart = window.location.pathname;
    try {
      if (typeof args[1]?.body === "string") inspectOutgoingGraphql(args[1].body);
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
              emitToContent("INTERCEPTED_JSON", {
                url: reqUrl,
                pagePath: pagePathAtStart,
                payload: JSON.parse(t)
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
            emitToContent("INTERCEPTED_JSON", {
              url,
              pagePath: this.__pagePath || window.location.pathname,
              payload: JSON.parse(t)
            });
          }
        }
      } catch (_) {}
    });
    return origSend.apply(this, args);
  };

  async function mainWorldJsonFetch(url, options = {}) {
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

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== "INSTASWIFT_CONTENT") return;
    const { cmd, reqId, payload } = event.data;

    if (cmd === "FETCH_WEB_PROFILE_INFO") {
      const { username } = payload;
      const result = await mainWorldJsonFetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
      );
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_POSTS_PAGE") {
      const { username, userId, maxId } = payload;
      const baseUrl = (userId && maxId)
        ? `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/`
        : `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/`;

      const url = new URL(baseUrl);
      url.searchParams.set("count", "33");
      if (maxId) url.searchParams.set("max_id", maxId);

      const result = await mainWorldJsonFetch(url.toString());
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_REELS_PAGE") {
      const { userId, maxId } = payload;
      const body = new URLSearchParams({
        target_user_id: String(userId),
        page_size: "24",
        include_feed_video: "true"
      });
      if (maxId) body.set("max_id", maxId);

      const result = await mainWorldJsonFetch("https://www.instagram.com/api/v1/clips/user/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString()
      });
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_REELS_GRAPHQL") {
      const { userId, afterCursor } = payload;
      const variables = {
        data: {
          include_feed_video: true,
          page_size: 24,
          target_user_id: String(userId)
        }
      };
      if (afterCursor) {
        variables.after = String(afterCursor);
        variables.first = 24;
      }
      const params = new URLSearchParams(capturedGraphql.reelsTemplate || "");
      const lsd = getLsdToken();
      if (lsd) params.set("lsd", lsd);
      params.set("fb_api_req_friendly_name", "PolarisProfileReelsTabContentQuery_connection");
      params.set("variables", JSON.stringify(variables));
      params.set("server_timestamps", "true");
      params.set("doc_id", capturedGraphql.reelsDocId || "7898261790222653");

      const result = await mainWorldJsonFetch("https://www.instagram.com/graphql/query", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-fb-friendly-name": "PolarisProfileReelsTabContentQuery_connection"
        },
        body: params.toString()
      });
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_MEDIA_INFO") {
      const { mediaPk } = payload;
      const result = await mainWorldJsonFetch(`https://www.instagram.com/api/v1/media/${encodeURIComponent(mediaPk)}/info/`);
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_FULL_POST_BY_SHORTCODE") {
      const { shortcode, isReel } = payload;
      // 1. Primary: Convert shortcode to numeric MediaPK and query `/api/v1/media/{pk}/info/`
      const derivedPk = shortcodeToMediaPk(shortcode);
      if (derivedPk) {
        const pkRes = await mainWorldJsonFetch(`https://www.instagram.com/api/v1/media/${encodeURIComponent(derivedPk)}/info/`);
        if (pkRes.ok && pkRes.data) {
          emitToContent("CMD_RESPONSE", { reqId, result: pkRes });
          return;
        }
      }
      // 2. Fallback: Query GraphQL PolarisPostActionLoadPostQueryV2 or ?__a=1&__d=dis
      const path = isReel ? "reel" : "p";
      const result = await mainWorldJsonFetch(`https://www.instagram.com/${path}/${encodeURIComponent(shortcode)}/?__a=1&__d=dis`);
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_STORIES_REEL") {
      const { reelId } = payload;
      const url = new URL("https://www.instagram.com/api/v1/feed/reels_media/");
      url.searchParams.set("reel_ids", String(reelId));
      const result = await mainWorldJsonFetch(url.toString());
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
  });
})();