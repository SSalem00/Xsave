# XSave

A Chromium based extension that adds a download button to tweets with video, GIFs, or images.

**Everything happens on your device.** No data is sent to any server. No third-party sites. No accounts. The media goes directly from X to your computer — XSave never touches it.

The one thing it does that most don't: Twitter "GIFs" are actually MP4s, and most downloaders just give you that MP4 file, or redirect you to EzGIF to convert it yourself. XSave re-encodes them into a real `.gif` right in your browser, with no upload, no waiting, no extra steps.

## Privacy

XSave collects no data whatsoever. It makes no requests to any server other than X's own CDN to fetch the media you clicked. All GIF encoding happens locally using an in-browser encoder. Nothing you download is ever seen by anyone but you. See [PRIVACY.md](PRIVACY.md).

## Install

1. Download the repo — either click the green **Code** button → **Download ZIP** and unzip it, or:
   ```
   git clone https://github.com/SSalem00/Xsave.git
   ```
   Keep the folder somewhere permanent. The browser loads files from it directly.

2. Go to `chrome://extensions`
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder you just downloaded (the one with `manifest.json`).

Open twitter.com or x.com and you'll see a **↓** button on any tweet with video, GIFs, or images.

## Notes

- Won't work on private/protected tweets.
- GIF output is capped at 480px wide / 15fps so files don't get huge. Long videos converted to GIF will still be chunky.
- Uses X's public-facing syndication endpoint (the same one the embed widget uses). For personal use — respect X's Terms of Service.

![Download button on a tweet](https://raw.githubusercontent.com/SSalem00/assets/main/screenshot.png)

## Stack

Plain JS, MV3, no build step. Uses X's public syndication endpoint for media URLs and [gifenc](https://github.com/mattdesl/gifenc) for the GIF encoding (runs in an offscreen document since MV3 service workers can't touch the DOM).
