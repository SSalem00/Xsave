// MV3 service worker. Resolves tweet media URLs via the public syndication endpoint.

const DEBUG = false;
const dlog = (...args) => DEBUG && console.log("[Xdownloader/bg]", ...args);

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
    return extractBestMedia(json);
  })();

  mediaInfoCache.set(tweetId, promise);
  // Drop failed entries so retries actually re-fetch.
  promise.catch(() => mediaInfoCache.delete(tweetId));
  return promise;
}

// Returns {url, type} or null if no video/gif. Throws if the response shape
// doesn't match what we expect (canary for API changes).
function extractBestMedia(json) {
  if (!json || typeof json !== "object") {
    throw new Error("Syndication response not JSON-shaped");
  }
  if (!Array.isArray(json.mediaDetails)) {
    throw new Error("mediaDetails missing or not an array");
  }

  for (const media of json.mediaDetails) {
    if (media.type !== "video" && media.type !== "animated_gif") continue;

    const variants =
      media.video_info?.variants?.filter(
        (v) => v.content_type === "video/mp4"
      ) ?? [];

    if (variants.length === 0) continue;

    variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    const picked = variants[0];
    dlog("picked variant", { type: media.type, bitrate: picked.bitrate, url: picked.url });
    return { url: picked.url, type: media.type };
  }

  dlog("no video/animated_gif media found in tweet");
  return null;
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
      .then((info) => sendResponse(info ? info : { url: null }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "DOWNLOAD_FILE") {
    chrome.downloads
      .download({
        url: message.url,
        filename: `${message.filename}.mp4`,
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
