/**
 * background.js — MV3 Service Worker
 *
 * Orchestrates the entire download flow:
 *  1. Receives requests from popup.js
 *  2. Queries content.js for video metadata
 *  3. Fetches player.js and extracts decipher/n-transform logic
 *  4. Deciphers stream URLs via utils/extractor.js
 *  5. Delegates n-parameter eval to the offscreen sandbox
 *  6. Initiates downloads via chrome.downloads API
 *  7. For 1080p, manages muxing through the offscreen document
 */

import {
  fetchPlayerJs,
  parseDecipherOps,
  applyDecipherOps,
  parseSignatureCipher,
  extractNTransformCode,
} from './utils/extractor.js';

/* ─── Contextual Activation ───────────────────────────────── */

chrome.runtime.onInstalled.addListener(() => {
  // Disable the extension icon by default
  chrome.action.disable();

  // Enable only on YouTube watch/shorts pages
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostSuffix: 'youtube.com', pathPrefix: '/watch' },
          }),
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostSuffix: 'youtube.com', pathPrefix: '/shorts' },
          }),
        ],
        actions: [new chrome.declarativeContent.ShowAction()],
      },
    ]);
  });
});

/* ─── State ───────────────────────────────────────────────── */

let decipherOps   = null;  // cached decipher operations
let nTransformFn  = null;  // cached n-transform function (via sandbox)
let lastPlayerUrl = null;  // last player.js URL processed

/* ─── Offscreen Document Management ──────────────────────── */

async function ensureOffscreenDocument() {
  // Always check for an existing offscreen document, since Chrome
  // may close it for lifecycle/memory management at any time.
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0) return;
  } catch {
    // chrome.runtime.getContexts unavailable (Chrome < 116), try creating directly
  }

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['IFRAME_SCRIPTING'],
      justification: 'Sandbox iframe for evaluating YouTube cipher functions securely.',
    });
  } catch (err) {
    // Document may already exist — ignore "Only a single offscreen" error
    if (!err.message?.includes('single offscreen')) throw err;
  }
}

/**
 * Send a message to the offscreen document and wait for a response.
 */
function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}

/* ─── Player.js Processing ────────────────────────────────── */

/**
 * Fetch player.js and extract both decipher ops and n-transform code.
 * Results are cached per player.js URL.
 */
async function processPlayerJs(playerJsUrl) {
  if (!playerJsUrl) {
    console.warn('[BG] No playerJsUrl provided — cannot decipher signatures');
    return;
  }
  if (playerJsUrl === lastPlayerUrl && decipherOps && decipherOps.length > 0) return;

  console.log('[BG] Fetching player.js:', playerJsUrl);
  const playerJs = await fetchPlayerJs(playerJsUrl);
  if (!playerJs) {
    console.error('[BG] Failed to fetch player.js source');
    return;
  }
  console.log(`[BG] player.js fetched (${(playerJs.length / 1024).toFixed(0)} KB)`);

  // 1. Extract decipher operations (native — no eval needed)
  decipherOps = parseDecipherOps(playerJs);
  console.log('[BG] Decipher ops:', decipherOps.length, 'operations');
  if (decipherOps.length === 0) {
    console.error('[BG] WARNING: Zero decipher operations extracted — signature deciphering will fail!');
  }

  // 2. Extract n-transform code (needs sandbox eval)
  const nCode = extractNTransformCode(playerJs);
  if (nCode) {
    try {
      await ensureOffscreenDocument();
      const result = await sendToOffscreen({
        action: 'evalNTransform',
        code: nCode,
      });
      if (result?.success) {
        // The offscreen document now has the n-transform function loaded
        // We'll call it per-URL via messages
        nTransformFn = true; // flag that it's available
        console.log('[BG] n-transform function loaded in sandbox');
      }
    } catch (err) {
      console.warn('[BG] Failed to load n-transform:', err);
      nTransformFn = null;
    }
  }

  lastPlayerUrl = playerJsUrl;
}

/**
 * Transform the n-parameter of a URL via the sandbox.
 */
