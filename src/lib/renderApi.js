const axios = require('axios');

const RENDER_API_BASE = 'https://api.render.com/v1';

async function getRecentLogs() {
  const apiKey = process.env.RENDER_API_KEY;
  const ownerId = process.env.OWNER_ID;
  const serviceId = process.env.BACKEND_SERVICE_ID;
  if (!apiKey || !ownerId || !serviceId) {
    throw new Error('RENDER_API_KEY, OWNER_ID o BACKEND_SERVICE_ID no configurados');
  }

  const url = `${RENDER_API_BASE}/logs`;
  const resp = await axios.get(url, {
    params: {
      ownerId,
      resource: serviceId,
      type: 'app',
      limit: 100,
      direction: 'backward'
    },
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    },
    timeout: 15000,
    validateStatus: () => true
  });

  if (resp.status >= 400) {
    throw new Error(`Render API ${resp.status}: ${JSON.stringify(resp.data).substring(0, 300)}`);
  }
  return resp.data;
}

module.exports = { getRecentLogs };
