(function () {
  if (window.__instaswiftV18Loaded) return;
  window.__instaswiftV18Loaded = true;

  const IG_APP_ID = "936619743392459";

  const capturedMeta = {
    postsDocId: "9310670392322965",
    reelsDocId: "7898261790222653",
    lsdToken: "",
    wwwClaim: "0",
    asbdId: "129477",
    postsReqTemplate: "",
    reelsReqTemplate: ""
  };

  function getCsrfToken() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : "";
  }

  function getLsdToken() {
    if (capturedMeta.lsdToken) return capturedMeta.lsdToken;
    const html = document.documentElement?.innerHTML || "";
    const m =
      html.match(/["LSD",[],\{"token":"([^"]+)"\}/) ||
      html.match(/"lsd":"([^"]+)"/) ||
      html.match(/name="lsd"\s+value="([^"]+)"/);
    if (m && m[1]) capturedMeta.lsdToken = m[1];
    return capturedMeta.lsdToken;
  }

  function getSessionMeta() {
    return {
      csrfToken: getCsrfToken(),
      lsdToken: getLsdToken(),
      wwwClaim: sessionStorage.getItem("www-claim-v2") || capturedMeta.wwwClaim || "0",
      postsDocId: capturedMeta.postsDocId,
      reelsDocId: capturedMeta.reelsDocId,
      asbdId: capturedMeta.asbdId,
      postsReqTemplate: capturedMeta.postsReqTemplate,
      reelsReqTemplate: capturedMeta.reelsReqTemplate
    };
  }

  function emitToContent(type, data) {
    window.postMessage({ source: "INSTASWIFT_MAIN", type, ...data }, "*");
  }

  // Safely checks if a URL is same-origin (www.instagram.com) so CORS header warnings never trigger
  function isSameOriginIgUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return false;
    if (rawUrl.startsWith("/") && !rawUrl.startsWith("//")) return true;
    try {
      const u = new URL(rawUrl, window.location.origin);
      return u.origin === window.location.origin;
    } catch (_) {
      return false;
    }
  }

  // Extracts x-ig-set-www-claim from getAllResponseHeaders() without calling getResponseHeader() on restricted headers
  function extractSafeClaimFromXhr(xhr, reqUrl) {
    try {
      if (!isSameOriginIgUrl(reqUrl)) return null;
      const allHeaders = xhr.getAllResponseHeaders?.() || "";
      if (!allHeaders.toLowerCase().includes("x-ig-set-www-claim")) return null;
      const m = allHeaders.match(/x-ig-set-www-claim:\s*([^\r\n]+)/i);
      return m && m[1] ? m[1].trim() : null;
    } catch (_) {
      return null;
    }
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

  function inspectRequestForGraphqlMeta(url, bodyStr) {
    try {
      if (typeof bodyStr === "string" && bodyStr.includes("doc_id=")) {
        const params = new URLSearchParams(bodyStr);
        const friendly = params.get("fb_api_req_friendly_name") || "";
        const docId = params.get("doc_id") || "";
        const lsd = params.get("lsd") || "";
        const variables = params.get("variables") || "";

        if (lsd) capturedMeta.lsdToken = lsd;

        if (docId) {
          if (
            friendly.includes("PostsTab") ||
            friendly.includes("Timeline") ||
            friendly.includes("ProfilePosts") ||
            (variables.includes('"username"') && variables.includes('"count"'))
          ) {
            capturedMeta.postsDocId = docId;
            capturedMeta.postsReqTemplate = bodyStr;
          } else if (
            friendly.includes("ReelsTab") ||
            friendly.includes("Clips") ||
            (variables.includes("target_user_id") && variables.includes("page_size"))
          ) {
            capturedMeta.reelsDocId = docId;
            capturedMeta.reelsReqTemplate = bodyStr;
          }
        }
        emitToContent("META_UPDATE", { meta: getSessionMeta() });
      }
    } catch (_) {}
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const reqUrl = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
    try {
      const reqBody = args[1]?.body;
      if (typeof reqBody === "string") {
        inspectRequestForGraphqlMeta(reqUrl, reqBody);
      }
    } catch (_) {}

    const response = await origFetch.apply(this, args);
    try {
      if (isSameOriginIgUrl(reqUrl)) {
        const claim = response.headers?.get?.("x-ig-set-www-claim");
        if (claim) {
          capturedMeta.wwwClaim = claim;
          try { sessionStorage.setItem("www-claim-v2", claim); } catch (_) {}
        }
      }
      if (
        reqUrl.includes("/graphql") ||
        reqUrl.includes("/api/v1/") ||
        reqUrl.includes("query")
      ) {
        const clone = response.clone();
        clone.text().then((txt) => {
          const t = txt.trim();
          if (t.startsWith("{") || t.startsWith("[")) {
            try {
              emitToContent("INTERCEPTED_JSON", {
                url: reqUrl,
                payload: JSON.parse(t),
                meta: getSessionMeta()
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
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (typeof args[0] === "string") {
        inspectRequestForGraphqlMeta(this.__isUrl || "", args[0]);
      }
    } catch (_) {}

    this.addEventListener("load", function () {
      try {
        const url = this.__isUrl || "";
        // FIXED: Never call this.getResponseHeader("x-ig-set-www-claim") directly!
        const claim = extractSafeClaimFromXhr(this, url);
        if (claim) {
          capturedMeta.wwwClaim = claim;
          try { sessionStorage.setItem("www-claim-v2", claim); } catch (_) {}
        }

        if (url.includes("/graphql") || url.includes("/api/v1/") || url.includes("query")) {
          const t = (this.responseText || "").trim();
          if (t.startsWith("{") || t.startsWith("[")) {
            emitToContent("INTERCEPTED_JSON", {
              url,
              payload: JSON.parse(t),
              meta: getSessionMeta()
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
      const csrf = getCsrfToken();
      const claim = sessionStorage.getItem("www-claim-v2") || capturedMeta.wwwClaim || "0";

      const headers = {
        "x-ig-app-id": IG_APP_ID,
        "x-csrftoken": csrf,
        "x-requested-with": "XMLHttpRequest",
        "x-asbd-id": capturedMeta.asbdId || "129477",
        "x-ig-www-claim": claim,
        "accept": "*/*",
        ...(options.headers || {})
      };
      if (lsd) headers["x-fb-lsd"] = lsd;

      const fetchOpts = {
        method: options.method || "GET",
        headers,
        credentials: "include"
      };
      if (options.body) fetchOpts.body = options.body;

      const res = await origFetch(url, fetchOpts);
      if (isSameOriginIgUrl(url)) {
        const newClaim = res.headers?.get?.("x-ig-set-www-claim");
        if (newClaim) {
          capturedMeta.wwwClaim = newClaim;
          try { sessionStorage.setItem("www-claim-v2", newClaim); } catch (_) {}
        }
      }

      if (!res.ok) return { ok: false, status: res.status, data: null };
      const txt = (await res.text()).trim();
      if (!txt.startsWith("{") && !txt.startsWith("[")) {
        return { ok: false, status: res.status, data: null };
      }
      return { ok: true, status: res.status, data: JSON.parse(txt), meta: getSessionMeta() };
    } catch (err) {
      return { ok: false, status: 0, error: String(err), data: null };
    }
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== "INSTASWIFT_CONTENT") return;
    const { cmd, reqId, payload } = event.data;

    if (cmd === "GET_SESSION_META") {
      emitToContent("CMD_RESPONSE", { reqId, result: { ok: true, meta: getSessionMeta() } });
    }
    else if (cmd === "MAIN_WORLD_FETCH") {
      const { url, options } = payload;
      const result = await mainWorldJsonFetch(url, options || {});
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_WEB_PROFILE_INFO") {
      const { username } = payload;
      const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
      const result = await mainWorldJsonFetch(url);
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_MEDIA_INFO") {
      const { mediaPk } = payload;
      const result = await mainWorldJsonFetch(`https://www.instagram.com/api/v1/media/${encodeURIComponent(mediaPk)}/info/`);
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_FULL_POST_BY_SHORTCODE") {
      const { shortcode, isReel } = payload;
      const derivedPk = shortcodeToMediaPk(shortcode);
      if (derivedPk) {
        const pkRes = await mainWorldJsonFetch(`https://www.instagram.com/api/v1/media/${encodeURIComponent(derivedPk)}/info/`);
        if (pkRes.ok && pkRes.data) {
          emitToContent("CMD_RESPONSE", { reqId, result: pkRes });
          return;
        }
      }
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