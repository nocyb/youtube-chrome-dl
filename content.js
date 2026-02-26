// ISOLATED world bridge - talks to inject.js via CustomEvent

// state
let injectorReady = false;
let cachedResponse = null;
let cachedVideoId = null;


function injectMainWorldScript() {
  if (document.getElementById('ytdl-injector')) return; // already injected

  const script = document.createElement('script');
  script.id = 'ytdl-injector';
  script.src = chrome.runtime.getURL('inject.js');
  script.type = 'text/javascript';
  script.onload = () => {
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

document.addEventListener('ytdl-injected', () => {
  injectorReady = true;
});


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


function tryHTMLFallback() {
  const html = document.documentElement.innerHTML;

  let data = extractJSONFromHTML(html, 'ytInitialPlayerResponse');
  if (data?.streamingData) return data;

  data = extractJSONFromHTML(html, 'window["ytInitialPlayerResponse"]');
  if (data?.streamingData) return data;

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

  for (const tag of document.querySelectorAll('script[src]')) {
    if (tag.src.includes('base.js') && tag.src.includes('/player/')) {
      return tag.src;
    }
  }

  return null;
}

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

function waitForPlayer(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (document.getElementById('movie_player') ||
        document.querySelector('ytd-watch-flexy') ||
        document.querySelector('ytd-reel-video-renderer')) {
      resolve(true);
      return;
    }

    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(false);
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


async function extractVideoData() {
  const currentId = getVideoId();

  if (cachedResponse && cachedVideoId === currentId) {
    return cachedResponse;
  }

  injectMainWorldScript();

  await waitForPlayer(4000);

  if (!injectorReady) {
    await new Promise(r => setTimeout(r, 800));
  }

  let playerResponse = null;
  let playerJsUrl = null;

  const mainWorldResult = await requestExtraction();
  if (mainWorldResult?.success && mainWorldResult.playerResponse) {
    playerResponse = mainWorldResult.playerResponse;
    playerJsUrl = mainWorldResult.playerJsUrl;
  }

  if (!playerResponse) {
    playerResponse = tryHTMLFallback();
  }

  if (!playerJsUrl) {
    playerJsUrl = mainWorldResult?.playerJsUrl || extractPlayerJsUrlFromHTML();
  }

  if (!playerResponse) {
    return null;
  }

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

  cachedResponse = result;
  cachedVideoId = currentId;

  return result;
}

function invalidateCache() {
  cachedResponse = null;
  cachedVideoId = null;
}

document.addEventListener('yt-navigate-finish', invalidateCache);
document.addEventListener('yt-navigate-start', invalidateCache);
window.addEventListener('popstate', invalidateCache);

// re-inject after SPA nav, inject.js doesn't survive it
// TODO: clean this up, there's probably a better way to handle SPA nav
document.addEventListener('yt-navigate-finish', () => {
  setTimeout(injectMainWorldScript, 500);
});


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
    return true;
  }
});

injectMainWorldScript();
