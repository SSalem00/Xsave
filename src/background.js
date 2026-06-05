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
  promise.catch(() => mediaInfoCache.delete(tweetId));
  return promise;
}

function extractAllMedia(json) {
  if (!json || typeof json !== "object") {
    throw new Error("Syndication response not JSON-shaped");
  }
  if (json.__typename === "TweetTombstone") {
    return [];
  }
  if (!json.mediaDetails) return [];
  if (!Array.isArray(json.mediaDetails)) {
    throw new Error("Unexpected mediaDetails shape in syndication response");
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

// --- Settings ---

const DEFAULT_SETTINGS = {
  gifEnabled: true,
  gifQuality: "medium",
  filenameTemplate: "{username}_{tweetid}",
};

const QUALITY_PRESETS = {
  low:    { maxWidth: 360, fps: 10 },
  medium: { maxWidth: 480, fps: 15 },
  high:   { maxWidth: 720, fps: 24 },
};

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, resolve);
  });
}

// --- GIF conversion ---

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

async function convertToGif(mp4Url, filename, tabId, tweetId) {
  dlog("convertToGif start", { mp4Url, filename });
  const settings = await getSettings();
  const quality = QUALITY_PRESETS[settings.gifQuality] ?? QUALITY_PRESETS.medium;

  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: "CONVERT_TO_GIF",
    target: "offscreen",
    url: mp4Url,
    tabId,
    tweetId,
    maxWidth: quality.maxWidth,
    fps: quality.fps,
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

// --- Context menus ---

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "xsave-image",
      title: "Save with XSave",
      contexts: ["image"],
      documentUrlPatterns: ["https://twitter.com/*", "https://x.com/*"],
    });
    chrome.contextMenus.create({
      id: "xsave-video",
      title: "Save with XSave",
      contexts: ["video"],
      documentUrlPatterns: ["https://twitter.com/*", "https://x.com/*"],
    });
  });
}

chrome.runtime.onInstalled.addListener(createContextMenus);
chrome.runtime.onStartup.addListener(createContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const srcUrl = info.srcUrl;
  if (!srcUrl) return;

  if (info.menuItemId === "xsave-image") {
    const base = srcUrl.split("?")[0];
    const extMatch = base.match(/\.([a-z0-9]+)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
    chrome.downloads.download({ url: `${base}?name=orig`, filename: `xsave_${Date.now()}.${ext}` });
  }

  if (info.menuItemId === "xsave-video") {
    const isGif = srcUrl.includes("video.twimg.com/tweet_video/");
    const filename = `xsave_${Date.now()}`;
    if (isGif) {
      convertToGif(srcUrl, filename, tab?.id, null).catch((err) =>
        dlog("context menu GIF convert error", err)
      );
    } else {
      chrome.downloads.download({ url: srcUrl, filename: `${filename}.mp4` });
    }
  }
});

// --- Message handler ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  dlog("message received", message?.type);

  // Progress relay: offscreen → background → content script
  if (message.type === "GIF_PROGRESS" && message.tabId) {
    chrome.tabs.sendMessage(message.tabId, {
      type: "GIF_PROGRESS",
      tweetId: message.tweetId,
      progress: message.progress,
    }).catch(() => {});
    return;
  }

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
    const tabId = sender.tab?.id;
    getSettings().then((settings) => {
      if (!settings.gifEnabled) {
        chrome.downloads.download({
          url: message.url,
          filename: `${message.filename}.mp4`,
          saveAs: false,
        });
        sendResponse({ ok: true });
        return;
      }
      convertToGif(message.url, message.filename, tabId, message.tweetId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    });
    return true;
  }
});
