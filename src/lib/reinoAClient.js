// reinoAClient.js — cliente HTTP para tracking persistente de intentos de Reino B
// Reino A (facturasat-backend) expone endpoints autenticados con shared secret:
//   GET  /api/reino-b/intentos/:dedupKey  (consultar historial)
//   POST /api/reino-b/intentos            (reportar resultado)
// Best-effort: si Reino A está caído/401/timeout, Reino B sigue funcionando
// con comportamiento "sin historial" (default actual sin tracking).

const axios = require('axios');

const REINO_A_URL = process.env.REINO_A_URL || 'https://facturasat.onrender.com';
const REINO_B_SECRET = process.env.REINO_B_SECRET || '';
const TIMEOUT_MS = 10000;

function isEnabled() {
  return !!REINO_A_URL && !!REINO_B_SECRET;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-Reino-B-Secret': REINO_B_SECRET
  };
}

async function consultarIntentos(dedupKey) {
  if (!isEnabled()) {
    console.warn('[REINO B] reinoAClient deshabilitado (faltan env vars REINO_A_URL o REINO_B_SECRET)');
    return { intentos: [], total: 0, ya_timbrado: false, _disabled: true };
  }
  try {
    const r = await axios.get(
      `${REINO_A_URL}/api/reino-b/intentos/${encodeURIComponent(dedupKey)}`,
      { headers: headers(), timeout: TIMEOUT_MS }
    );
    return r.data;
  } catch (e) {
    console.warn(`[REINO B] reinoAClient.consultarIntentos fallo (${dedupKey}): ${e.message}`);
    return { intentos: [], total: 0, ya_timbrado: false, _error: e.message };
  }
}

async function reportarIntento(payload) {
  if (!isEnabled()) {
    return { ok: false, _disabled: true };
  }
  try {
    const r = await axios.post(`${REINO_A_URL}/api/reino-b/intentos`, payload, {
      headers: headers(),
      timeout: TIMEOUT_MS
    });
    return r.data;
  } catch (e) {
    console.warn(`[REINO B] reinoAClient.reportarIntento fallo: ${e.message}`);
    return { ok: false, _error: e.message };
  }
}

module.exports = { isEnabled, consultarIntentos, reportarIntento };
