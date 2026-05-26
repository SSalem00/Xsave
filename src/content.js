// content.js — injected into twitter.com / x.com
// Watches for tweets to appear in the DOM, then injects a download button.
console.log("[Xdownloader] content script loaded ✅");

const PROCESSED_ATTR = "data-twitterdl-processed";

// ─── Utility ────────────────────────────────────────────────────────────────

/**
 * Extract the tweet ID from the current URL or a tweet article element.
 * Twitter embeds the ID in permalinks like /user/status/1234567890
 */
function getTweetId(article) {
  const link = article.querySelector('a[href*="/status/"]');
  if (!link) return null;
  const match = link.href.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Check whether a tweet article contains video or GIF media.
 * Twitter renders GIFs as looping <video> tags, same as regular videos.
 */
function hasMedia(article) {
  return (
    article.querySelector("video") !== null ||
    article.querySelector('[data-testid="videoComponent"]') !== null ||
    article.querySelector('[data-testid="tweetPhoto"] video') !== null
  );
}

// ─── Button injection ────────────────────────────────────────────────────────

function createDownloadButton(tweetId) {
  const btn = document.createElement("button");
  btn.className = "twitterdl-btn";
  btn.title = "Download video / GIF";
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
  // Twitter's action bar (like, retweet, reply row) — find it by test ID
  const actionBar = article.querySelector('[role="group"]');
  if (!actionBar) return;

  // Avoid double-injecting
  if (actionBar.querySelector(".twitterdl-btn")) return;

  const wrapper = document.createElement("div");
  wrapper.className = "twitterdl-wrapper";
  wrapper.appendChild(createDownloadButton(tweetId));

  actionBar.appendChild(wrapper);
}

// ─── Download logic ──────────────────────────────────────────────────────────

async function handleDownload(tweetId, btn) {
  btn.classList.add("twitterdl-loading");

  try {
    const info = await fetchMediaInfo(tweetId);
    if (!info?.url) {
      showToast("❌ Could not find downloadable media.");
      return;
    }

    const filename = `tweet_${tweetId}`;
    if (info.type === "animated_gif") {
      showToast("⏳ Converting to GIF…");
      await convertAndDownloadGif(info.url, filename);
    } else {
      triggerDownload(info.url, filename);
    }

    btn.classList.add("twitterdl-done");
    setTimeout(() => btn.classList.remove("twitterdl-done"), 2000);
  } catch (err) {
    console.error("[Xdownloader]", err);
    showToast("❌ Download failed. See console for details.");
  } finally {
    btn.classList.remove("twitterdl-loading");
  }
}

/**
 * Ask the background service worker to resolve media info ({ url, type })
 * for a given tweet via the X syndication endpoint.
 */
function fetchMediaInfo(tweetId) {
  return sendMessage({ type: "FETCH_MEDIA_URL", tweetId });
}

function triggerDownload(url, filename) {
  chrome.runtime.sendMessage({ type: "DOWNLOAD_FILE", url, filename });
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

// ─── Toast notification ──────────────────────────────────────────────────────

function showToast(message) {
  const existing = document.getElementById("twitterdl-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "twitterdl-toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

// ─── MutationObserver — watch for new tweets ─────────────────────────────────

function processTweets() {
  // Primary selector is the data-testid X currently ships. The role=article
  // fallback catches the case where they rename or drop the testid — querySelectorAll
  // dedupes elements that match both, so listing both is safe.
  const articles = document.querySelectorAll(
    `article[data-testid="tweet"]:not([${PROCESSED_ATTR}]),` +
    `article[role="article"]:not([${PROCESSED_ATTR}])`
  );

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
