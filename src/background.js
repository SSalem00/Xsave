// MV3 service worker. Resolves tweet media URLs via the public syndication endpoint.

const DEBUG = false;
const dlog = (...args) => DEBUG && console.log("[XSave/bg]", ...args);

// Token algorithm copied from twitter's embed.js.
function syndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI)
    .toString(6 ** 2)
    .replace(/(0+|\.)/g, "");
}

// Dedupe in-flight + resolved calls so repeat clicks don't re-hit syndication.
const mediaInfoCache = new Map();

function fetchMediaInfo(tweetId) {
  if (mediaInfoCache.has(tweetId)) {
    return mediaInfoCache.get(tweetId);
  }

  const promise = (async () => {
    const token = syndicationToken(tweetId);
    const url =
      `https://cdn.syndication.twimg.com/tweet-result` +
      `?id=${tweetId}&token=${token}&lang=en`;
    dlog("syndication request", { tweetId, token, url });

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    dlog("syndication response", { tweetId, status: res.status, ok: res.ok });
    if (!res.ok) throw new Error(`Syndication fetch failed: ${res.status}`);

    const json = await res.json();
    dlog("mediaDetails", json?.mediaDetails);
    return extractAllMedia(json);
  })();

  mediaInfoCache.set(tweetId, promise);
  // Drop failed entries so retries actually re-fetch.
  promise.catch(() => mediaInfoCache.delete(tweetId));
  return promise;
}

// Returns {type, url, ext?} items. Throws if the response shape is unexpected.
function extractAllMedia(json) {
  if (!json || typeof json !== "object") {
    throw new Error("Syndication response not JSON-shaped");
  }
  if (!Array.isArray(json.mediaDetails)) {
    throw new Error("mediaDetails missing or not an array");
  }

  const items = [];
  for (const media of json.mediaDetails) {
    if (media.type === "video" || media.type === "animated_gif") {
      const variants =
        media.video_info?.variants?.filter(
          (v) => v.content_type === "video/mp4"
        ) ?? [];
      if (variants.length === 0) continue;
      variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      items.push({ type: media.type, url: variants[0].url });
    } else if (media.type === "photo") {
      const baseUrl = media.media_url_https;
      if (!baseUrl) continue;
      const extMatch = baseUrl.match(/\.([a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
      items.push({ type: "photo", url: `${baseUrl}?name=orig`, ext });
    }
  }

  dlog("extracted media", items);
  return items;
}

const OFFSCREEN_PATH = "src/offscreen.html";

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["BLOBS"],
    justification: "Decode MP4 frames and encode an animated GIF.",
  });
}

async function convertToGif(mp4Url, filename) {
  dlog("convertToGif start", { mp4Url, filename });
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: "CONVERT_TO_GIF",
    target: "offscreen",
    url: mp4Url,
  });
  dlog("convertToGif response", { ok: response?.ok, error: response?.error });
  if (!response?.ok) {
    throw new Error(response?.error ?? "Conversion failed");
  }

  await chrome.downloads.download({
    url: response.dataUrl,
    filename: `${filename}.gif`,
    saveAs: false,
  });
  dlog("convertToGif download dispatched", { filename });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  dlog("message received", message?.type);
  if (message.type === "FETCH_MEDIA_URL") {
    fetchMediaInfo(message.tweetId)
      .then((items) => sendResponse({ items: items ?? [] }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "DOWNLOAD_FILE") {
    chrome.downloads
      .download({
        url: message.url,
        filename: `${message.filename}.${message.ext || "mp4"}`,
        saveAs: false,
      })
      .then((id) => sendResponse({ id }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "DOWNLOAD_AS_GIF") {
    convertToGif(message.url, message.filename)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