async function transformNParameter(url) {
  if (!nTransformFn) return url;

  try {
    const urlObj = new URL(url);
    const n = urlObj.searchParams.get('n');
    if (!n) return url;

    const result = await sendToOffscreen({
      action: 'transformN',
      value: n,
    });

    if (result?.success && result.transformed) {
      urlObj.searchParams.set('n', result.transformed);
      return urlObj.toString();
    }
  } catch (err) {
    console.warn('[BG] n-transform failed:', err);
  }
  return url;
}

/* ─── Format URL Resolution ──────────────────────────────── */

/**
 * Resolve the final download URL for a format.
 * Handles signature deciphering and n-parameter transformation.
 */
async function resolveFormatUrl(format) {
  let url;

  if (format.url) {
    url = format.url;
  } else if (format.signatureCipher) {
    if (!decipherOps || decipherOps.length === 0) {
      throw new Error(
        'Signature deciphering unavailable — parseDecipherOps returned 0 operations. ' +
        'YouTube\'s player.js obfuscation may have changed.'
      );
    }
    const { s, sp, url: baseUrl } = parseSignatureCipher(format.signatureCipher);
    if (!s || !baseUrl) {
      throw new Error(`Invalid signatureCipher — s=${!!s}, url=${!!baseUrl}`);
    }

    const deciphered = applyDecipherOps(s, decipherOps);
    url = `${baseUrl}&${sp}=${encodeURIComponent(deciphered)}`;
    console.log(`[BG] Deciphered itag=${format.itag}: sig length ${s.length} → ${deciphered.length}`);
  } else {
    throw new Error(`Format itag=${format.itag} has no URL or signatureCipher.`);
  }

  // Transform n-parameter to avoid throttling
  url = await transformNParameter(url);

  return url;
}

/* ─── Download Logic ──────────────────────────────────────── */

/**
 * Download a single stream directly using chrome.downloads.
 */
