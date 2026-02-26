// signature decipher + n-param extraction from player.js
// TODO: update patterns when youtube changes their obfuscation


const DECIPHER_FUNC_NAME_PATTERNS = [
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
  [/\b([a-zA-Z0-9$]{2,})\s*=\s*function\(\s*a\s*\)\s*\{\s*a\s*=\s*a\.split\(\s*""\s*\)/, 1],
];

export function parseDecipherOps(playerJs) {
  let funcName = null;
  for (const [pattern, groupIdx] of DECIPHER_FUNC_NAME_PATTERNS) {
    const match = playerJs.match(pattern);
    if (match?.[groupIdx]) {
      funcName = match[groupIdx];
      console.log(`[Extractor] Decipher function name "${funcName}" found via pattern: ${pattern.source.slice(0, 60)}…`);
      break;
    }
  }

  if (!funcName) {
    console.log('[Extractor] Call-site regex failed. Trying structural detection…');
    funcName = findDecipherFuncByStructure(playerJs);
  }

  if (!funcName) {
    console.error('[Extractor] Could not find decipher function name by any method');
    return [];
  }

  const funcBody = extractFuncBody(playerJs, funcName);
  if (!funcBody) {
    console.error('[Extractor] Could not extract decipher function body for:', funcName);
    return [];
  }

  const helperRefPattern = /([a-zA-Z0-9$]{2,})\.[a-zA-Z0-9$]+\(\s*a\s*[,)]/;
  const helperMatch = funcBody.match(helperRefPattern);
  if (!helperMatch?.[1]) {
    console.error('[Extractor] Could not find helper object reference in:', funcBody.slice(0, 200));
    return [];
  }
  const helperName = helperMatch[1];
  console.log(`[Extractor] Helper object name: "${helperName}"`);

  const methods = extractHelperMethods(playerJs, helperName);
  if (Object.keys(methods).length === 0) {
    console.error('[Extractor] Could not extract helper methods for:', helperName);
    return [];
  }
  console.log('[Extractor] Helper methods:', JSON.stringify(methods));

  const operations = [];
  const lines = funcBody.split(';');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('a=a.split') || trimmed.startsWith('return')) continue;

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


export function parseSignatureCipher(cipherString) {
  const params = new URLSearchParams(cipherString);
  return {
    s: params.get('s') || '',          // encrypted signature
    sp: params.get('sp') || 'sig',     // signature parameter name (usually "sig")
    url: params.get('url') || '',      // base stream URL
  };
}


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


export function buildStreamUrl(format, decipherOps = [], nTransformFn = null) {
  let url;

  if (format.url) {
      url = format.url;
  } else if (format.signatureCipher) {
      const { s, sp, url: baseUrl } = parseSignatureCipher(format.signatureCipher);
    if (!s || !baseUrl) return null;

    const deciphered = applyDecipherOps(s, decipherOps);
    url = `${baseUrl}&${sp}=${encodeURIComponent(deciphered)}`;
  } else {
    return null;
  }

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
    }
  }

  return url;
}


let playerJsCache = { url: null, source: null };

export async function fetchPlayerJs(playerJsUrl) {
  if (!playerJsUrl) return null;

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


function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
