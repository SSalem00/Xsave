// offscreen.js — runs inside the offscreen document.
// Decodes an MP4 frame-by-frame into a canvas, then encodes a GIF via gifenc.
// Lives here (not the service worker) because MV3 SWs have no DOM/video element.

import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.js";

const MAX_WIDTH = 480; // cap output to keep file size manageable

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "CONVERT_TO_GIF" || msg.target !== "offscreen") return;

  convertToDataUrl(msg.url)
    .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true; // async response
});

async function convertToDataUrl(mp4Url) {
  const frames = await decodeFrames(mp4Url);
  const gifBytes = encodeGif(frames);
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

const TARGET_FPS = 15;

async function decodeFrames(mp4Url) {
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

    const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const frameCount = Math.max(1, Math.round(duration * TARGET_FPS));
    const delayMs = Math.round(1000 / TARGET_FPS);
    const frames = [];

    for (let i = 0; i < frameCount; i++) {
      const t = (i / frameCount) * duration;
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      frames.push({ rgba: new Uint8Array(data), delayMs, w, h });
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
