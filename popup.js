/**
 * popup.js — UI controller for the YouTube Downloader popup.
 *
 * Communicates with background.js (service worker) to:
 *  1. Fetch available formats for the current video.
 *  2. Trigger downloads at the chosen quality.
 */

/* ─── DOM references ──────────────────────────────────────── */
const $loading       = document.getElementById('loading');
const $error         = document.getElementById('error');
const $errorMsg      = document.getElementById('error-msg');
const $retryBtn      = document.getElementById('retry-btn');
const $main          = document.getElementById('main');
const $thumbnail     = document.getElementById('thumbnail');
const $videoTitle    = document.getElementById('video-title');
const $videoDuration = document.getElementById('video-duration');
const $videoQuality  = document.getElementById('video-quality');
const $audioQuality  = document.getElementById('audio-quality');
const $downloadMp4   = document.getElementById('download-mp4');
const $downloadAudio = document.getElementById('download-audio');
const $videoSize     = document.getElementById('video-size');
const $audioSize     = document.getElementById('audio-size');
const $muxNotice     = document.getElementById('mux-notice');
const $progressCont  = document.getElementById('progress-container');
const $progressLabel = document.getElementById('progress-label');
const $progressPct   = document.getElementById('progress-pct');
const $progressFill  = document.getElementById('progress-fill');
const $status        = document.getElementById('status');

/* ─── State ───────────────────────────────────────────────── */
let videoData = null;   // full response from background
let isDownloading = false;

