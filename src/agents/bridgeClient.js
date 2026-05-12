// Cliente HTTP del bridge Mac (ngrok tunnel) — modelo async con polling
// Reemplaza el scout DOM-based local cuando BRIDGE_URL está configurado.

const axios = require('axios');

const BRIDGE_URL = process.env.BRIDGE_URL || '';
const BRIDGE_POLL_INTERVAL_MS = parseInt(process.env.BRIDGE_POLL_INTERVAL_MS || '15000', 10);
const BRIDGE_MAX_POLLS = parseInt(process.env.BRIDGE_MAX_POLLS || '80', 10); // 80 * 15s = 20min total
const BRIDGE_HTTP_TIMEOUT_MS = parseInt(process.env.BRIDGE_HTTP_TIMEOUT_MS || '30000', 10);

const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'ngrok-skip-browser-warning': 'true'
};

function isBridgeEnabled() {
  return BRIDGE_URL && /^https?:\/\//.test(BRIDGE_URL);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function explorarYFacturar({ portal, urlPortal, ticketData, perfil }) {
  if (!isBridgeEnabled()) {
    throw new Error('BRIDGE_URL no configurada — bridgeClient deshabilitado');
  }

  const payload = {
    portal_url: urlPortal,
    ticket_data: {
      folio: ticketData?.folio || '',
      numero_ticket: ticketData?.numero_ticket || ticketData?.folio || '',
      fecha: ticketData?.fecha || ticketData?.fecha_compra || '',
      total: ticketData?.total || '',
      establecimiento: ticketData?.establecimiento || portal,
      numero_tienda: ticketData?.numero_tienda || '',
      rfc_emisor: ticketData?.rfc_emisor || ''
    },
    perfil_fiscal: {
      rfc: perfil?.rfc || '',
      nombre: perfil?.nombre || '',
      cp: perfil?.cp || '',
      email: perfil?.email || '',
      regimen: perfil?.regimen || '612',
      uso_cfdi: perfil?.uso_cfdi || 'G03'
    },
    mode: 'timbrar'
  };

  const startedAt = Date.now();
  let requestId = null;

  try {
    // 1. POST async — responde inmediato con requestId
    console.log(`[BRIDGE_CLIENT] POST ${BRIDGE_URL}/scout portal=${portal}`);
    const postResp = await axios.post(`${BRIDGE_URL}/scout`, payload, {
      timeout: BRIDGE_HTTP_TIMEOUT_MS,
      headers: COMMON_HEADERS,
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024
    });
    requestId = postResp.data?.requestId;
    if (!requestId) throw new Error('bridge no devolvió requestId');
    console.log(`[BRIDGE_CLIENT] ${requestId} encolado (status=${postResp.data.status})`);

    // 2. Loop de polling
    for (let i = 1; i <= BRIDGE_MAX_POLLS; i++) {
      await sleep(BRIDGE_POLL_INTERVAL_MS);
      const statusResp = await axios.get(`${BRIDGE_URL}/status/${requestId}`, {
        timeout: BRIDGE_HTTP_TIMEOUT_MS,
        headers: COMMON_HEADERS
      });
      const st = statusResp.data?.status;
      console.log(`[BRIDGE_CLIENT] ${requestId} poll ${i}/${BRIDGE_MAX_POLLS} status=${st}`);

      if (st === 'done' || st === 'error') {
        // 3. Obtener resultado
        const resultResp = await axios.get(`${BRIDGE_URL}/result/${requestId}`, {
          timeout: BRIDGE_HTTP_TIMEOUT_MS,
          headers: COMMON_HEADERS,
          maxContentLength: 50 * 1024 * 1024
        });
        return formatResult(resultResp.data, startedAt, requestId);
      }
      // queued | running → siguiente poll
    }

    // 4. Timeout de polling total
    const durationMs = Date.now() - startedAt;
    console.error(`[BRIDGE_CLIENT] ${requestId} polling timeout tras ${BRIDGE_MAX_POLLS} intentos (${(durationMs/1000).toFixed(0)}s)`);
    return errorResult(`bridge polling timeout tras ${BRIDGE_MAX_POLLS} intentos`, durationMs, requestId);

  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error(`[BRIDGE_CLIENT] error ${requestId || '(sin id)'} en ${(durationMs/1000).toFixed(1)}s: ${err.message}`);
    return errorResult(`bridge error: ${err.message}`, durationMs, requestId);
  }
}

function formatResult(data, startedAt, requestId) {
  const durationMs = Date.now() - startedAt;
  const parsed = data?.parsed || {};
  // Detectar captcha estructurado del bridge (prompt v2026-05-12) o fallback string-match.
  // Cuando captchaDetected=true, el orchestrator hace fallback a scoutVisual (que tiene CapSolver).
  const errStr = String(parsed.error || '');
  const isCaptcha = parsed.error === 'captcha_detected' || /captcha/i.test(errStr);
  return {
    exito: !!parsed.exito,
    uuid: parsed.uuid || null,
    error: parsed.error || (data?.success ? null : 'bridge falló'),
    captchaDetected: isCaptcha,
    tipoCaptcha: parsed.tipo_captcha || null,
    accionesGrabadas: parsed.acciones_grabadas || [],
    screenshots: [],
    costo: {
      capUsd: null,
      costUsd: null,
      durationMs,
      source: 'bridge'
    },
    bridgeResponse: {
      requestId: data?.requestId || requestId,
      durationMs: data?.durationMs,
      log_path: data?.log_path
    }
  };
}

function errorResult(msg, durationMs, requestId) {
  return {
    exito: false,
    uuid: null,
    error: msg,
    accionesGrabadas: [],
    screenshots: [],
    costo: { source: 'bridge', durationMs },
    bridgeResponse: requestId ? { requestId } : undefined
  };
}

module.exports = { explorarYFacturar, isBridgeEnabled };
