# YouTube Downloader — Chrome Extension (Manifest V3)

A modern, self-contained Chrome extension that lets you download YouTube videos (MP4) and audio (M4A/AAC) directly from the browser. No external APIs, no redirects to converter sites.

---

## Features

- **Contextual Activation** — Extension icon is only active on `youtube.com/watch` and `youtube.com/shorts`.
- **Dark Mode UI** — Clean, modern popup with Tailwind-inspired design.
- **Video Download** — Up to 1080p MP4 (with client-side muxing for adaptive streams).
- **Audio Download** — AAC audio at various bitrates (128 / 192 / 320 kbps).
- **Signature Deciphering** — Automatic extraction and application of YouTube's cipher function.
- **N-Parameter Transform** — Sandboxed eval of YouTube's throttle-avoidance function for full-speed downloads.
- **Clean Filenames** — Files saved as `[Video Title] - [Quality].mp4` or `.m4a`.

---

## Installation

### Option 1: Download as ZIP (Easiest)
1. Go to https://github.com/nocyb/youtube-chrome-dl
2. Click the green **Code** button
3. Select **Download ZIP**
4. Extract the ZIP to a folder on your computer
5. Continue to "How to Load in Developer Mode" below

### Option 2: Clone with Git
```bash
git clone https://github.com/nocyb/youtube-chrome-dl.git
cd youtube-chrome-dl
```
Then continue to "How to Load in Developer Mode" below

---

## How to Load in Developer Mode

1. **Open Chrome Extensions**:
   - Navigate to `chrome://extensions/`
   - Or: Menu → More Tools → Extensions

2. **Enable Developer Mode**:
   - Toggle the **Developer mode** switch in the top-right corner.

3. **Load the Extension**:
   - Click **"Load unpacked"**.
   - A file dialog will open. Navigate to where you saved/extracted the folder.
   - Select the **`youtube-chrome-dl`** folder (the one containing `manifest.json`).
   - Click **Open** — the extension loads immediately.

4. **Pin the Extension** (optional):
   - Click the puzzle piece icon in Chrome's toolbar.
   - Pin "YouTube Downloader" for easy access.

5. **Use It**:
   - Navigate to any YouTube video (`/watch` or `/shorts`).
   - Click the extension icon.
   - Choose quality and click **Download MP4** or **Download Audio**.

---

## Project Structure

```
youtube-chrome-dl/
├── manifest.json            # MV3 manifest with permissions & CSP
├── background.js            # Service worker — orchestrates downloads
├── content.js               # Content script — extracts video data from YouTube
├── popup.html               # Popup UI
├── popup.css                # Dark-mode styles
├── popup.js                 # Popup logic & format selection
├── offscreen.html           # Offscreen document (sandbox relay + muxer)
├── offscreen.js             # Offscreen logic — sandbox communication & MP4 muxing
├── sandbox.html             # Sandboxed page (allows eval)
├── sandbox.js               # Executes YouTube's cipher functions in isolation
├── utils/
│   └── extractor.js         # Signature decipher & n-parameter extraction
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── generate-icons.html  # Browser-based icon generator
├── generate-icons.js        # Node.js icon generator script
└── README.md
```

---

## Architecture

### Data Flow

```
YouTube Page                  Content Script          Background (SW)          Popup
─────────────                 ──────────────          ───────────────          ─────
 ytInitialPlayerResponse ──→  extractData()      ←── getVideoInfo()     ←── User clicks icon
 player.js URL          ──→       │                      │
                                  └──────────────────→   │
                                                         ├─ Fetch player.js
                                                         ├─ Parse decipher ops (native)
                                                         ├─ Load n-transform (→ sandbox)
                                                         ├─ Resolve stream URLs
                                                         └──────────────────────→  Display formats
                                                                                      │
                                                    download()  ←──────────────────────┘
                                                         │
                                                         ├─ ≤720p: chrome.downloads (direct)
                                                         └─ 1080p: offscreen mux → download
```

### Signature Deciphering

YouTube obfuscates stream URLs with a signature cipher. The decipher function in `player.js` applies a series of simple array operations:

| Operation | Description                                   |
|-----------|-----------------------------------------------|
| `swap`    | Swap first element with element at index `b%len` |
| `reverse` | Reverse the array                             |
| `splice`  | Remove the first `b` elements                 |

These operations are extracted from `player.js` and executed natively in JavaScript — no `eval()` required.

### N-Parameter (Throttle Avoidance)

YouTube throttles downloads unless the `n` query parameter is transformed. The transform function is too complex for native parsing, so it's evaluated in a **sandboxed page** (`sandbox.html`) that has a relaxed CSP allowing `eval()`.

### 1080p Muxing

YouTube serves 1080p as separate video-only and audio-only DASH streams. The extension:

1. **Fetches both streams** in the offscreen document.
2. **Muxes them** using a lightweight client-side MP4 muxer (parses MP4 boxes, adjusts chunk offsets, combines tracks).
3. **Falls back** to downloading separate files if muxing fails, with guidance to merge using ffmpeg.

> **Note:** Chrome's 2026 security model restricts heavy WASM payloads (like ffmpeg.wasm ~25MB) in extensions. The built-in muxer handles standard H.264+AAC combinations. For edge cases (VP9, Opus), the extension downloads files separately.

---

## Permissions Explained

| Permission           | Why                                           |
|----------------------|-----------------------------------------------|
| `activeTab`          | Access the current YouTube tab on click        |
| `scripting`          | Inject/re-inject the content script           |
| `downloads`          | Save files via `chrome.downloads`             |
| `declarativeContent` | Enable icon only on YouTube video pages       |
| `offscreen`          | Create offscreen doc for muxing & sandbox     |
| `storage`            | Cache player.js and parsing results           |

---

## Updating the Cipher Logic

When YouTube changes its `player.js` structure (typically every few months), the regex patterns in `utils/extractor.js` may need updating:

1. **Decipher function** — Update `DECIPHER_FUNC_NAME_PATTERNS` to match new variable naming.
2. **N-transform function** — Update `N_TRANSFORM_NAME_PATTERNS`.
3. **Helper object parsing** — Rarely changes, but verify `extractHelperMethods()` logic.

**How to debug:**
1. Open a YouTube video, then open DevTools → Network.
2. Find the `base.js` request (YouTube's player JavaScript).
3. Search for `a=a.split("")` to locate the decipher function.
4. Search for `&&(b=a.get("n"))` to locate the n-transform reference.
5. Update the patterns in `extractor.js` accordingly.

---

## Limitations

- **Audio format:** YouTube provides AAC (M4A) natively, not MP3. The extension saves audio as `.m4a`, which is widely supported by all modern players.
- **Age-restricted / Private videos:** May not work without authentication.
- **Live streams:** Not supported (no finite stream to download).
- **Very long videos (>2h):** May exceed Chrome's memory limits during muxing. The extension falls back to separate file downloads.

---

## Disclaimer

This tool is provided for educational and personal use. Respect copyright laws, content creators' rights, and YouTube's Terms of Service. Only download content you have the right to download (e.g., Creative Commons, your own uploads, or with explicit permission).

---

## License

MIT
