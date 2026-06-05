// Decode an MP4 frame-by-frame, encode a GIF with gifenc.
// Has to live in an offscreen doc because MV3 service workers can't host a <video>.

import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.js";

const DEBUG = false;
const dlog = (...args) => DEBUG && console.log("[XSave/offscreen]", ...args);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "CONVERT_TO_GIF" || msg.target !== "offscreen") return;

  const { url, tabId, tweetId, maxWidth = 480, fps = 15 } = msg;

  convertToDataUrl(url, maxWidth, fps, tabId, tweetId)
    .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true; // async response
});

async function convertToDataUrl(mp4Url, maxWidth, fps, tabId, tweetId) {
  dlog("convert start", { mp4Url, maxWidth, fps });
  const t0 = performance.now();
  const frames = await decodeFrames(mp4Url, maxWidth, fps, tabId, tweetId);
  dlog(`decoded ${frames.length} frames in ${(performance.now() - t0).toFixed(0)}ms`);

  const t1 = performance.now();
  const gifBytes = encodeGif(frames);
  dlog(`encoded GIF in ${(performance.now() - t1).toFixed(0)}ms`, { bytes: gifBytes.length });

  const blob = new Blob([gifBytes], { type: "image/gif" });
  return await blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read GIF blob"));
    reader.readAsDataURL(blob);
  });
}

function sendProgress(tabId, tweetId, progress) {
  if (!tabId) return;
  chrome.runtime.sendMessage({ type: "GIF_PROGRESS", tabId, tweetId, progress }).catch(() => {});
}

async function decodeFrames(mp4Url, maxWidth, fps, tabId, tweetId) {
  const res = await fetch(mp4Url);
  if (!res.ok) throw new Error(`MP4 fetch failed: ${res.status}`);
  const mp4Blob = await res.blob();
  const objectUrl = URL.createObjectURL(mp4Blob);

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = objectUrl;
  document.body.appendChild(video);

  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("Video failed to load"));
    });

    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      throw new Error(`Invalid video duration: ${duration}`);
    }
    dlog("video loaded", { duration, videoWidth: video.videoWidth, videoHeight: video.videoHeight });

    const scale = Math.min(1, maxWidth / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const frameCount = Math.max(1, Math.round(duration * fps));
    const delayMs = Math.round(1000 / fps);
    dlog("frame plan", { w, h, frameCount, fps });
    const frames = [];

    for (let i = 0; i < frameCount; i++) {
      const t = (i / frameCount) * duration;
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      frames.push({ rgba: new Uint8Array(data), delayMs, w, h });

      // Send progress every 3 frames to avoid flooding the message channel
      if (tabId && (i % 3 === 0 || i === frameCount - 1)) {
        sendProgress(tabId, tweetId, (i + 1) / frameCount);
      }
    }

    return frames;
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.remove();
  }
}

function seekTo(video, time) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error("Seek failed"));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = time;
  });
}

function encodeGif(frames) {
  const encoder = GIFEncoder();
  for (const frame of frames) {
    const palette = quantize(frame.rgba, 256);
    const index = applyPalette(frame.rgba, palette);
    encoder.writeFrame(index, frame.w, frame.h, {
      palette,
      delay: frame.delayMs,
    });
  }
  encoder.finish();
  return encoder.bytes();
}
