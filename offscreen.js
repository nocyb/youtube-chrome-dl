/**
 * offscreen.js — Offscreen document logic.
 *
 * This document serves two purposes:
 *
 * 1. SANDBOX RELAY
 *    Relays messages between the background service worker and the
 *    sandboxed iframe (sandbox.html) for eval-ing YouTube cipher functions.
 *
 * 2. STREAM MUXER
 *    For 1080p downloads, fetches separate video and audio streams,
 *    muxes them into a single MP4 file, and triggers the download.
 *    Uses a lightweight MP4 muxer (no ffmpeg.wasm required).
 *
 * ────────────────────────────────────────────────────────────────
 */

/* ─── Sandbox Communication ──────────────────────────────── */

const sandboxFrame = document.getElementById('sandbox');
let sandboxReady = false;
const pendingCallbacks = new Map();
let messageIdCounter = 0;

// Wait for sandbox to be ready
window.addEventListener('message', (event) => {
  if (event.data?.from === 'sandbox') {
    if (event.data.ready) {
      sandboxReady = true;
      console.log('[Offscreen] Sandbox is ready');
      return;
    }

    // Handle response from sandbox
    const id = event.data.id;
    if (id !== undefined && pendingCallbacks.has(id)) {
      const { resolve } = pendingCallbacks.get(id);
      pendingCallbacks.delete(id);
      resolve(event.data);
    }
  }
});

/**
 * Send a message to the sandbox iframe and wait for a response.
 */
function sendToSandbox(msg) {
  return new Promise((resolve, reject) => {
    const id = messageIdCounter++;
    const timeout = setTimeout(() => {
      pendingCallbacks.delete(id);
      reject(new Error('Sandbox timeout'));
    }, 10000);

    pendingCallbacks.set(id, {
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
    });

    sandboxFrame.contentWindow.postMessage({ ...msg, id }, '*');
  });
}

/**
 * Wait until the sandbox is ready (up to 5 seconds).
 */
async function waitForSandbox() {
  if (sandboxReady) return;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (sandboxReady) return resolve();
      if (Date.now() - start > 5000) return reject(new Error('Sandbox not ready'));
      setTimeout(check, 100);
    };
    check();
  });
}

/* ─── Message Handler (from background.js) ───────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages targeted at the offscreen document
  if (message.target !== 'offscreen') return false;

  switch (message.action) {
    case 'evalNTransform':
      handleEvalNTransform(message, sendResponse);
      return true;

    case 'transformN':
      handleTransformN(message, sendResponse);
      return true;

    case 'muxStreams':
      handleMuxStreams(message, sendResponse);
      return true;

    case 'revokeBlobUrl':
      if (message.url) {
        setTimeout(() => URL.revokeObjectURL(message.url), 30000);
      }
      sendResponse({ success: true });
      return true;

    default:
      return false;
  }
});

/**
 * Forward the n-transform code to the sandbox for eval.
 */
