/**
 * utils/extractor.js — Signature & N-parameter deciphering.
 *
 * This module is the most maintenance-sensitive part of the extension.
 * YouTube periodically changes its player.js obfuscation, so the regex
 * patterns here may need updating.
 *
 * ──────────────────────────────────────────────────────────────
 * HOW YOUTUBE'S CIPHER WORKS (2026):
 *
 * 1. SIGNATURE CIPHER
 *    Some stream URLs are protected with a "signatureCipher" that contains
 *    an encrypted signature `s`. The decipher function in player.js applies
 *    a sequence of simple operations (swap, reverse, splice) to transform
 *    the encrypted signature into the real one.
 *
 * 2. N-PARAMETER (THROTTLE TOKEN)
 *    Every stream URL contains an `n` query parameter. YouTube throttles
 *    downloads if this parameter is not transformed by a function also
 *    found in player.js. The n-transform function is complex and changes
 *    frequently, so we extract and eval it in a sandboxed page.
 *
 * ──────────────────────────────────────────────────────────────
 * EXPORTED FUNCTIONS:
 *   - parseDecipherOps(playerJs)   → array of decipher operations
 *   - applyDecipherOps(sig, ops)   → deciphered signature string
 *   - parseSignatureCipher(cipher) → { s, sp, url }
 *   - extractNTransformCode(playerJs) → string of eval-able JS
 *   - buildStreamUrl(format, ops, nTransformFn) → final URL
 * ──────────────────────────────────────────────────────────────
 */

/* ─── 1. Signature Decipher ───────────────────────────────── */

/**
 * Patterns to locate the decipher function name in player.js.
 * Each entry is [regex, captureGroupIndex].
 * Ordered from most-specific (call-site) to least-specific (definition).
 * Sources: yt-dlp, Invidious, NewPipe — battle-tested across YouTube updates.
 */
