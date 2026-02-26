/**
 * inject.js — Runs in the MAIN page context (world: MAIN).
 *
 * This script has direct access to YouTube's window-level variables:
 *   - window.ytInitialPlayerResponse
 *   - window.ytInitialData
 *   - document.ytplayer
 *   - window.ytplayer
 *   - The <ytd-app> Polymer element's data
 *
 * It extracts the player response and communicates it back to content.js
 * (running in the ISOLATED world) via a CustomEvent on the document.
 *
 * ─────────────────────────────────────────────────────────────
 * DATA FLOW:
 *   content.js (ISOLATED)  ──dispatches──>  "ytdl-request"
 *   inject.js  (MAIN)      ──listens────>   "ytdl-request"
 *   inject.js  (MAIN)      ──dispatches──>  "ytdl-response"
 *   content.js (ISOLATED)  ──listens────>   "ytdl-response"
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ─── Strategy 1: Direct window variables ────────────────── */
  function tryWindowVariables() {
    // ytInitialPlayerResponse is set on initial page load
    if (window.ytInitialPlayerResponse?.streamingData) {
      return window.ytInitialPlayerResponse;
    }

    // Sometimes stored under different names
    if (window.ytPlayerResponse?.streamingData) {
      return window.ytPlayerResponse;
    }

    return null;
  }

  /* ─── Strategy 2: ytplayer.config (legacy + current) ─────── */
  function tryYtplayerConfig() {
    // document.ytplayer or window.ytplayer
    const ytplayer = document.ytplayer || window.ytplayer;
    if (ytplayer?.config?.args) {
      const args = ytplayer.config.args;
      // Try raw_player_response first (newer format)
      if (args.raw_player_response?.streamingData) {
        return args.raw_player_response;
      }
      // Try player_response as JSON string
      if (typeof args.player_response === 'string') {
        try {
          const parsed = JSON.parse(args.player_response);
          if (parsed?.streamingData) return parsed;
        } catch { /* ignore */ }
      }
    }

    // ytplayer.bootstrapPlayerResponse (newer 2025+ pattern)
    if (ytplayer?.bootstrapPlayerResponse?.streamingData) {
      return ytplayer.bootstrapPlayerResponse;
    }

    return null;
  }

  /* ─── Strategy 3: Polymer ytd-app element data ──────────── */
  function tryPolymerApp() {
    const app = document.querySelector('ytd-app');
    if (!app) return null;

    // Access the Polymer data model
    const data = app.__data || app.data;
    if (!data) return null;

    // Navigate through the Polymer data tree
    const playerResponse =
      data.playerResponse ||
      data.player?.playerResponse ||
      data.watchNextResponse?.playerResponse;

    if (playerResponse?.streamingData) return playerResponse;

    return null;
  }

  /* ─── Strategy 4: ytd-watch-flexy or ytd-player element ──── */
  function tryWatchElement() {
    // Try the watch page player element
    const selectors = [
      'ytd-watch-flexy',
      'ytd-watch-metadata',
      'ytd-player',
      '#movie_player',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;

      // Polymer __data access
      const d = el.__data || el.data || el.__dataHost?.__data;
      if (!d) continue;

      // Direct playerResponse
      if (d.playerResponse?.streamingData) return d.playerResponse;

      // Nested in watchNextData, etc.
      const nested = findPlayerResponse(d, 0);
      if (nested) return nested;
    }

    // Try the movie_player API
    const player = document.getElementById('movie_player');
    if (player) {
      // getPlayerResponse() may be available
      if (typeof player.getPlayerResponse === 'function') {
        try {
          const pr = player.getPlayerResponse();
          if (pr?.streamingData) return pr;
        } catch { /* ignore */ }
      }

      // getVideoData() for basic info
      if (typeof player.getVideoData === 'function') {
        try {
          const vd = player.getVideoData();
          // Store for later use even if no streamingData
          if (vd?.video_id) {
            window.__ytdl_videoData = vd;
          }
        } catch { /* ignore */ }
      }
    }

    return null;
  }

  /* ─── Strategy 5: Intercept ytInitialData ────────────────── */
  function tryYtInitialData() {
    const ytData = window.ytInitialData;
    if (!ytData) return null;

    // The player response can be nested inside ytInitialData
    // under contents > twoColumnWatchNextResults > ...
    return findPlayerResponse(ytData, 0);
  }

  /* ─── Strategy 6: Parse script tags from DOM ─────────────── */
  function tryScriptTagParsing() {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent;
      if (!text || text.length < 200) continue;

      // Look for ytInitialPlayerResponse assignment
      if (text.includes('ytInitialPlayerResponse')) {
        const data = extractJSON(text, 'ytInitialPlayerResponse');
        if (data?.streamingData) return data;
      }

      // Look for raw streamingData in inline config scripts
      if (text.includes('streamingData') && text.includes('adaptiveFormats')) {
        // Try to find the enclosing player response object
        const data = extractJSON(text, '"streamingData"');
        if (data?.streamingData) return data;

        // Try window["ytInitialPlayerResponse"]
        const data2 = extractJSON(text, 'window["ytInitialPlayerResponse"]');
        if (data2?.streamingData) return data2;
      }
    }
    return null;
  }

  /* ─── Strategy 7: Fetch from YouTube's innertube API ─────── */
  function tryInnertubeEndpoint() {
    // This is async, so we handle it separately
    return null; // placeholder — actual call is in extractAsync
  }

  async function fetchInnertubePlayerResponse(videoId) {
    if (!videoId) return null;

    try {
      const response = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': '1',
          'X-YouTube-Client-Version': '2.20260101.00.00',
        },
        body: JSON.stringify({
          videoId: videoId,
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20260101.00.00',
              hl: 'en',
              gl: 'US',
            },
          },
          playbackContext: {
            contentPlaybackContext: {
              signatureTimestamp: getSigTimestamp(),
            },
          },
        }),
      });

      if (!response.ok) return null;
      const data = await response.json();
      if (data?.streamingData) return data;
    } catch { /* ignore */ }

    return null;
  }

  /* ─── Helpers ───────────────────────────────────────────── */

  /**
   * Extract JSON object from text starting after a needle string.
   * Uses brace counting to handle nested objects.
   */
  function extractJSON(text, needle) {
    const idx = text.indexOf(needle);
    if (idx === -1) return null;

    const braceStart = text.indexOf('{', idx);
    if (braceStart === -1) return null;

    let depth = 0;
    for (let i = braceStart; i < Math.min(text.length, braceStart + 5000000); i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.substring(braceStart, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * Recursively find a player response (has streamingData + videoDetails).
   */
  function findPlayerResponse(obj, depth) {
    if (depth > 6 || !obj || typeof obj !== 'object') return null;
    if (obj.streamingData && obj.videoDetails) return obj;

    const keys = Array.isArray(obj) ? obj.keys() : Object.keys(obj);
    for (const key of keys) {
      try {
        const result = findPlayerResponse(obj[key], depth + 1);
        if (result) return result;
      } catch { /* circular ref or access error */ }
    }
    return null;
  }

  /**
   * Get the video ID from the current URL.
   */
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

  /**
   * Extract the player.js URL from the page.
   */
  function getPlayerJsUrl() {
    // Method 1: From ytcfg
    if (window.ytcfg) {
      const jsUrl = window.ytcfg.get?.('PLAYER_JS_URL') || window.ytcfg.data_?.PLAYER_JS_URL;
      if (jsUrl) return makeAbsolute(jsUrl);
    }

    // Method 2: From script src attributes
    const scripts = document.querySelectorAll('script[src]');
    for (const s of scripts) {
      if (s.src.includes('/player/') && s.src.includes('base.js')) {
        return s.src;
      }
    }

    // Method 3: From inline script text
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
        const url = match[1] || match[0];
        return makeAbsolute(url);
      }
    }

    // Method 4: From movie_player element
    const player = document.getElementById('movie_player');
    if (player) {
      const config = player.getPlayerConfig?.() || player.config_;
      if (config?.assets?.js) return makeAbsolute(config.assets.js);
    }

    return null;
  }

  /**
   * Get the signature timestamp from ytcfg (needed for innertube).
   */
  function getSigTimestamp() {
    if (window.ytcfg) {
      const sts = window.ytcfg.get?.('STS');
      if (sts) return sts;
    }
    return undefined;
  }

  function makeAbsolute(url) {
    if (!url) return null;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) return 'https://www.youtube.com' + url;
    if (!url.startsWith('http')) return 'https://www.youtube.com/' + url;
    return url;
  }

  /* ─── Main extraction orchestrator ──────────────────────── */

  /**
   * Run all extraction strategies in priority order.
   * Returns { playerResponse, playerJsUrl, videoId } or null fields.
   */
  function extractSync() {
    const strategies = [
      ['windowVars',    tryWindowVariables],
      ['ytplayerConfig', tryYtplayerConfig],
      ['polymerApp',    tryPolymerApp],
      ['watchElement',  tryWatchElement],
      ['ytInitialData', tryYtInitialData],
      ['scriptParsing', tryScriptTagParsing],
    ];

    for (const [name, fn] of strategies) {
      try {
        const result = fn();
        if (result?.streamingData) {
          console.log(`[inject.js] Extracted via: ${name}`);
          return result;
        }
      } catch (err) {
        console.warn(`[inject.js] Strategy ${name} failed:`, err.message);
      }
    }

    return null;
  }

  async function extractAsync() {
    // First try all sync strategies
    let playerResponse = extractSync();

    // If sync failed, try innertube API as last resort
    if (!playerResponse) {
      const videoId = getVideoId();
      console.log('[inject.js] Sync extraction failed. Trying innertube API for:', videoId);
      playerResponse = await fetchInnertubePlayerResponse(videoId);
      if (playerResponse) {
        console.log('[inject.js] Extracted via: innertubeAPI');
      }
    }

    return playerResponse;
  }

  /* ─── Event-based communication with content.js ─────────── */

  async function handleExtractionRequest() {
    try {
      const playerResponse = await extractAsync();
      const playerJsUrl = getPlayerJsUrl();
      const videoId = getVideoId();

      document.dispatchEvent(new CustomEvent('ytdl-response', {
        detail: JSON.stringify({
          success: !!playerResponse,
          playerResponse: playerResponse || null,
          playerJsUrl,
          videoId,
          error: playerResponse ? null : 'All extraction strategies failed.',
        }),
      }));
    } catch (err) {
      document.dispatchEvent(new CustomEvent('ytdl-response', {
        detail: JSON.stringify({
          success: false,
          error: err.message,
        }),
      }));
    }
  }

  // Listen for requests from content.js
  document.addEventListener('ytdl-request', handleExtractionRequest);

  // Also proactively extract on YouTube SPA navigation
  // so data is ready when the popup asks for it
  document.addEventListener('yt-navigate-finish', () => {
    // Small delay to let YouTube populate its data objects
    setTimeout(() => {
      const pr = extractSync();
      if (pr) {
        document.dispatchEvent(new CustomEvent('ytdl-data-ready', {
          detail: JSON.stringify({
            videoId: getVideoId(),
            hasData: true,
          }),
        }));
      }
    }, 1500);
  });

  // Signal that inject.js is loaded
  document.dispatchEvent(new CustomEvent('ytdl-injected'));
})();