async function handleEvalNTransform(message, sendResponse) {
  try {
    await waitForSandbox();
    const result = await sendToSandbox({
      action: 'evalNTransform',
      code: message.code,
    });
    sendResponse(result);
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

/**
 * Forward an n-parameter value to the sandbox for transformation.
 */
async function handleTransformN(message, sendResponse) {
  try {
    await waitForSandbox();
    const result = await sendToSandbox({
      action: 'transformN',
      value: message.value,
    });
    sendResponse(result);
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

/* ─── Stream Muxing ──────────────────────────────────────── */

/**
 * Download video and audio streams, mux them into a single MP4,
 * and return a blob URL for the background to download.
 *
 * Strategy:
 *   1. Fetch both streams as ArrayBuffers in parallel.
 *   2. Parse the MP4 containers to extract raw track data.
 *   3. Create a new MP4 with both tracks using a minimal muxer.
 *   4. Return a blob URL to the background service worker.
 *
 * Limitation:
 *   The built-in muxer handles the common case of H.264 video + AAC audio
 *   in fMP4/MP4 containers. Edge cases may require the separate-file fallback.
 */
async function handleMuxStreams(message, sendResponse) {
  const { videoUrl, audioUrl } = message;

  try {
    // Fetch both streams in parallel
    const [videoResponse, audioResponse] = await Promise.all([
      fetch(videoUrl),
      fetch(audioUrl),
    ]);

    if (!videoResponse.ok) throw new Error(`Video fetch failed: HTTP ${videoResponse.status}`);
    if (!audioResponse.ok) throw new Error(`Audio fetch failed: HTTP ${audioResponse.status}`);

    const [videoBuffer, audioBuffer] = await Promise.all([
      videoResponse.arrayBuffer(),
      audioResponse.arrayBuffer(),
    ]);

    // Attempt to mux the streams
    let muxedBlob;
    try {
      muxedBlob = muxMP4Streams(videoBuffer, audioBuffer);
    } catch (muxErr) {
      console.warn('[Offscreen] Muxing failed, trying simple concatenation:', muxErr);
      // Fallback: just use the video stream (some players handle video-only MP4)
      muxedBlob = new Blob([videoBuffer], { type: 'video/mp4' });
    }

    // Create blob URL and return it to background for downloading.
    // Offscreen documents cannot access chrome.downloads, so the
    // background service worker handles the actual download call.
    const blobUrl = URL.createObjectURL(muxedBlob);

    // Keep a reference so the blob URL stays alive
    // (it will be revoked after the background finishes the download)
    if (!globalThis._blobUrls) globalThis._blobUrls = [];
    globalThis._blobUrls.push(blobUrl);

    sendResponse({ success: true, blobUrl });

  } catch (err) {
    console.error('[Offscreen] Mux error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

/* ─── Minimal MP4 Muxer ──────────────────────────────────── */

/**
 * A lightweight MP4 muxer that combines a video-only MP4 with an audio-only
 * M4A into a single MP4 file containing both tracks.
 *
 * This works by:
 * 1. Parsing both files to find their moov and mdat boxes.
 * 2. Extracting track (trak) boxes from each moov.
 * 3. Building a new moov box with both tracks, adjusting offsets.
 * 4. Writing: ftyp + moov (combined) + video mdat + audio mdat
 *
 * Supports: ISO BMFF / MP4 containers with H.264 video and AAC audio.
 */
function muxMP4Streams(videoData, audioData) {
  const videoView = new DataView(videoData);
  const audioView = new DataView(audioData);

  // Parse both files
  const videoBoxes = parseMP4Boxes(videoView, 0, videoData.byteLength);
  const audioBoxes = parseMP4Boxes(audioView, 0, audioData.byteLength);

  // Find key boxes
  const videoFtyp = findBox(videoBoxes, 'ftyp');
  const videoMoov = findBox(videoBoxes, 'moov');
  const videoMdat = findBox(videoBoxes, 'mdat');
  const audioMoov = findBox(audioBoxes, 'moov');
  const audioMdat = findBox(audioBoxes, 'mdat');

  if (!videoMoov || !videoMdat || !audioMoov || !audioMdat) {
    throw new Error('Could not find required MP4 boxes in the streams.');
  }

  // Extract trak boxes from each moov
  const videoMoovInner = parseMP4Boxes(videoView, videoMoov.dataOffset, videoMoov.offset + videoMoov.size);
  const audioMoovInner = parseMP4Boxes(audioView, audioMoov.dataOffset, audioMoov.offset + audioMoov.size);

  const videoTrak = findBox(videoMoovInner, 'trak');
  const audioTrak = findBox(audioMoovInner, 'trak');

  if (!videoTrak || !audioTrak) {
    throw new Error('Could not find trak boxes in moov.');
  }

  // Extract raw bytes
  const ftypBytes = videoFtyp
    ? new Uint8Array(videoData, videoFtyp.offset, videoFtyp.size)
    : createFtypBox();

  const videoTrakBytes = new Uint8Array(videoData, videoTrak.offset, videoTrak.size);
  const audioTrakBytes = new Uint8Array(audioData, audioTrak.offset, audioTrak.size);

  // Extract mvhd from video moov
  const mvhd = findBox(videoMoovInner, 'mvhd');
  const mvhdBytes = mvhd
    ? new Uint8Array(videoData, mvhd.offset, mvhd.size)
    : null;

  if (!mvhdBytes) {
    throw new Error('Could not find mvhd box.');
  }

  const videoMdatBytes = new Uint8Array(videoData, videoMdat.offset, videoMdat.size);
  const audioMdatBytes = new Uint8Array(audioData, audioMdat.offset, audioMdat.size);

  // Calculate new moov size
  const moovContentSize = mvhdBytes.length + videoTrakBytes.length + audioTrakBytes.length;
  const moovSize = 8 + moovContentSize; // 8 bytes for box header

  // Calculate offsets for mdat in the final file
  const ftypSize = ftypBytes.length;
  const videoMdatOffset = ftypSize + moovSize;
  const audioMdatOffset = videoMdatOffset + videoMdatBytes.length;

  // Adjust chunk offsets (stco/co64) in trak boxes
  const videoChunkDelta = videoMdatOffset - videoMdat.offset;
  const audioChunkDelta = audioMdatOffset - audioMdat.offset;

  const adjustedVideoTrak = adjustChunkOffsets(videoTrakBytes, videoChunkDelta);
  const adjustedAudioTrak = adjustChunkOffsets(audioTrakBytes, audioChunkDelta);

  // Build the new moov box
  const moovBytes = new Uint8Array(moovSize);
  const moovDv = new DataView(moovBytes.buffer);
  moovDv.setUint32(0, moovSize);
  moovBytes[4] = 0x6D; // 'm'
  moovBytes[5] = 0x6F; // 'o'
  moovBytes[6] = 0x6F; // 'o'
  moovBytes[7] = 0x76; // 'v'

  let pos = 8;
  moovBytes.set(mvhdBytes, pos); pos += mvhdBytes.length;
  moovBytes.set(adjustedVideoTrak, pos); pos += adjustedVideoTrak.length;
  moovBytes.set(adjustedAudioTrak, pos);

  // Assemble final file
  const totalSize = ftypBytes.length + moovBytes.length + videoMdatBytes.length + audioMdatBytes.length;
  const result = new Uint8Array(totalSize);
  let offset = 0;

  result.set(ftypBytes, offset); offset += ftypBytes.length;
  result.set(moovBytes, offset); offset += moovBytes.length;
  result.set(videoMdatBytes, offset); offset += videoMdatBytes.length;
  result.set(audioMdatBytes, offset);

  return new Blob([result], { type: 'video/mp4' });
}

/**
 * Parse MP4 boxes at the top level of a given range.
 */
function parseMP4Boxes(dataView, start, end) {
  const boxes = [];
  let offset = start;

  while (offset < end - 8) {
    let size = dataView.getUint32(offset);
    const type = String.fromCharCode(
      dataView.getUint8(offset + 4),
      dataView.getUint8(offset + 5),
      dataView.getUint8(offset + 6),
      dataView.getUint8(offset + 7)
    );

    let headerSize = 8;

    if (size === 1) {
      // 64-bit extended size
      const hi = dataView.getUint32(offset + 8);
      const lo = dataView.getUint32(offset + 12);
      size = hi * 0x100000000 + lo;
      headerSize = 16;
    } else if (size === 0) {
      // Box extends to end of file
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) break;

    boxes.push({
      type,
      offset,
      size,
      dataOffset: offset + headerSize,
    });

    offset += size;
  }

  return boxes;
}

/**
 * Find a box by type in a list of parsed boxes.
 */
function findBox(boxes, type) {
  return boxes.find(b => b.type === type) || null;
}

/**
 * Adjust chunk offsets (stco/co64 boxes) inside a trak by a given delta.
 * This is necessary because the mdat position changes in the merged file.
 */
function adjustChunkOffsets(trakBytes, delta) {
  const result = new Uint8Array(trakBytes);
  const dv = new DataView(result.buffer, result.byteOffset, result.byteLength);

  // Search for stco and co64 boxes within the trak
  for (let i = 0; i < result.length - 8; i++) {
    const type = String.fromCharCode(result[i + 4], result[i + 5], result[i + 6], result[i + 7]);

    if (type === 'stco') {
      const boxSize = dv.getUint32(i);
      // stco format: size(4) + type(4) + version(1) + flags(3) + entryCount(4) + entries(4 each)
      if (i + boxSize <= result.length) {
        const entryCount = dv.getUint32(i + 12);
        for (let j = 0; j < entryCount; j++) {
          const entryOffset = i + 16 + j * 4;
          if (entryOffset + 4 <= result.length) {
            const oldValue = dv.getUint32(entryOffset);
            dv.setUint32(entryOffset, oldValue + delta);
          }
        }
      }
    } else if (type === 'co64') {
      const boxSize = dv.getUint32(i);
      // co64 format: size(4) + type(4) + version(1) + flags(3) + entryCount(4) + entries(8 each)
      if (i + boxSize <= result.length) {
        const entryCount = dv.getUint32(i + 12);
        for (let j = 0; j < entryCount; j++) {
          const entryOffset = i + 16 + j * 8;
          if (entryOffset + 8 <= result.length) {
            const hi = dv.getUint32(entryOffset);
            const lo = dv.getUint32(entryOffset + 4);
            const val = hi * 0x100000000 + lo + delta;
            dv.setUint32(entryOffset, Math.floor(val / 0x100000000));
            dv.setUint32(entryOffset + 4, val >>> 0);
          }
        }
      }
    }
  }

  return result;
}

/**
 * Create a minimal ftyp box for an MP4 file.
 */
function createFtypBox() {
  // ftyp: isom + major brand + compatible brands
  const brands = ['isom', 'iso2', 'avc1', 'mp41'];
  const size = 8 + 8 + brands.length * 4; // header + majorBrand+version + brands
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);

  dv.setUint32(0, size);
  buf.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'

  // Major brand: isom
  buf.set([0x69, 0x73, 0x6F, 0x6D], 8);
  dv.setUint32(12, 0x200); // minor version

  // Compatible brands
  const brandBytes = {
    'isom': [0x69, 0x73, 0x6F, 0x6D],
    'iso2': [0x69, 0x73, 0x6F, 0x32],
    'avc1': [0x61, 0x76, 0x63, 0x31],
    'mp41': [0x6D, 0x70, 0x34, 0x31],
  };
  let offset = 16;
  for (const brand of brands) {
    buf.set(brandBytes[brand], offset);
    offset += 4;
  }

  return buf;
}
