// Content script: watch for tweets, inject a download button into the action bar.

const DEBUG = false;
const dlog = (...args) => DEBUG && console.log("[XSave/content]", ...args);
dlog("content script loaded");

const PROCESSED_ATTR = "data-twitterdl-processed";

const BTN_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
  <path d="M12 16l-6-6h4V4h4v6h4l-6 6zm-7 2h14v2H5v-2z"/>
</svg>`;

// Map from tweetId → button element, for updating progress during GIF conversion
const activeGifDownloads = new Map();

// Pull the tweet ID out of any /status/<id> link inside the article.
function getTweetId(article) {
  const link = article.querySelector('a[href*="/status/"]');
  if (!link) return null;
  const match = link.href.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function getTweetUsername(article) {
  const link = article.querySelector('a[href*="/status/"]');
  if (!link) return "";
  const match = link.href.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\//);
  return match ? match[1] : "";
}

// tweetPhoto covers images + video; others are fallbacks.
function hasMedia(article) {
  return (
    article.querySelector('[data-testid="tweetPhoto"]') !== null ||
    article.querySelector("video") !== null ||
    article.querySelector('[data-testid="videoComponent"]') !== null
  );
}

function createDownloadButton(tweetId, article) {
  const btn = document.createElement("button");
  btn.className = "twitterdl-btn";
  btn.title = "Download media";
  btn.setAttribute("aria-label", "Download media");
  btn.innerHTML = BTN_SVG;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    handleDownload(tweetId, btn, article);
  });

  return btn;
}

function injectButton(article, tweetId) {
  const actionBar = article.querySelector('[role="group"]');
  if (!actionBar) return;

  if (actionBar.querySelector(".twitterdl-btn")) return;

  const wrapper = document.createElement("div");
  wrapper.className = "twitterdl-wrapper";
  wrapper.appendChild(createDownloadButton(tweetId, article));

  actionBar.appendChild(wrapper);
}

// Fallback: pull media URLs directly from the rendered DOM when syndication
// doesn't have the tweet (tombstone, recent tweet not yet indexed, etc.).
function extractMediaFromDom(article) {
  const items = [];

  const video = article.querySelector("video");
  if (video) {
    const src = video.src || video.querySelector("source")?.src || "";
    if (src && !src.startsWith("blob:")) {
      const isGif = src.includes("video.twimg.com/tweet_video/");
      items.push({ type: isGif ? "animated_gif" : "video", url: src });
    }
  }

  article.querySelectorAll('[data-testid="tweetPhoto"] img').forEach((img) => {
    if (!img.src || img.src.startsWith("blob:")) return;
    const base = img.src.split("?")[0];
    const extMatch = base.match(/\.([a-z0-9]+)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
    items.push({ type: "photo", url: `${base}?name=orig`, ext });
  });

  dlog("DOM fallback items", items);
  return items;
}

// --- Settings ---

const DEFAULT_SETTINGS = {
  gifEnabled: true,
  gifQuality: "medium",
  filenameTemplate: "{username}_{tweetid}",
};

let settingsCache = null;

function getSettings() {
  if (settingsCache) return Promise.resolve(settingsCache);
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (result) => {
      settingsCache = result;
      resolve(result);
    });
  });
}

chrome.storage.onChanged.addListener(() => { settingsCache = null; });

// --- Filename templating ---

function buildFilename(template, { username, tweetId, type, index, total }) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const typeStr = type === "animated_gif" ? "gif" : type;

  let name = template
    .replace(/{username}/g, username || "unknown")
    .replace(/{tweetid}/g, tweetId)
    .replace(/{date}/g, date)
    .replace(/{type}/g, typeStr)
    .replace(/{index}/g, total > 1 ? String(index + 1) : "");

  // If multiple media and template doesn't include {index}, append a suffix
  if (total > 1 && !template.includes("{index}")) {
    name += `_${index + 1}`;
  }

  // Sanitize filesystem-unsafe characters and clean up extra underscores
  return name
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "");
}

// --- Download handler ---

async function handleDownload(tweetId, btn, article) {
  btn.classList.add("twitterdl-loading");

  try {
    const [response, settings] = await Promise.all([
      fetchMediaInfo(tweetId),
      getSettings(),
    ]);

    let items = response?.items ?? [];
    if (items.length === 0 && article) {
      items = extractMediaFromDom(article);
    }
    if (items.length === 0) {
      showToast("❌ Could not find downloadable media.");
      return;
    }

    const username = getTweetUsername(article);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const filename = buildFilename(settings.filenameTemplate, {
        username,
        tweetId,
        type: item.type,
        index: i,
        total: items.length,
      });

      if (item.type === "animated_gif") {
        showToast("⏳ Converting to GIF…");
        activeGifDownloads.set(tweetId, btn);
        btn.classList.remove("twitterdl-loading");
        try {
          await convertAndDownloadGif(item.url, filename, tweetId);
        } finally {
          activeGifDownloads.delete(tweetId);
          restoreButton(btn);
        }
      } else if (item.type === "video") {
        triggerDownload(item.url, filename, "mp4");
      } else if (item.type === "photo") {
        triggerDownload(item.url, filename, item.ext);
      }
    }

    btn.classList.add("twitterdl-done");
    setTimeout(() => btn.classList.remove("twitterdl-done"), 2000);
  } catch (err) {
    console.error("[XSave]", err);
    showToast(`❌ ${err?.message ?? "Download failed"}`);
  } finally {
    btn.classList.remove("twitterdl-loading");
    btn.classList.remove("twitterdl-progress");
  }
}

function restoreButton(btn) {
  btn.innerHTML = BTN_SVG;
  btn.classList.remove("twitterdl-progress");
  btn.style.fontSize = "";
}

// --- GIF progress listener ---

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "GIF_PROGRESS") return;
  const btn = activeGifDownloads.get(msg.tweetId);
  if (!btn) return;
  const pct = Math.round(msg.progress * 100);
  btn.classList.add("twitterdl-progress");
  btn.innerHTML = `<span class="twitterdl-pct">${pct}%</span>`;
});

// --- Messaging helpers ---

function fetchMediaInfo(tweetId) {
  return sendMessage({ type: "FETCH_MEDIA_URL", tweetId });
}

function triggerDownload(url, filename, ext) {
  chrome.runtime.sendMessage({ type: "DOWNLOAD_FILE", url, filename, ext });
}

function convertAndDownloadGif(url, filename, tweetId) {
  return sendMessage({ type: "DOWNLOAD_AS_GIF", url, filename, tweetId }).then((res) => {
    if (!res?.ok) throw new Error(res?.error ?? "Conversion failed");
  });
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    if (!chrome.runtime?.id) {
      reject(new Error("Reload the page to reconnect the extension."));
      return;
    }
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

function showToast(message) {
  const existing = document.getElementById("twitterdl-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "twitterdl-toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

// --- Tweet scanning ---

function processTweets() {
  const articles = document.querySelectorAll(
    `article[data-testid="tweet"]:not([${PROCESSED_ATTR}]),` +
    `article[role="article"]:not([${PROCESSED_ATTR}])`
  );
  if (articles.length > 0) dlog(`processTweets: ${articles.length} new candidate article(s)`);

  articles.forEach((article) => {
    if (!hasMedia(article)) return;
    const tweetId = getTweetId(article);
    if (!tweetId) return;
    article.setAttribute(PROCESSED_ATTR, "true");
    injectButton(article, tweetId);
  });
}

processTweets();

const observer = new MutationObserver(() => processTweets());
observer.observe(document.body, { childList: true, subtree: true });

const orphanCheck = setInterval(() => {
  if (chrome.runtime?.id) return;
  clearInterval(orphanCheck);
  observer.disconnect();
  document.querySelectorAll(".twitterdl-wrapper").forEach((el) => el.remove());
  document
    .querySelectorAll(`[${PROCESSED_ATTR}]`)
    .forEach((el) => el.removeAttribute(PROCESSED_ATTR));
}, 1000);
