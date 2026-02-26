// eval sandbox for n-transform functions

let nTransformFunction = null;

window.addEventListener('message', (event) => {
  const { action, id } = event.data;

  try {
    switch (action) {
      case 'evalNTransform': {
        const code = event.data.code;
        if (!code) {
          respond(event, id, { success: false, error: 'No code provided.' });
          return;
        }

        try {
          nTransformFunction = eval(code);

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

function respond(event, id, data) {
  event.source.postMessage({ ...data, id, from: 'sandbox' }, event.origin);
}

window.parent.postMessage({ from: 'sandbox', ready: true }, '*');
