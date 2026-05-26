// background.js — service worker (MV3)
// Resolves tweet media URLs via X's public syndication endpoint
// (the same one twitter.com's embed widget uses).

// ─── Syndication token ───────────────────────────────────────────────────────
// X's syndication endpoint requires a deterministic per-tweet token computed
// from the tweet ID. This algorithm is what the embed.js widget uses.

function syndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI)
    .toString(6 ** 2)
    .replace(/(0+|\.)/g, "");
}

// ─── Media URL resolution ────────────────────────────────────────────────────

// In-memory dedupe cache: keyed by tweetId, value is the in-flight or resolved
// promise. Avoids re-hitting syndication on repeat button clicks. The Map is
// scoped to the service-worker lifetime — when the SW idles out, it's cleared
// automatically, which is fine.
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

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Syndication fetch failed: ${res.status}`);

    const json = await res.json();
    return extractBestMedia(json);
  })();

  mediaInfoCache.set(tweetId, promise);
  // Evict failures so the next click can retry instead of replaying the error.
  promise.catch(() => mediaInfoCache.delete(tweetId));
  return promise;
}

/**
 * Returns { url, type } for the first video/gif found, or null.
 * type is "video" or "animated_gif" — same vocabulary X uses internally.
 */
function extractBestMedia(json) {
  const mediaItems = json?.mediaDetails ?? [];

  for (const media of mediaItems) {
    if (media.type !== "video" && media.type !== "animated_gif") continue;

    const variants =
      media.video_info?.variants?.filter(
        (v) => v.content_type === "video/mp4"
      ) ?? [];

    if (variants.length === 0) continue;

    variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    return { url: variants[0].url, type: media.type };
  }

  return null;
}

// ─── Offscreen document (for MP4→GIF conversion) ─────────────────────────────

const OFFSCREEN_PATH = "src/offscreen.html";

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["BLOBS"], // we create blob URLs for the rendered GIF
    justification: "Decode MP4 frames and encode an animated GIF.",
  });
}

async function convertToGif(mp4Url, filename) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: "CONVERT_TO_GIF",
    target: "offscreen",
    url: mp4Url,
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "Conversion failed");
  }

  await chrome.downloads.download({
    url: response.dataUrl,
    filename: `${filename}.gif`,
    saveAs: false,
  });
}

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
