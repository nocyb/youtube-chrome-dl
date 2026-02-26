// runs in MAIN world - direct access to window.ytInitialPlayerResponse etc
(function () {
  'use strict';

  function tryWindowVariables() {
    if (window.ytInitialPlayerResponse?.streamingData) {
      return window.ytInitialPlayerResponse;
    }

    if (window.ytPlayerResponse?.streamingData) {
      return window.ytPlayerResponse;
    }

    return null;
  }

  function tryYtplayerConfig() {
    const ytplayer = document.ytplayer || window.ytplayer;
    if (ytplayer?.config?.args) {
      const args = ytplayer.config.args;
      if (args.raw_player_response?.streamingData) {
        return args.raw_player_response;
      }
      if (typeof args.player_response === 'string') {
        try {
          const parsed = JSON.parse(args.player_response);
          if (parsed?.streamingData) return parsed;
        } catch { /* ignore */ }
      }
    }

    if (ytplayer?.bootstrapPlayerResponse?.streamingData) {
      return ytplayer.bootstrapPlayerResponse;
    }

    return null;
  }

  function tryPolymerApp() {
    const app = document.querySelector('ytd-app');
    if (!app) return null;

    const data = app.__data || app.data;
    if (!data) return null;

    const playerResponse =
      data.playerResponse ||
      data.player?.playerResponse ||
      data.watchNextResponse?.playerResponse;

    if (playerResponse?.streamingData) return playerResponse;

    return null;
  }

  function tryWatchElement() {
    const selectors = [
      'ytd-watch-flexy',
      'ytd-watch-metadata',
      'ytd-player',
      '#movie_player',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;

      const d = el.__data || el.data || el.__dataHost?.__data;
      if (!d) continue;

      if (d.playerResponse?.streamingData) return d.playerResponse;

      const nested = findPlayerResponse(d, 0);
      if (nested) return nested;
    }

    const player = document.getElementById('movie_player');
    if (player) {
      if (typeof player.getPlayerResponse === 'function') {
        try {
          const pr = player.getPlayerResponse();
          if (pr?.streamingData) return pr;
        } catch { /* ignore */ }
      }

      if (typeof player.getVideoData === 'function') {
        try {
          const vd = player.getVideoData();
          if (vd?.video_id) {
            window.__ytdl_videoData = vd;
          }
        } catch { /* ignore */ }
      }
    }

    return null;
  }

  function tryYtInitialData() {
    const ytData = window.ytInitialData;
    if (!ytData) return null;

    return findPlayerResponse(ytData, 0);
  }

  function tryScriptTagParsing() {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent;
      if (!text || text.length < 200) continue;

      if (text.includes('ytInitialPlayerResponse')) {
        const data = extractJSON(text, 'ytInitialPlayerResponse');
        if (data?.streamingData) return data;
      }

      if (text.includes('streamingData') && text.includes('adaptiveFormats')) {
        const data = extractJSON(text, '"streamingData"');
        if (data?.streamingData) return data;

        const data2 = extractJSON(text, 'window["ytInitialPlayerResponse"]');
        if (data2?.streamingData) return data2;
      }
    }
    return null;
  }

  // HACK: innertube fallback - slower but more reliable
  function tryInnertubeEndpoint() {
    return null;
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

  function getPlayerJsUrl() {
    if (window.ytcfg) {
      const jsUrl = window.ytcfg.get?.('PLAYER_JS_URL') || window.ytcfg.data_?.PLAYER_JS_URL;
      if (jsUrl) return makeAbsolute(jsUrl);
    }

    const scripts = document.querySelectorAll('script[src]');
    for (const s of scripts) {
      if (s.src.includes('/player/') && s.src.includes('base.js')) {
        return s.src;
      }
    }

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

    const player = document.getElementById('movie_player');
    if (player) {
      const config = player.getPlayerConfig?.() || player.config_;
      if (config?.assets?.js) return makeAbsolute(config.assets.js);
    }

    return null;
  }

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

  document.addEventListener('ytdl-request', handleExtractionRequest);

  // pre-extract on SPA nav so data is ready when popup opens
  document.addEventListener('yt-navigate-finish', () => {
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

  document.dispatchEvent(new CustomEvent('ytdl-injected'));
})();