const DECIPHER_FUNC_NAME_PATTERNS = [
  // ── Call-site patterns (where YouTube invokes the decipher function) ──
  // c&&d.set(b,encodeURIComponent(XX(decodeURIComponent(c))))
  [/\b[cs]\s*&&\s*[adf]\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\(/, 1],
  // ...,encodeURIComponent(XX(decodeURIComponent(c)))
  [/\b[a-zA-Z0-9]+\s*&&\s*[a-zA-Z0-9]+\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\(/, 1],
  // c&&c.set(b,XX(decodeURIComponent   (no encodeURIComponent wrapper)
  [/\b[a-zA-Z0-9]+\s*&&\s*[a-zA-Z0-9]+\.set\([^,]+\s*,\s*([a-zA-Z0-9$]+)\(decodeURIComponent/, 1],
  // m=XX(decodeURIComponent(h.s))
  [/\bm=([a-zA-Z0-9$]{2,})\(decodeURIComponent\(h\.s\)\)/, 1],
  // c&&d.set(b,encodeURIComponent(XX(
  [/\bc\s*&&\s*d\.set\([^,]+\s*,\s*(?:encodeURIComponent\s*\()([a-zA-Z0-9$]+)\(/, 1],
  // c&&c.set(b,encodeURIComponent(XX(
  [/\bc\s*&&\s*[a-z]\.set\([^,]+\s*,\s*encodeURIComponent\(([a-zA-Z0-9$]+)\(/, 1],
  // 2025+ pattern with typeof check:  && typeof X === "string" && (X = XX(decodeURIComponent(X))
  [/&&\s*typeof\s+\w+\s*===?\s*"string"\s*&&[^)]*\(([a-zA-Z0-9$]+)\(decodeURIComponent/, 1],
  // encodeURIComponent(XX(decodeURIComponent   (generic)
  [/encodeURIComponent\s*\(\s*([a-zA-Z0-9$]+)\s*\(\s*decodeURIComponent/, 1],
  // ;XX(decodeURIComponent
  [/;\s*([a-zA-Z0-9$]+)\s*\(\s*decodeURIComponent/, 1],
  // =XX(decodeURIComponent(
  [/=\s*([a-zA-Z0-9$]{2,})\s*\(\s*decodeURIComponent\s*\(/, 1],
  // "signature" , XX(
  [/(["'])signature\1\s*,\s*([a-zA-Z0-9$]+)\(/, 2],
  // .sig||XX(
  [/\.sig\|\|([a-zA-Z0-9$]+)\(/, 1],
  // ── Definition-based (least reliable — use last) ──
  [/\b([a-zA-Z0-9$]{2,})\s*=\s*function\(\s*a\s*\)\s*\{\s*a\s*=\s*a\.split\(\s*""\s*\)/, 1],
];

/**
 * Parse the decipher operations from the player JavaScript source.
 *
 * Returns an array of operations: [{ op: 'swap'|'splice'|'reverse', arg: number }]
 */
export function parseDecipherOps(playerJs) {
  // Step 1: Find the decipher function name via call-site patterns
  let funcName = null;
  for (const [pattern, groupIdx] of DECIPHER_FUNC_NAME_PATTERNS) {
    const match = playerJs.match(pattern);
    if (match?.[groupIdx]) {
      funcName = match[groupIdx];
      console.log(`[Extractor] Decipher function name "${funcName}" found via pattern: ${pattern.source.slice(0, 60)}…`);
      break;
    }
  }

  // Step 1b: Structural fallback — find by function shape
  if (!funcName) {
    console.log('[Extractor] Call-site regex failed. Trying structural detection…');
    funcName = findDecipherFuncByStructure(playerJs);
  }

  if (!funcName) {
    console.error('[Extractor] Could not find decipher function name by any method');
    return [];
  }

  // Step 2: Extract the function body
  const funcBody = extractFuncBody(playerJs, funcName);
  if (!funcBody) {
    console.error('[Extractor] Could not extract decipher function body for:', funcName);
    return [];
  }

  // Step 3: Find the helper object name (e.g., from `Xy.rP(a, 2)` → Xy)
  const helperRefPattern = /([a-zA-Z0-9$]{2,})\.[a-zA-Z0-9$]+\(\s*a\s*[,)]/;
  const helperMatch = funcBody.match(helperRefPattern);
  if (!helperMatch?.[1]) {
    console.error('[Extractor] Could not find helper object reference in:', funcBody.slice(0, 200));
    return [];
  }
  const helperName = helperMatch[1];
  console.log(`[Extractor] Helper object name: "${helperName}"`);

  // Step 4: Extract the helper object definition and classify methods
  const methods = extractHelperMethods(playerJs, helperName);
  if (Object.keys(methods).length === 0) {
    console.error('[Extractor] Could not extract helper methods for:', helperName);
    return [];
  }
  console.log('[Extractor] Helper methods:', JSON.stringify(methods));

  // Step 5: Parse each line of the decipher function into operations
  const operations = [];
  const lines = funcBody.split(';');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('a=a.split') || trimmed.startsWith('return')) continue;

    // Match: XX.YY(a, N) or XX.YY(a)
    const callMatch = trimmed.match(
      new RegExp(`${escapeRegex(helperName)}\\.([a-zA-Z0-9$]+)\\(\\s*a\\s*(?:,\\s*(\\d+))?\\s*\\)`)
    );
    if (callMatch) {
      const methodName = callMatch[1];
      const arg = callMatch[2] ? parseInt(callMatch[2], 10) : 0;
      const op = methods[methodName];
      if (op) {
        operations.push({ op, arg });
      }
    }
  }

  console.log(`[Extractor] Parsed ${operations.length} decipher operations`);
  return operations;
}

/**
 * Extract the body of a named function from the player JS source.
 * Handles both `XX = function(a){…}` and `function XX(a){…}` forms.
 * Returns the inner body text (without the outer braces) or null.
 */
function extractFuncBody(playerJs, funcName) {
  const escaped = escapeRegex(funcName);

  // Try: var/let/const XX = function(a) { ... };
  let startPattern = new RegExp(
    `(?:(?:var|let|const)\\s+)?${escaped}\\s*=\\s*function\\s*\\([^)]*\\)\\s*\\{`
  );
  let funcStartMatch = startPattern.exec(playerJs);

  // Try: function XX(a) { ... }
  if (!funcStartMatch) {
    startPattern = new RegExp(`function\\s+${escaped}\\s*\\([^)]*\\)\\s*\\{`);
    funcStartMatch = startPattern.exec(playerJs);
  }

  if (!funcStartMatch) return null;

  const bodyStart = playerJs.indexOf('{', funcStartMatch.index);
  if (bodyStart === -1) return null;

  let depth = 0;
  let bodyEnd = bodyStart;
  for (let i = bodyStart; i < playerJs.length; i++) {
    if (playerJs[i] === '{') depth++;
    else if (playerJs[i] === '}') {
      depth--;
      if (depth === 0) { bodyEnd = i; break; }
    }
  }
  return playerJs.substring(bodyStart + 1, bodyEnd);
}

/**
 * Structural fallback: find the decipher function by its characteristic shape
 * rather than by how it's referenced.
 *
 * The decipher function always:
 *  1. Takes a single parameter (a)
 *  2. Calls a.split("")
 *  3. Calls methods on a helper object that has swap/reverse/splice semantics
 *  4. Returns a.join("")
 *  5. Is relatively short (< 2000 chars — unlike the n-transform function)
 */
function findDecipherFuncByStructure(playerJs) {
  const pattern = /\b([a-zA-Z0-9$]{2,})\s*=\s*function\(\s*a\s*\)\s*\{\s*a\s*=\s*a\.split\(\s*""\s*\)/g;
  let match;

  while ((match = pattern.exec(playerJs)) !== null) {
    const candidateName = match[1];

    // Extract this candidate's body
    const body = extractFuncBody(playerJs, candidateName);
    if (!body || body.length > 2000) continue; // too long → probably n-transform

    // Must contain a.join("")
    if (!body.includes('a.join("")') && !body.includes("a.join('')")) continue;

    // Must reference a helper object: OBJ.method(a, N)
    const helperRef = body.match(/([a-zA-Z0-9$]{2,})\.[a-zA-Z0-9$]+\(\s*a\s*[,)]/);
    if (!helperRef?.[1]) continue;

    // Verify the helper object has ≥ 2 classified methods
    const methods = extractHelperMethods(playerJs, helperRef[1]);
    if (Object.keys(methods).length >= 2) {
      console.log(`[Extractor] Found decipher function by structure: "${candidateName}" (helper: "${helperRef[1]}")`);
      return candidateName;
    }
  }

  return null;
}

/**
 * Extract and classify the helper object's methods.
 * Returns { methodName: 'swap'|'splice'|'reverse' }
 */
function extractHelperMethods(playerJs, objName) {
  const escaped = escapeRegex(objName);

  // Match the object definition: var/let/const Xy = { … };  or  Xy = { … };
  // The object can span multiple lines, so we use a bracket-counting approach
  const objStartPattern = new RegExp(`(?:(?:var|let|const)\\s+)?${escaped}\\s*=\\s*\\{`);
  const startMatch = objStartPattern.exec(playerJs);
  if (!startMatch) {
    console.warn(`[Extractor] Could not find helper object definition for: ${objName}`);
    return {};
  }

  const openIdx = playerJs.indexOf('{', startMatch.index);
  let depth = 0;
  let endIdx = openIdx;
  for (let i = openIdx; i < playerJs.length; i++) {
    if (playerJs[i] === '{') depth++;
    else if (playerJs[i] === '}') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }

  const objBody = playerJs.substring(openIdx + 1, endIdx);

  // Parse each method using brace-counting to handle nested braces
  const methods = {};
  const methodNamePattern = /([a-zA-Z0-9$]+)\s*:\s*function\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = methodNamePattern.exec(objBody)) !== null) {
    const name = m[1];
    const methodBodyStart = m.index + m[0].length - 1; // position of '{'
    let mDepth = 0;
    let methodBodyEnd = methodBodyStart;
    for (let i = methodBodyStart; i < objBody.length; i++) {
      if (objBody[i] === '{') mDepth++;
      else if (objBody[i] === '}') {
        mDepth--;
        if (mDepth === 0) { methodBodyEnd = i; break; }
      }
    }
    const body = objBody.substring(methodBodyStart + 1, methodBodyEnd);

    if (body.includes('.reverse()') || body.includes('reverse()')) {
      methods[name] = 'reverse';
    } else if (body.includes('.splice(') || body.includes('splice(')) {
      methods[name] = 'splice';
    } else {
      // Default: swap (exchanges a[0] with a[b%a.length])
      methods[name] = 'swap';
    }
  }

  return methods;
}

/**
 * Apply decipher operations to a signature string.
 */
export function applyDecipherOps(signature, operations) {
  const a = signature.split('');

  for (const { op, arg } of operations) {
    switch (op) {
      case 'reverse':
        a.reverse();
        break;
      case 'splice':
        a.splice(0, arg);
        break;
      case 'swap': {
        const pos = arg % a.length;
        const tmp = a[0];
        a[0] = a[pos];
        a[pos] = tmp;
        break;
      }
    }
  }

  return a.join('');
}

/* ─── 2. Signature Cipher Parsing ─────────────────────────── */

/**
 * Parse a `signatureCipher` string into its components.
 * The signatureCipher is URL-encoded and contains:
 *   s=ENCRYPTED_SIG & sp=PARAM_NAME & url=STREAM_URL
 */
export function parseSignatureCipher(cipherString) {
  const params = new URLSearchParams(cipherString);
  return {
    s: params.get('s') || '',          // encrypted signature
    sp: params.get('sp') || 'sig',     // signature parameter name (usually "sig")
    url: params.get('url') || '',      // base stream URL
  };
}

/* ─── 3. N-Parameter (Throttle Token) ────────────────────── */

/**
 * Regular expressions to find the n-transform function name.
 * YouTube uses the n-parameter for rate-limiting; without transforming it,
 * download speeds are heavily throttled.
 */
const N_TRANSFORM_NAME_PATTERNS = [
  // Standard: &&(b=a.get("n"))&&(b=XX(b),a.set("n",b))
  [/&&\s*\(b\s*=\s*a\.get\("n"\)\)\s*&&\s*\(b\s*=\s*([a-zA-Z0-9$]+)(?:\[(\d+)\])?\s*\(b\)/, 1, 2],
  // Variant with whitespace differences
  [/\(b=a\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]+)\[(\d+)\]\(b\)/, 1, 2],
  // 2025+ with typeof check: a.D && typeof a.D == "string" && (b=a.get("n")) && (b=XX[0](b)
  [/typeof\s+\w+(?:\.\w+)?\s*===?\s*"string"\s*&&\s*\(b\s*=\s*a\.get\("n"\)\)\s*&&\s*\(b\s*=\s*([a-zA-Z0-9$]+)(?:\[(\d+)\])?\s*\(b\)/, 1, 2],
  // (b=XX[0](b)),a.set("n",b)
  [/\(b\s*=\s*([a-zA-Z0-9$]{2,})(?:\[(\d+)\])?\s*\(b\)\s*\)\s*,\s*\w+\.set\("n"\s*,\s*b\)/, 1, 2],
  // b=XX[0](b);a.set("n",b)
  [/;\s*b\s*=\s*([a-zA-Z0-9$]{2,})(?:\[(\d+)\])?\s*\(b\)\s*[;,]\s*\w+\.set\("n"\s*,\s*b\)/, 1, 2],
  // Broad fallback: any XX[N](b) near "n"
  [/\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]+)(?:\[(\d+)\])?\(b\)/, 1, 2],
];

/**
 * Extract the n-transform function code from player.js.
 * Returns an eval-able string that defines a function for transforming
 * the `n` parameter value.
 *
 * Because this function is extremely complex and obfuscated, we cannot
 * parse it into simple operations like the decipher function.
 * Instead, we extract the raw code and eval it in a sandboxed context.
 */
export function extractNTransformCode(playerJs) {
  let funcName = null;
  let arrayIndex = null;

  for (const [pattern, nameGroup, idxGroup] of N_TRANSFORM_NAME_PATTERNS) {
    const match = playerJs.match(pattern);
    if (match?.[nameGroup]) {
      funcName = match[nameGroup];
      arrayIndex = (idxGroup && match[idxGroup]) ? parseInt(match[idxGroup], 10) : null;
      console.log(`[Extractor] n-transform name "${funcName}" (index=${arrayIndex}) via: ${pattern.source.slice(0, 60)}…`);
      break;
    }
  }

  if (!funcName) {
    console.warn('[Extractor] Could not find n-transform function name');
    return null;
  }

  // If it's an array reference like XX[0], resolve to the actual function name
  if (arrayIndex !== null) {
    const actualName = resolveArrayFunction(playerJs, funcName, arrayIndex);
    if (actualName) {
      console.log(`[Extractor] Resolved n-transform array ref ${funcName}[${arrayIndex}] → "${actualName}"`);
      funcName = actualName;
    } else {
      console.warn(`[Extractor] Failed to resolve array ref ${funcName}[${arrayIndex}]`);
    }
  }

  // Extract the complete function code
  const code = extractFunctionWithDeps(playerJs, funcName);
  if (!code) {
    console.warn('[Extractor] Could not extract n-transform function code for:', funcName);
    return null;
  }

  // Wrap it so it can be eval'd and called
  return `var nTransform = ${code}; nTransform;`;
}

/**
 * Resolve an array reference to the actual function name.
 * e.g., var XX = [func1, func2]; XX[0] → func1
 */
function resolveArrayFunction(playerJs, arrayName, index) {
  const escaped = escapeRegex(arrayName);

  // Try: var/let/const XX = [func1, func2];
  let pattern = new RegExp(`(?:var|let|const)\\s+${escaped}\\s*=\\s*\\[([^\\]]+)\\]`);
  let match = playerJs.match(pattern);

  // Also try without declaration keyword: XX = [func1, func2];
  if (!match?.[1]) {
    pattern = new RegExp(`${escaped}\\s*=\\s*\\[([^\\]]+)\\]`);
    match = playerJs.match(pattern);
  }

  if (!match?.[1]) {
    console.warn(`[Extractor] Could not find array definition for: ${arrayName}`);
    return null;
  }

  const elements = match[1].split(',').map(s => s.trim());
  const resolved = elements[index];
  if (!resolved) {
    console.warn(`[Extractor] Array ${arrayName} has no element at index ${index} (length: ${elements.length})`);
  }
  return resolved || null;
}

/**
 * Extract a function definition and its immediate dependencies from the source.
 * Handles: var name = function(a) { ... }
 */
function extractFunctionWithDeps(js, funcName) {
  const escaped = escapeRegex(funcName);

  // Try: var XX = function(a) { ... };
  let startPattern = new RegExp(`(?:var\\s+)?${escaped}\\s*=\\s*function`);
  let match = startPattern.exec(js);

  // Try: function XX(a) { ... }
  if (!match) {
    startPattern = new RegExp(`function\\s+${escaped}\\s*\\(`);
    match = startPattern.exec(js);
  }

  if (!match) return null;

  // Find the function keyword and opening paren
  const funcKeywordIdx = js.indexOf('function', match.index);
  if (funcKeywordIdx === -1) return null;

  // Find the opening brace
  const braceStart = js.indexOf('{', funcKeywordIdx);
  if (braceStart === -1) return null;

  // Count braces to find the end
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  // Extract from "function" to the closing brace
  const funcCode = js.substring(funcKeywordIdx, end + 1);
  return funcCode;
}

/* ─── 4. URL Processing ──────────────────────────────────── */

/**
 * Process a single format object to produce a final usable URL.
 *
 * @param {object}   format        - Format with `url` or `signatureCipher`
 * @param {Array}    decipherOps   - Operations from parseDecipherOps()
 * @param {Function} nTransformFn  - Function to transform the n-parameter (optional)
 * @returns {string|null} The final stream URL
 */
export function buildStreamUrl(format, decipherOps = [], nTransformFn = null) {
  let url;

  if (format.url) {
    // URL is provided directly (no cipher needed)
    url = format.url;
  } else if (format.signatureCipher) {
    // Need to decipher the signature
    const { s, sp, url: baseUrl } = parseSignatureCipher(format.signatureCipher);
    if (!s || !baseUrl) return null;

    const deciphered = applyDecipherOps(s, decipherOps);
    url = `${baseUrl}&${sp}=${encodeURIComponent(deciphered)}`;
  } else {
    return null;
  }

  // Transform the n-parameter if we have the function
  if (nTransformFn && url) {
    try {
      const urlObj = new URL(url);
      const n = urlObj.searchParams.get('n');
      if (n) {
        const transformed = nTransformFn(n);
        if (transformed && typeof transformed === 'string') {
          urlObj.searchParams.set('n', transformed);
          url = urlObj.toString();
        }
      }
    } catch (err) {
      console.warn('[Extractor] n-transform failed:', err.message);
      // Continue with original URL (may be throttled)
    }
  }

  return url;
}

/* ─── 5. Player.js Fetching ───────────────────────────────── */

/**
 * Fetch and cache the player.js source code.
 * Uses chrome.storage.session (MV3) to avoid re-fetching within a session.
 */
let playerJsCache = { url: null, source: null };

export async function fetchPlayerJs(playerJsUrl) {
  if (!playerJsUrl) return null;

  // Check in-memory cache
  if (playerJsCache.url === playerJsUrl && playerJsCache.source) {
    return playerJsCache.source;
  }

  try {
    const response = await fetch(playerJsUrl, {
      headers: { 'Accept': '*/*' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const source = await response.text();
    playerJsCache = { url: playerJsUrl, source };
    return source;
  } catch (err) {
    console.error('[Extractor] Failed to fetch player.js:', err);
    return null;
  }
}

/* ─── Helpers ─────────────────────────────────────────────── */

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
