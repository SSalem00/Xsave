# Xdownloader

A small Chrome/Brave extension that adds a download button to tweets with video or GIFs.

The one thing it does that most don't: Twitter "GIFs" are actually MP4s, and most downloaders just give you that MP4. This one re-encodes them into a real `.gif` file so what you save is what you'd expect.

No third-party sites, no login, no tracking.

## Install

1. Download the repo — either click the green **Code** button → **Download ZIP** and unzip it, or:
   ```
   git clone https://github.com/SSalem00/Xdownloader.git
   ```
   Keep the folder somewhere permanent. The browser loads files from it directly.

2. Go to `chrome://extensions` (or `brave://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder you just downloaded (the one with `manifest.json`).

Open twitter.com or x.com and you'll see a **↓** button on any tweet with video or a GIF.

## Notes

- Won't work on private/protected tweets.
- GIF output is capped at 480px wide / 15fps so files don't get huge. Long videos converted to GIF will still be chunky.
- If you update the code later, hit the ↻ refresh icon on the extension card.
- Uses X's public-facing syndication endpoint (the same one the embed widget uses). For personal use — respect X's Terms of Service.

## Stack

Plain JS, MV3, no build step. Uses X's public syndication endpoint for media URLs and [gifenc](https://github.com/mattdesl/gifenc) for the GIF encoding (runs in an offscreen document since MV3 service workers can't touch the DOM).
