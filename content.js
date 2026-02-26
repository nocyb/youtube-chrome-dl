/**
 * content.js — Runs in the ISOLATED world on YouTube pages.
 *
 * This script acts as a bridge between:
 *   - background.js / popup.js (extension context, via chrome.runtime)
 *   - inject.js (MAIN page context, via CustomEvent)
 *
 * Since content scripts in the ISOLATED world cannot access YouTube's
 * window-level variables (ytInitialPlayerResponse, ytplayer, etc.),
 * we inject a companion script (inject.js) into the MAIN world that
 * has full access to the page's JavaScript context.
 *
 * ─────────────────────────────────────────────────────────────
 * DATA FLOW:
 *   popup.js        ──chrome.runtime──>  background.js
 *   background.js   ──chrome.tabs──────> content.js (ISOLATED)
 *   content.js      ──CustomEvent──────> inject.js  (MAIN)
 *   inject.js       ──CustomEvent──────> content.js (ISOLATED)
 *   content.js      ──sendResponse─────> background.js
 * ─────────────────────────────────────────────────────────────
 */

/* ─── State ───────────────────────────────────────────────── */
let injectorReady = false;
let cachedResponse = null;
let cachedVideoId = null;

/* ─── Inject the MAIN-world script ────────────────────────── */

/**
 * Inject inject.js into the page's MAIN world.
 * Uses a <script> tag pointing to the extension's inject.js file.
 */
function injectMainWorldScript() {
  if (document.getElementById('ytdl-injector')) return; // already injected

  const script = document.createElement('script');
  script.id = 'ytdl-injector';
  script.src = chrome.runtime.getURL('inject.js');
  script.type = 'text/javascript';
  script.onload = () => {
    // Clean up the script tag after execution
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

// Listen for inject.js ready signal
document.addEventListener('ytdl-injected', () => {
  injectorReady = true;
  console.log('[content.js] inject.js loaded in MAIN world');
});

/* ─── Request extraction from MAIN world ──────────────────── */

/**
 * Ask inject.js to extract player data.
 * Returns a Promise that resolves with the extraction result.
 * Times out after 8 seconds.
 */
function requestExtraction() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 8000);

    function onResponse(event) {
      clearTimeout(timeout);
      cleanup();
      try {
        const data = JSON.parse(event.detail);
        resolve(data);
      } catch {
        resolve(null);
      }
    }

    function cleanup() {
      document.removeEventListener('ytdl-response', onResponse);
    }

    document.addEventListener('ytdl-response', onResponse, { once: true });
    document.dispatchEvent(new CustomEvent('ytdl-request'));
  });
}

/* ─── Fallback: HTML parsing (ISOLATED world) ─────────────── */

/**
 * If inject.js fails or isn't loaded, try extracting from raw HTML.
 * This works when YouTube's initial page load embeds the data inline
 * (before client-side rendering takes over).
 */
function tryHTMLFallback() {
  const html = document.documentElement.innerHTML;

  // Pattern 1: var ytInitialPlayerResponse = {...};
  let data = extractJSONFromHTML(html, 'ytInitialPlayerResponse');
  if (data?.streamingData) return data;

  // Pattern 2: window["ytInitialPlayerResponse"] = {...};
  data = extractJSONFromHTML(html, 'window["ytInitialPlayerResponse"]');
  if (data?.streamingData) return data;

  // Pattern 3: Search individual script tags (more targeted)
  const scripts = document.querySelectorAll('script:not([src])');
  for (const script of scripts) {
    const text = script.textContent;
    if (!text || text.length < 500) continue;

    if (text.includes('streamingData') && text.includes('adaptiveFormats')) {
      data = extractJSONFromHTML(text, 'ytInitialPlayerResponse');
      if (data?.streamingData) return data;

      data = extractJSONFromHTML(text, '"playerResponse"');
      if (data?.streamingData) return data;
    }
  }

  return null;
}

/**
 * Extract player.js URL from the page HTML (ISOLATED world fallback).
 */
function extractPlayerJsUrlFromHTML() {
  const html = document.documentElement.innerHTML;

  const patterns = [
    /"jsUrl"\s*:\s*"([^"]+base\.js[^"]*)"/,
    /"PLAYER_JS_URL"\s*:\s*"([^"]+)"/,
    /\/s\/player\/[a-zA-Z0-9_-]+\/player_ias\.vflset\/[^"'\s]+?\/base\.js/,
    /\/s\/player\/[a-zA-Z0-9_-]+\/[^"'\s]+?\/base\.js/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      let url = match[1] || match[0];
      if (url.startsWith('/')) url = 'https://www.youtube.com' + url;
      else if (!url.startsWith('http')) url = 'https://www.youtube.com/' + url;
      return url;
    }
  }

  // Check script[src] tags
  for (const tag of document.querySelectorAll('script[src]')) {
    if (tag.src.includes('base.js') && tag.src.includes('/player/')) {
      return tag.src;
    }
  }

  return null;
}

/**
 * Brace-counted JSON extraction from a text string.
 */
