/**
 * sandbox.js — Runs inside the sandboxed iframe (sandbox.html).
 *
 * This page has a relaxed CSP that allows eval(). It is used to evaluate
 * YouTube's dynamically-extracted cipher functions, which are too complex
 * to parse natively.
 *
 * Communication:
 *   offscreen.js  ──postMessage──>  sandbox.js
 *   sandbox.js    ──postMessage──>  offscreen.js
 *
 * Supported actions:
 *   - evalNTransform: Evaluate and store the n-transform function
 *   - transformN:     Call the stored n-transform function with a value
 */

/* ─── State ───────────────────────────────────────────────── */
let nTransformFunction = null;

/* ─── Message Handler ─────────────────────────────────────── */
window.addEventListener('message', (event) => {
  const { action, id } = event.data;

  try {
    switch (action) {
      case 'evalNTransform': {
        // Evaluate the extracted n-transform function code
        const code = event.data.code;
        if (!code) {
          respond(event, id, { success: false, error: 'No code provided.' });
          return;
        }

        // The code should define and return a function
        // e.g.: "var nTransform = function(a) { ... }; nTransform;"
        try {
          /* eslint-disable no-eval */
          nTransformFunction = eval(code);
          /* eslint-enable no-eval */

          if (typeof nTransformFunction !== 'function') {
            nTransformFunction = null;
            respond(event, id, { success: false, error: 'Evaluated code did not produce a function.' });
            return;
          }

          respond(event, id, { success: true });
        } catch (evalErr) {
          nTransformFunction = null;
          respond(event, id, { success: false, error: `Eval error: ${evalErr.message}` });
        }
        break;
      }

      case 'transformN': {
        // Transform an n-parameter value using the stored function
        const value = event.data.value;
        if (!nTransformFunction) {
          respond(event, id, { success: false, error: 'n-transform function not loaded.' });
          return;
        }

        try {
          const transformed = nTransformFunction(value);
          respond(event, id, { success: true, transformed });
        } catch (transformErr) {
          respond(event, id, { success: false, error: `Transform error: ${transformErr.message}` });
        }
        break;
      }

      case 'ping': {
        respond(event, id, { success: true, pong: true });
        break;
      }

      default:
        respond(event, id, { success: false, error: `Unknown action: ${action}` });
    }
  } catch (err) {
    respond(event, id, { success: false, error: err.message });
  }
});

/**
 * Send a response back to the parent (offscreen document).
 */
function respond(event, id, data) {
  event.source.postMessage({ ...data, id, from: 'sandbox' }, event.origin);
}

// Signal that the sandbox is ready
window.parent.postMessage({ from: 'sandbox', ready: true }, '*');