/* ─── Helpers ─────────────────────────────────────────────── */
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function setStatus(msg, type = 'info') {
  $status.textContent = msg;
  $status.className = `status ${type}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h) parts.push(String(h));
  parts.push(h ? String(m).padStart(2, '0') : String(m));
  parts.push(String(s).padStart(2, '0'));
  return parts.join(':');
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/* ─── Communication with background ──────────────────────── */
function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

/* ─── Format mapping ─────────────────────────────────────── */

/**
 * Find the best matching video format for the chosen quality.
 * Prefers muxed streams (have both audio+video) for ≤720p.
 * Falls back to adaptive (video-only) for 1080p.
 */
function pickVideoFormat(quality) {
  if (!videoData?.formats) return null;

  const targetHeight = parseInt(quality, 10);
  const { muxed, adaptive } = videoData.formats;

  // For 720p and below, prefer muxed streams (no muxing needed)
  if (targetHeight <= 720) {
    // Try muxed first
    const muxedMatch = muxed
      .filter(f => f.height <= targetHeight && f.mimeType?.startsWith('video/mp4'))
      .sort((a, b) => b.height - a.height)[0];
    if (muxedMatch) return { ...muxedMatch, needsMux: false };
  }

  // Try adaptive video-only for the target quality
  const adaptiveMatch = adaptive
    .filter(f => f.height <= targetHeight &&
                 f.mimeType?.startsWith('video/mp4') &&
                 !f.mimeType?.includes('audio'))
    .sort((a, b) => b.height - a.height)[0];

  if (adaptiveMatch) return { ...adaptiveMatch, needsMux: true };

  // Fallback: any muxed format
  const fallback = muxed
    .filter(f => f.mimeType?.startsWith('video/mp4'))
    .sort((a, b) => b.height - a.height)[0];
  if (fallback) return { ...fallback, needsMux: false };

  return null;
}

/**
 * Find the best audio format matching the chosen bitrate.
 */
function pickAudioFormat(quality) {
  if (!videoData?.formats) return null;

  const targetBitrate = parseInt(quality, 10) * 1000; // kbps → bps
  const { adaptive } = videoData.formats;

  // Prefer M4A (AAC) audio streams
  const audioStreams = adaptive
    .filter(f => f.mimeType?.startsWith('audio/mp4') || f.mimeType?.startsWith('audio/webm'))
    .sort((a, b) => b.bitrate - a.bitrate);

  // Find closest match at or below target
  const match = audioStreams.find(f => f.bitrate <= targetBitrate) || audioStreams[audioStreams.length - 1];
  return match || null;
}

/**
 * Get the best audio stream for muxing with 1080p video.
 */
function pickMuxAudio() {
  if (!videoData?.formats) return null;
  const { adaptive } = videoData.formats;
  return adaptive
    .filter(f => f.mimeType?.startsWith('audio/mp4'))
    .sort((a, b) => b.bitrate - a.bitrate)[0] || null;
}

/* ─── Size display ────────────────────────────────────────── */
function updateSizeHints() {
  const vf = pickVideoFormat($videoQuality.value);
  const af = pickAudioFormat($audioQuality.value);

  $videoSize.textContent = vf?.contentLength
    ? `≈ ${formatBytes(parseInt(vf.contentLength, 10))}${vf.needsMux ? ' (requires muxing)' : ' (muxed)'}`
    : '';

  $audioSize.textContent = af?.contentLength
    ? `≈ ${formatBytes(parseInt(af.contentLength, 10))}`
    : '';

  // Show 1080p mux notice
  if (parseInt($videoQuality.value, 10) > 720) {
    show($muxNotice);
  } else {
    hide($muxNotice);
  }
}

/* ─── Populate available qualities ────────────────────────── */
function populateQualities() {
  if (!videoData?.formats) return;

  const { muxed, adaptive } = videoData.formats;
  const allHeights = new Set();
  muxed.forEach(f => { if (f.height) allHeights.add(f.height); });
  adaptive.forEach(f => { if (f.height) allHeights.add(f.height); });

  const available = [...allHeights].sort((a, b) => b - a);
  const wanted = [1080, 720, 480, 360];

  // Disable quality options that aren't available
  for (const opt of $videoQuality.options) {
    const h = parseInt(opt.value, 10);
    // Keep it enabled if we have that quality or anything close
    const closest = available.find(a => a >= h - 20 && a <= h + 20);
    if (!closest && !available.some(a => a >= h)) {
      opt.disabled = true;
    }
  }

  // Select highest available that's ≤720 by default
  const bestDefault = available.find(h => h <= 720) || available[0];
  if (bestDefault) {
    const matchOpt = [...$videoQuality.options].find(o => parseInt(o.value) >= bestDefault - 20 && parseInt(o.value) <= bestDefault + 20);
    if (matchOpt) matchOpt.selected = true;
  }

  // Audio: check what's available
  const audioBitrates = adaptive
    .filter(f => f.mimeType?.startsWith('audio/'))
    .map(f => Math.round(f.bitrate / 1000));

  for (const opt of $audioQuality.options) {
    const target = parseInt(opt.value, 10);
    const hasClose = audioBitrates.some(b => b >= target - 30);
    if (!hasClose) opt.disabled = true;
  }
}

/* ─── Init: load video info ───────────────────────────────── */
async function init() {
  show($loading);
  hide($error);
  hide($main);
  hide($progressCont);
  setStatus('');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) throw new Error('Cannot access the current tab.');

    const url = new URL(tab.url);
    const isWatch = url.hostname.includes('youtube.com') &&
                    (url.pathname.startsWith('/watch') || url.pathname.startsWith('/shorts'));
    if (!isWatch) throw new Error('Navigate to a YouTube video first.');

    const response = await sendMessage({ action: 'getVideoInfo', tabId: tab.id });

    if (!response?.success) {
      throw new Error(response?.error || 'Failed to fetch video information.');
    }

    videoData = response.data;

    // Populate UI
    $videoTitle.textContent = videoData.title || 'Unknown Title';
    $videoDuration.textContent = videoData.duration
      ? `Duration: ${formatDuration(parseInt(videoData.duration, 10))}`
      : '';
    $thumbnail.src = videoData.thumbnail || '';

    populateQualities();
    updateSizeHints();

    hide($loading);
    show($main);
    setStatus('Ready', 'success');

  } catch (err) {
    hide($loading);
    show($error);
    $errorMsg.textContent = err.message || 'An unexpected error occurred.';
  }
}

/* ─── Download handlers ───────────────────────────────────── */
async function handleDownload(type) {
  if (isDownloading) return;

  let format, muxAudio;
  const title = sanitizeFilename(videoData.title || 'video');

  if (type === 'video') {
    format = pickVideoFormat($videoQuality.value);
    if (!format) { setStatus('No matching video format found.', 'error'); return; }
    if (format.needsMux) {
      muxAudio = pickMuxAudio();
    }
  } else {
    format = pickAudioFormat($audioQuality.value);
    if (!format) { setStatus('No matching audio format found.', 'error'); return; }
  }

  isDownloading = true;
  $downloadMp4.disabled = true;
  $downloadAudio.disabled = true;
  show($progressCont);
  updateProgress(0, 'Preparing download…');

  try {
    const qualityLabel = type === 'video'
      ? `${format.qualityLabel || format.height + 'p'}`
      : `${Math.round(format.bitrate / 1000)}kbps`;
    const ext = type === 'video' ? 'mp4' : 'm4a';
    const filename = `${title} - ${qualityLabel}.${ext}`;

    const response = await sendMessage({
      action: 'download',
      format: {
        url: format.url,
        itag: format.itag,
        mimeType: format.mimeType,
        contentLength: format.contentLength,
      },
      muxAudio: format.needsMux && muxAudio ? {
        url: muxAudio.url,
        itag: muxAudio.itag,
        mimeType: muxAudio.mimeType,
        contentLength: muxAudio.contentLength,
      } : null,
      filename,
      type,
      needsMux: format.needsMux || false,
    });

    if (response?.success) {
      updateProgress(100, 'Complete!');
      setStatus(`Downloaded: ${filename}`, 'success');
    } else {
      throw new Error(response?.error || 'Download failed.');
    }
  } catch (err) {
    setStatus(err.message, 'error');
    updateProgress(0, 'Failed');
  } finally {
    isDownloading = false;
    $downloadMp4.disabled = false;
    $downloadAudio.disabled = false;
    setTimeout(() => hide($progressCont), 3000);
  }
}

function updateProgress(pct, label) {
  $progressFill.style.width = `${pct}%`;
  $progressPct.textContent = `${Math.round(pct)}%`;
  if (label) $progressLabel.textContent = label;
}

/* ─── Listen for progress updates from background ─────────── */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'downloadProgress') {
    updateProgress(msg.percent, msg.label);
  }
  return false;
});

/* ─── Events ──────────────────────────────────────────────── */
$downloadMp4.addEventListener('click', () => handleDownload('video'));
$downloadAudio.addEventListener('click', () => handleDownload('audio'));
$retryBtn.addEventListener('click', init);

$videoQuality.addEventListener('change', updateSizeHints);
$audioQuality.addEventListener('change', updateSizeHints);

/* ─── Boot ────────────────────────────────────────────────── */
init();
