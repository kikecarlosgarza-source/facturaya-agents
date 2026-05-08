const axios = require('axios');

const REINO_C_URL = process.env.REINO_C_URL || 'https://facturaya-sandbox.onrender.com';
const DEPLOY_WAIT_MS = 5 * 60 * 1000; // 5 min para que Reino C buildee tras el push
const POLL_INTERVAL_MS = 30 * 1000;   // poll cada 30s

async function esperarDeployReinoC({ commitHashEsperado }) {
  // Espera hasta que el endpoint /health responda OK con el commit nuevo, o timeout
  const inicio = Date.now();
  while (Date.now() - inicio < DEPLOY_WAIT_MS) {
    try {
      const resp = await axios.get(`${REINO_C_URL}/health`, { timeout: 10000, validateStatus: () => true });
      if (resp.status === 200) {
        console.log(`[REINO B - TESTER] Reino C respondiendo OK tras ${Math.round((Date.now() - inicio) / 1000)}s`);
        return { ready: true };
      }
    } catch (err) {
      // sigue esperando
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ready: false, error: 'Timeout esperando deploy Reino C' };
}

async function probarHandler({ portal, ticketData, perfil }) {
  console.log(`[REINO B - TESTER] Probando handler ${portal} en Reino C`);

  try {
    const resp = await axios.post(
      `${REINO_C_URL}/api/test-handler`,
      { portal, ticketData, perfil },
      {
        timeout: 3 * 60 * 1000, // 3 min para que Playwright corra
        validateStatus: () => true
      }
    );

    return {
      status: resp.status,
      body: resp.data,
      pasoLaPrueba: resp.status === 200 && resp.data?.exito === true
    };
  } catch (err) {
    return {
      status: 0,
      error: err.message,
      pasoLaPrueba: false
    };
  }
}

module.exports = { esperarDeployReinoC, probarHandler };
