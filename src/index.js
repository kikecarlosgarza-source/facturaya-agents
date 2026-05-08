require('dotenv').config();

const { startPoller } = require('./poller');

const REQUIRED = ['RENDER_API_KEY', 'OWNER_ID', 'BACKEND_SERVICE_ID', 'REINO_C_URL'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`[REINO B] Faltan variables de entorno: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('[REINO B] facturaya-agents arrancando...');
startPoller();
