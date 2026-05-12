const renderApi = require('./lib/renderApi');
const detector = require('./detector');

const POLL_INTERVAL_MS = 30000;

async function pollOnce() {
  try {
    console.log('[REINO B] Polling logs Render...');
    const logs = await renderApi.getRecentLogs();
    await detector.scanLogs(logs);
  } catch (err) {
    console.error(`[REINO B] Error en poll: ${err.message}`);
  }
}

function startPoller() {
  console.log(`[REINO B] Poller arrancado (interval=${POLL_INTERVAL_MS}ms)`);
  pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

module.exports = { startPoller };
