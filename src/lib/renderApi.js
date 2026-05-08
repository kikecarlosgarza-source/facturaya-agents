const axios = require('axios');

const RENDER_API_BASE = 'https://api.render.com/v1';

async function getRecentLogs() {
  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.BACKEND_SERVICE_ID;
  if (!apiKey || !serviceId) {
    throw new Error('RENDER_API_KEY o BACKEND_SERVICE_ID no configurados');
  }

  const url = `${RENDER_API_BASE}/services/${serviceId}/logs`;
  const resp = await axios.get(url, {
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
