// Content script: watch for tweets, inject a download button into the action bar.

const DEBUG = false;
const dlog = (...args) => DEBUG && console.log("[XSave/content]", ...args);
dlog("content script loaded");

const PROCESSED_ATTR = "data-twitterdl-processed";

// Pull the tweet ID out of any /status/<id> link inside the article.
function getTweetId(article) {
  const link = article.querySelector('a[href*="/status/"]');
  if (!link) return null;
  const match = link.href.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

// tweetPhoto covers images + video; others are fallbacks.
function hasMedia(article) {
  return (
    article.querySelector('[data-testid="tweetPhoto"]') !== null ||
    article.querySelector("video") !== null ||
    article.querySelector('[data-testid="videoComponent"]') !== null
  );
}

function createDownloadButton(tweetId) {
  const btn = document.createElement("button");
  btn.className = "twitterdl-btn";
  btn.title = "Download media";
  btn.setAttribute("aria-label", "Download media");
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M12 16l-6-6h4V4h4v6h4l-6 6zm-7 2h14v2H5v-2z"/>
    </svg>
  `;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    handleDownload(tweetId, btn);
  });

  return btn;
}

function injectButton(article, tweetId) {
  // The like/retweet/reply row.
  const actionBar = article.querySelector('[role="group"]');
  if (!actionBar) return;

  // Avoid double-injecting
  if (actionBar.querySelector(".twitterdl-btn")) return;

  const wrapper = document.createElement("div");
  wrapper.className = "twitterdl-wrapper";
  wrapper.appendChild(createDownloadButton(tweetId));

  actionBar.appendChild(wrapper);
}

async function handleDownload(tweetId, btn) {
  btn.classList.add("twitterdl-loading");

  try {
    const response = await fetchMediaInfo(tweetId);
    const items = response?.items ?? [];
    if (items.length === 0) {
      showToast("❌ Could not find downloadable media.");
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const suffix = items.length > 1 ? `_${i + 1}` : "";
      const filename = `tweet_${tweetId}${suffix}`;

      if (item.type === "animated_gif") {
        showToast("⏳ Converting to GIF…");
        await convertAndDownloadGif(item.url, filename);
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
  }
}

function fetchMediaInfo(tweetId) {
  return sendMessage({ type: "FETCH_MEDIA_URL", tweetId });
}

function triggerDownload(url, filename, ext) {
  chrome.runtime.sendMessage({ type: "DOWNLOAD_FILE", url, filename, ext });
}

function convertAndDownloadGif(url, filename) {
  return sendMessage({ type: "DOWNLOAD_AS_GIF", url, filename }).then((res) => {
    if (!res?.ok) throw new Error(res?.error ?? "Conversion failed");
  });
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
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

function processTweets() {
  // testid is X's current selector; role=article is a fallback if they rename it.
  const articles = document.querySelectorAll(
    `article[data-testid="tweet"]:not([${PROCESSED_ATTR}]),` +
    `article[role="article"]:not([${PROCESSED_ATTR}])`
  );
  if (articles.length > 0) dlog(`processTweets: ${articles.length} new candidate article(s)`);

  articles.forEach((article) => {
    if (!hasMedia(article)) return; // re-check on next mutation when video loads
    const tweetId = getTweetId(article);
    if (!tweetId) return;
    article.setAttribute(PROCESSED_ATTR, "true");
    injectButton(article, tweetId);
  });
}

// Run once on load, then watch for dynamic content
processTweets();

const observer = new MutationObserver(() => processTweets());
observer.observe(document.body, { childList: true, subtree: true });