function extractJSONFromHTML(text, needle) {
  const idx = text.indexOf(needle);
  if (idx === -1) return null;

  const start = text.indexOf('{', idx);
  if (start === -1 || start - idx > 200) return null;

  let depth = 0;
  for (let i = start; i < Math.min(text.length, start + 5000000); i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.substring(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/* ─── Video ID ────────────────────────────────────────────── */

function getVideoId() {
  const url = new URL(window.location.href);
  if (url.pathname.startsWith('/watch')) {
    return url.searchParams.get('v');
  }
  if (url.pathname.startsWith('/shorts/')) {
    return url.pathname.split('/shorts/')[1]?.split(/[/?#]/)[0];
  }
  return null;
}

/* ─── Wait for YouTube player to be ready ─────────────────── */

/**
 * Wait until the YouTube player element exists in the DOM.
 * Uses MutationObserver with a timeout.
 */
function waitForPlayer(timeoutMs = 5000) {
  return new Promise((resolve) => {
    // Check if already present
    if (document.getElementById('movie_player') ||
        document.querySelector('ytd-watch-flexy') ||
        document.querySelector('ytd-reel-video-renderer')) {
      resolve(true);
      return;
    }

    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(false); // timed out, but still try extraction
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      if (document.getElementById('movie_player') ||
          document.querySelector('ytd-watch-flexy')) {
        clearTimeout(timeout);
        observer.disconnect();
        resolve(true);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  });
}

/* ─── Format normalization ────────────────────────────────── */

function normalizeFormat(f) {
  return {
    itag: f.itag,
    url: f.url || null,
    signatureCipher: f.signatureCipher || f.cipher || null,
    mimeType: f.mimeType || '',
    bitrate: f.bitrate || 0,
    width: f.width || 0,
    height: f.height || 0,
    contentLength: f.contentLength || '0',
    qualityLabel: f.qualityLabel || '',
    quality: f.quality || '',
    audioQuality: f.audioQuality || '',
    audioSampleRate: f.audioSampleRate || '',
    fps: f.fps || 0,
    lastModified: f.lastModified || '',
  };
}

/* ─── Main extraction flow ────────────────────────────────── */

async function extractVideoData() {
  const currentId = getVideoId();

  // Return cached data if same video
  if (cachedResponse && cachedVideoId === currentId) {
    return cachedResponse;
  }

  // Inject MAIN world script if not done yet
  injectMainWorldScript();

  // Wait for the player element to appear
  await waitForPlayer(4000);

  // Give inject.js a moment to initialize after injection
  if (!injectorReady) {
    await new Promise(r => setTimeout(r, 800));
  }

  let playerResponse = null;
  let playerJsUrl = null;

  // ── Attempt 1: Ask inject.js in MAIN world ──
  const mainWorldResult = await requestExtraction();
  if (mainWorldResult?.success && mainWorldResult.playerResponse) {
    playerResponse = mainWorldResult.playerResponse;
    playerJsUrl = mainWorldResult.playerJsUrl;
    console.log('[content.js] Got data from MAIN world injection');
  }

  // ── Attempt 2: HTML fallback (ISOLATED world) ──
  if (!playerResponse) {
    console.log('[content.js] MAIN world failed, trying HTML fallback...');
    playerResponse = tryHTMLFallback();
    if (playerResponse) {
      console.log('[content.js] Got data from HTML fallback');
    }
  }

  // Get player.js URL if we don't have it yet
  if (!playerJsUrl) {
    playerJsUrl = mainWorldResult?.playerJsUrl || extractPlayerJsUrlFromHTML();
  }

  if (!playerResponse) {
    return null;
  }

  // Build the response
  const videoDetails = playerResponse.videoDetails || {};
  const streamingData = playerResponse.streamingData || {};

  const muxed = (streamingData.formats || []).map(normalizeFormat);
  const adaptive = (streamingData.adaptiveFormats || []).map(normalizeFormat);

  const result = {
    videoId: videoDetails.videoId || currentId,
    title: videoDetails.title || 'Unknown Video',
    duration: videoDetails.lengthSeconds,
    thumbnail: videoDetails.thumbnail?.thumbnails?.pop()?.url || '',
    channelName: videoDetails.author || '',
    playerJsUrl,
    formats: { muxed, adaptive },
  };

  // Cache it
  cachedResponse = result;
  cachedVideoId = currentId;

  return result;
}

/* ─── Handle SPA navigation ───────────────────────────────── */

function invalidateCache() {
  cachedResponse = null;
  cachedVideoId = null;
}

// YouTube SPA navigation events
document.addEventListener('yt-navigate-finish', invalidateCache);
document.addEventListener('yt-navigate-start', invalidateCache);
window.addEventListener('popstate', invalidateCache);

// Re-inject on SPA navigation (inject.js may be garbage-collected)
document.addEventListener('yt-navigate-finish', () => {
  // Small delay so YouTube sets up its data first
  setTimeout(injectMainWorldScript, 500);
});

/* ─── Message listener (from background.js) ───────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extractData') {
    extractVideoData().then(data => {
      if (data) {
        sendResponse({ success: true, data });
      } else {
        sendResponse({
          success: false,
          error: 'Could not extract player data. Try reloading the page.',
        });
      }
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // async response
  }
});

/* ─── Initial setup ───────────────────────────────────────── */

// Inject immediately on load
injectMainWorldScript();
