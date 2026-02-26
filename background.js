// service worker

import {
  fetchPlayerJs,
  parseDecipherOps,
  applyDecipherOps,
  parseSignatureCipher,
  extractNTransformCode,
} from './utils/extractor.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.disable();

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

// state
let decipherOps = null;
let nTransformFn = null;
let lastPlayerUrl = null;

async function ensureOffscreenDocument() {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0) return;
  } catch {
    // getContexts unavailable on older chrome
  }

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['IFRAME_SCRIPTING'],
      justification: 'Sandbox iframe for evaluating YouTube cipher functions securely.',
    });
  } catch (err) {
    if (!err.message?.includes('single offscreen')) throw err;
  }
}

function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}

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

  decipherOps = parseDecipherOps(playerJs);
  console.log('[BG] Decipher ops:', decipherOps.length, 'operations');
  if (decipherOps.length === 0) {
    console.error('[BG] WARNING: Zero decipher operations extracted — signature deciphering will fail!');
  }

  // HACK: n-transform needs eval, sandbox it
  const nCode = extractNTransformCode(playerJs);
  if (nCode) {
    try {
      await ensureOffscreenDocument();
      const result = await sendToOffscreen({
        action: 'evalNTransform',
        code: nCode,
      });
      if (result?.success) {
        nTransformFn = true; // flag that sandbox has it loaded
        console.log('[BG] n-transform function loaded in sandbox');
      }
    } catch (err) {
      console.warn('[BG] Failed to load n-transform:', err);
      nTransformFn = null;
    }
  }

  lastPlayerUrl = playerJsUrl;
}

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

// FIXME: breaks if youtube changes player.js structure again
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

  url = await transformNParameter(url);

  return url;
}

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

/* offscreen can't use chrome.downloads, so it gives us a blobUrl and we download it */
async function downloadMuxed(videoUrl, audioUrl, filename) {
  await ensureOffscreenDocument();

  const result = await sendToOffscreen({
    action: 'muxStreams',
    videoUrl,
    audioUrl,
    filename,
  });

  if (!result?.success || !result.blobUrl) {
    throw new Error(result?.error || 'Muxing failed.');
  }

  broadcastProgress(90, 'Saving file…');
  await downloadDirect(result.blobUrl, filename);

  sendToOffscreen({ action: 'revokeBlobUrl', url: result.blobUrl }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

async function handleGetVideoInfo(message, sendResponse) {
  try {
    const tabId = message.tabId;

    let contentResponse = null;
    try {
      contentResponse = await chrome.tabs.sendMessage(tabId, { action: 'extractData' });
    } catch {
      // not injected yet
    }

    if (!contentResponse?.success) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });
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
  if (data.playerJsUrl) {
    await processPlayerJs(data.playerJsUrl);
  } else {
    console.warn('[BG] No playerJsUrl in content data — signature deciphering will not be available');
  }

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

  const totalFormats = resolvedMuxed.length + resolvedAdaptive.length;
  const workingFormats = resolvedMuxed.filter(f => f.url).length +
                         resolvedAdaptive.filter(f => f.url).length;

  if (totalFormats > 0 && workingFormats === 0) {
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

async function handleDownload(message, sendResponse) {
  try {
    const { format, muxAudio, filename, type, needsMux } = message;

    if (!format?.url) {
      throw new Error('No stream URL available.');
    }

    broadcastProgress(10, 'Starting download…');

    if (needsMux && muxAudio?.url) {
      broadcastProgress(15, 'Downloading video stream…');

      try {
        await downloadMuxed(format.url, muxAudio.url, filename);
        broadcastProgress(100, 'Complete!');
        sendResponse({ success: true });
      } catch (muxErr) {
        console.warn('[BG] Mux failed, falling back to separate downloads:', muxErr);
        broadcastProgress(40, 'Muxing failed. Downloading separately…');

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

function broadcastProgress(percent, label) {
  chrome.runtime.sendMessage({
    action: 'downloadProgress',
    percent,
    label,
  }).catch(() => {
    // popup might be closed
  });
}
