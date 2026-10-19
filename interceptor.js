(function () {
  if (window.__instaswiftV10Loaded) return;
  window.__instaswiftV10Loaded = true;

  const IG_APP_ID = "936619743392459";

  const graphqlCapture = {
    postsDocId: "9310670392322965",
    reelsDocId: "7898261790222653",
    lsdToken: ""
  };

  function getCsrfToken() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : "";
  }

  function getLsdToken() {
    if (graphqlCapture.lsdToken) return graphqlCapture.lsdToken;
    const html = document.documentElement?.innerHTML || "";
    const m = html.match(/\["LSD",\[\],\{"token":"([^"]+)"\}/) || html.match(/"lsd":"([^"]+)"/);
    if (m && m[1]) graphqlCapture.lsdToken = m[1];
    return graphqlCapture.lsdToken;
  }

  function emitToContent(type, data) {
    window.postMessage({ source: "INSTASWIFT_MAIN", type, ...data }, "*");
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
      if (!bodyStr && url.includes("doc_id=")) {
        const u = new URL(url, location.origin);
        const docId = u.searchParams.get("doc_id");
        const vars = u.searchParams.get("variables") || "";
        if (docId && vars.includes("username")) {
          graphqlCapture.postsDocId = docId;
        }
      }
      if (typeof bodyStr === "string" && bodyStr.includes("doc_id=")) {
        const params = new URLSearchParams(bodyStr);
        const friendly = params.get("fb_api_req_friendly_name") || "";
        const docId = params.get("doc_id") || "";
        const lsd = params.get("lsd") || "";
        if (lsd) graphqlCapture.lsdToken = lsd;
        if (docId) {
          if (friendly.includes("PostsTab") || friendly.includes("Timeline")) {
            graphqlCapture.postsDocId = docId;
          } else if (friendly.includes("ReelsTab") || friendly.includes("Clips")) {
            graphqlCapture.reelsDocId = docId;
          }
        }
      }
    } catch (_) {}
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const reqUrl = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
      const reqBody = args[1]?.body;
      if (typeof reqBody === "string") {
        inspectRequestForGraphqlMeta(reqUrl, reqBody);
      } else {
        inspectRequestForGraphqlMeta(reqUrl, "");
      }
    } catch (_) {}

    const response = await origFetch.apply(this, args);
    try {
      const reqUrl = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
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
              emitToContent("INTERCEPTED_JSON", { url: reqUrl, payload: JSON.parse(t) });
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
        if (url.includes("/graphql") || url.includes("/api/v1/") || url.includes("query")) {
          const t = (this.responseText || "").trim();
          if (t.startsWith("{") || t.startsWith("[")) {
            emitToContent("INTERCEPTED_JSON", { url, payload: JSON.parse(t) });
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
        return { ok: false, status: res.status, data: null };
      }
      return { ok: true, status: res.status, data: JSON.parse(txt) };
    } catch (_) {
      return { ok: false, status: 0, data: null };
    }
  }

  async function fetchPostsViaGraphqlConnection(username, afterCursor) {
    const variables = {
      data: {
        count: 12,
        include_relationship_info: true,
        latest_besties_reel_media: true,
        latest_reel_media: true
      },
      username: String(username),
      __relay_internal__pv__PolarisIsLoggedInrelayprovider: true,
      __relay_internal__pv__PolarisShareSheetV3relayprovider: true
    };
    if (afterCursor) {
      variables.after = String(afterCursor);
      variables.first = 12;
      variables.last = null;
      variables.before = null;
    }

    const body = new URLSearchParams();
    const lsd = getLsdToken();
    if (lsd) body.set("lsd", lsd);
    body.set("fb_api_req_friendly_name", "PolarisProfilePostsTabContentQuery_connection");
    body.set("variables", JSON.stringify(variables));
    body.set("server_timestamps", "true");
    body.set("doc_id", graphqlCapture.postsDocId);

    const postRes = await mainWorldJsonFetch("https://www.instagram.com/graphql/query", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": "PolarisProfilePostsTabContentQuery_connection"
      },
      body: body.toString()
    });

    if (postRes.ok && postRes.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection) {
      return postRes;
    }

    const getUrl = new URL("https://www.instagram.com/graphql/query/");
    getUrl.searchParams.set("doc_id", graphqlCapture.postsDocId);
    getUrl.searchParams.set("variables", JSON.stringify(variables));
    return await mainWorldJsonFetch(getUrl.toString());
  }

  async function convertImageFormatInMainWorld(url, targetFormat) {
    try {
      const res = await origFetch(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (targetFormat === "jpg") {
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(bitmap, 0, 0);
      const mime = targetFormat === "png" ? "image/png" : "image/jpeg";
      const dataUrl = canvas.toDataURL(mime, 0.96);
      if (!dataUrl || !dataUrl.startsWith(`data:${mime}`)) return null;
      return dataUrl;
    } catch (_) {
      return null;
    }
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== "INSTASWIFT_CONTENT") return;
    const { cmd, reqId, payload } = event.data;

    if (cmd === "FETCH_WEB_PROFILE_INFO") {
      const { username } = payload;
      const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
      const result = await mainWorldJsonFetch(url);
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_POSTS_GRAPHQL") {
      const { username, afterCursor } = payload;
      const result = await fetchPostsViaGraphqlConnection(username, afterCursor);
      emitToContent("CMD_RESPONSE", { reqId, result });
    }
    else if (cmd === "FETCH_POSTS_REST") {
      const { username, userId, maxId } = payload;
      let url;
      if (userId) {
        url = new URL(`https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/`);
      } else {
        url = new URL(`https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/`);
      }
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
    else if (cmd === "CONVERT_IMAGE_DATAURL") {
      const { url, format } = payload;
      const dataUrl = await convertImageFormatInMainWorld(url, format);
      emitToContent("CMD_RESPONSE", { reqId, result: { ok: Boolean(dataUrl), dataUrl } });
    }
  });
})();