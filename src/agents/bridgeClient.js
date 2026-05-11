// Cliente HTTP del bridge Mac (ngrok tunnel)
// Reemplaza el scout DOM-based local cuando BRIDGE_URL está configurado.

const axios = require('axios');

const BRIDGE_URL = process.env.BRIDGE_URL || '';
const BRIDGE_TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS || '720000', 10);
// Default 12min — el scout real tarda ~1-3min, timbrar puede tomar más

function isBridgeEnabled() {
  return BRIDGE_URL && /^https?:\/\//.test(BRIDGE_URL);
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

  console.log(`[BRIDGE_CLIENT] POST ${BRIDGE_URL}/scout portal=${portal} timeout=${BRIDGE_TIMEOUT_MS}ms`);
  const startedAt = Date.now();

  try {
    const resp = await axios.post(`${BRIDGE_URL}/scout`, payload, {
      timeout: BRIDGE_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024
    });

    const durationMs = Date.now() - startedAt;
    console.log(`[BRIDGE_CLIENT] respondió en ${(durationMs/1000).toFixed(1)}s success=${resp.data?.success}`);

    const parsed = resp.data?.parsed || {};

    return {
      exito: !!parsed.exito,
      uuid: parsed.uuid || null,
      error: parsed.error || (resp.data?.success ? null : 'bridge falló'),
      accionesGrabadas: parsed.acciones_grabadas || [],
      screenshots: [],
      costo: {
        capUsd: null,
        costUsd: null,
        durationMs,
        source: 'bridge'
      },
      bridgeResponse: {
        requestId: resp.data?.requestId,
        durationMs: resp.data?.durationMs,
        log_path: resp.data?.log_path
      }
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error(`[BRIDGE_CLIENT] error en ${(durationMs/1000).toFixed(1)}s: ${err.message}`);
    return {
      exito: false,
      uuid: null,
      error: `bridge error: ${err.message}`,
      accionesGrabadas: [],
      screenshots: [],
      costo: { source: 'bridge', durationMs }
    };
  }
}

module.exports = { explorarYFacturar, isBridgeEnabled };