async function downloadDirect(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

/**
 * Download and mux video + audio streams for 1080p.
 *
 * The offscreen document fetches both streams, muxes them, and returns
 * a blob URL. The background service worker then uses chrome.downloads
 * (which IS available here) to save the file.
 */
async function downloadMuxed(videoUrl, audioUrl, filename) {
  await ensureOffscreenDocument();

  // Offscreen doc fetches + muxes → returns a blob URL
  const result = await sendToOffscreen({
    action: 'muxStreams',
    videoUrl,
    audioUrl,
    filename,
  });

  if (!result?.success || !result.blobUrl) {
    throw new Error(result?.error || 'Muxing failed.');
  }

  // Download the muxed blob via chrome.downloads (available in service worker)
  broadcastProgress(90, 'Saving file…');
  await downloadDirect(result.blobUrl, filename);

  // Ask offscreen to revoke the blob URL after a delay
  sendToOffscreen({ action: 'revokeBlobUrl', url: result.blobUrl }).catch(() => {});
}

/* ─── Message Handler ─────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages intended for other targets
  if (message.target && message.target !== 'background') {
    return false;
  }

  switch (message.action) {
    case 'getVideoInfo':
      handleGetVideoInfo(message, sendResponse);
      return true; // async

    case 'download':
      handleDownload(message, sendResponse);
      return true; // async

    default:
      return false;
  }
});

/**
 * Handle getVideoInfo: query content script, process player.js, resolve URLs.
 */
async function handleGetVideoInfo(message, sendResponse) {
  try {
    const tabId = message.tabId;

    // 1. Try querying the content script (may not be injected yet)
    let contentResponse = null;
    try {
      contentResponse = await chrome.tabs.sendMessage(tabId, { action: 'extractData' });
    } catch {
      // Content script not yet injected — will try manual injection below
    }

    // 2. If content script didn't respond, inject it and retry
    if (!contentResponse?.success) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });
        // Give content.js time to register its listener and inject MAIN world script
        await new Promise(r => setTimeout(r, 1000));

        contentResponse = await chrome.tabs.sendMessage(tabId, { action: 'extractData' });
      } catch (retryErr) {
        throw new Error(`Content script injection failed: ${retryErr.message}`);
      }

      if (!contentResponse?.success) {
        throw new Error(contentResponse?.error || 'Failed to extract video data. Try reloading the page.');
      }
    }

    await handleVideoInfoSuccess(contentResponse.data, sendResponse);
  } catch (err) {
    console.error('[BG] getVideoInfo error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

async function handleVideoInfoSuccess(data, sendResponse) {
  // 2. Process player.js for decipher + n-transform
  if (data.playerJsUrl) {
    await processPlayerJs(data.playerJsUrl);
  } else {
    console.warn('[BG] No playerJsUrl in content data — signature deciphering will not be available');
  }

  // 3. Resolve URLs for all formats
  const resolvedMuxed = [];
  const resolvedAdaptive = [];
  let resolveErrors = [];

  for (const fmt of data.formats.muxed) {
    try {
      const url = await resolveFormatUrl(fmt);
      resolvedMuxed.push({ ...fmt, url });
    } catch (err) {
      console.warn(`[BG] Failed to resolve muxed itag=${fmt.itag}:`, err.message);
      resolveErrors.push(err.message);
      resolvedMuxed.push(fmt);
    }
  }

  for (const fmt of data.formats.adaptive) {
    try {
      const url = await resolveFormatUrl(fmt);
      resolvedAdaptive.push({ ...fmt, url });
    } catch (err) {
      console.warn(`[BG] Failed to resolve adaptive itag=${fmt.itag}:`, err.message);
      resolveErrors.push(err.message);
      resolvedAdaptive.push(fmt);
    }
  }

  // Check if ALL formats failed to resolve
  const totalFormats = resolvedMuxed.length + resolvedAdaptive.length;
  const workingFormats = resolvedMuxed.filter(f => f.url).length +
                         resolvedAdaptive.filter(f => f.url).length;

  if (totalFormats > 0 && workingFormats === 0) {
    // Every single format failed — report the error
    const uniqueErrors = [...new Set(resolveErrors)];
    console.error(`[BG] All ${totalFormats} formats failed URL resolution:`, uniqueErrors);
    sendResponse({
      success: false,
      error: `Signature deciphering failed for all streams. ${uniqueErrors[0] || 'Unknown error.'}`,
    });
    return;
  }

  console.log(`[BG] Resolved ${workingFormats}/${totalFormats} format URLs`);

  sendResponse({
    success: true,
    data: {
      title: data.title,
      duration: data.duration,
      thumbnail: data.thumbnail,
      channelName: data.channelName,
      formats: {
        muxed: resolvedMuxed,
        adaptive: resolvedAdaptive,
      },
    },
  });
}

/**
 * Handle download request from popup.
 */
async function handleDownload(message, sendResponse) {
  try {
    const { format, muxAudio, filename, type, needsMux } = message;

    if (!format?.url) {
      throw new Error('No stream URL available.');
    }

    // Notify popup of progress
    broadcastProgress(10, 'Starting download…');

    if (needsMux && muxAudio?.url) {
      // 1080p: need to download + mux video and audio
      broadcastProgress(15, 'Downloading video stream…');

      try {
        await downloadMuxed(format.url, muxAudio.url, filename);
        broadcastProgress(100, 'Complete!');
        sendResponse({ success: true });
      } catch (muxErr) {
        console.warn('[BG] Mux failed, falling back to separate downloads:', muxErr);
        broadcastProgress(40, 'Muxing failed. Downloading separately…');

        // Fallback: download video and audio as separate files
        const baseName = filename.replace(/\.\w+$/, '');
        await downloadDirect(format.url, `${baseName} [video].mp4`);
        await downloadDirect(muxAudio.url, `${baseName} [audio].m4a`);

        broadcastProgress(100, 'Downloaded as separate files');
        sendResponse({
          success: true,
          note: 'Downloaded as separate video and audio files. Use a tool like ffmpeg to merge them.',
        });
      }
    } else {
      // Direct download (muxed stream or audio-only)
      broadcastProgress(30, 'Downloading…');
      await downloadDirect(format.url, filename);
      broadcastProgress(100, 'Complete!');
      sendResponse({ success: true });
    }
  } catch (err) {
    console.error('[BG] Download error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

/**
 * Broadcast progress updates to all extension views (popup).
 */
function broadcastProgress(percent, label) {
  chrome.runtime.sendMessage({
    action: 'downloadProgress',
    percent,
    label,
  }).catch(() => {
    // Popup may be closed — ignore
  });
}
