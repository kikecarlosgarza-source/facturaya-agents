// Orquestador del Reino B. Flow:
//   detector (DRY_RUN=false) → procesarFallo({portal, ticketData, rawLogPortal})
//   1. Resolver URL — preferir ticketData.portal_facturacion si existe; sino portalsLookup
//   2. dnsCheck (timeout corto, abortar si URL muerta)
//   3. scoutVisual (Computer Use API loop) — envuelto en try/catch para que un fallo
//      no controlado no mate al daemon completo
//   4. Si Scout factura OK:
//        a. generator (segundo pase a Claude text-mode → handler.js reproducible)
//        b. pusher (modo PR contra Reino A, NUNCA push directo a main)
//   5. Si Scout falla → log + costo + screenshots para debug humano

const portalsLookup = require('./lib/portalsLookup');
const dnsCheck = require('./lib/dnsCheck');
const scoutVisual = require('./agents/scoutVisual');
const bridgeClient = require('./agents/bridgeClient');
const generator = require('./agents/generator');
const pusher = require('./agents/pusher');

// TODO CRITICAL: enriquecer perfil real del usuario que disparó el ticket.
// Hoy todos los tickets se intentan facturar a este perfil personal — funciona
// para tickets propios, falla para tickets de otros usuarios. Implementación
// futura sugerida: leer `[USUARIO] perfil:` log de Reino A o fetch a un
// endpoint /api/perfil/:userId.
const PERFIL_DEFAULT = {
  rfc: 'GAME860412CY6',
  nombre: 'ENRIQUE CARLOS GARZA MONTEMAYOR',
  cp: '66230',
  regimen: '612',
  uso_cfdi: 'G03',
  email: 'kikecarlosgarza@gmail.com'
};

async function resolverUrl({ portal, ticketData }) {
  // 1. Si el ticket trae portal_facturacion válido, usarlo.
  if (ticketData?.portal_facturacion && /^https?:\/\//.test(ticketData.portal_facturacion)) {
    console.log(`[REINO B] URL del ticket: ${ticketData.portal_facturacion}`);
    return ticketData.portal_facturacion;
  }
  // 2. portalsLookup (override portals.json + cache + web_search)
  const url = await portalsLookup.lookupPortalUrl({
    portal,
    establecimiento: ticketData?.establecimiento
  });
  if (url) console.log(`[REINO B] URL via portalsLookup: ${url}`);
  return url;
}

async function procesarFallo({ portal, ticketData, rawLogPortal }) {
  const ticketId = ticketData?.folio || ticketData?.numero_ticket || 'unknown';
  console.log(`[REINO B] Procesando fallo: portal=${portal} ticket=${ticketId} rawLog=${rawLogPortal || 'n/a'}`);

  // 1. Resolver URL
  const urlPortal = await resolverUrl({ portal, ticketData });
  if (!urlPortal) {
    console.error(`[REINO B] No se pudo resolver URL para portal=${portal}`);
    return { exito: false, etapa: 'lookup', error: 'URL no encontrada' };
  }

  // 2. DNS pre-check con fallback a portalsLookup
  let dnsOk = await dnsCheck.dnsResolves(urlPortal);
  let urlFinal = urlPortal;

  if (!dnsOk.ok) {
    console.warn(`[REINO B] DNS no resuelve para ${urlPortal}: ${dnsOk.error} — intentando fallback portalsLookup`);
    const urlFallback = await portalsLookup.lookupPortalUrl({
      portal,
      establecimiento: ticketData?.establecimiento
    });
    if (urlFallback && urlFallback !== urlPortal) {
      console.log(`[REINO B] Fallback URL: ${urlFallback}`);
      const dnsFallback = await dnsCheck.dnsResolves(urlFallback);
      if (dnsFallback.ok) {
        urlFinal = urlFallback;
        dnsOk = dnsFallback;
        console.log(`[REINO B] Fallback DNS OK: ${dnsFallback.host}`);
      } else {
        console.error(`[REINO B] Fallback también falla DNS: ${dnsFallback.error}`);
        return { exito: false, etapa: 'dns', error: `Ambos URLs fallan DNS — ticket: ${dnsOk.error}, fallback: ${dnsFallback.error}`, url: urlPortal, urlFallback };
      }
    } else {
      return { exito: false, etapa: 'dns', error: dnsOk.error, url: urlPortal };
    }
  } else {
    console.log(`[REINO B] DNS OK: ${dnsOk.host}`);
  }

  // 3. Construir ticketData pasable a scoutVisual (asegurar campos mínimos)
  const ticketDataParaScout = {
    numero_ticket: ticketData?.numero_ticket || ticketId,
    folio: ticketData?.folio || ticketId,
    total: ticketData?.total ?? '',
    fecha_compra: ticketData?.fecha_compra || ticketData?.fecha || '',
    fecha: ticketData?.fecha || '',
    establecimiento: ticketData?.establecimiento || portal,
    rfc_emisor: ticketData?.rfc_emisor || '',
    numero_tienda: ticketData?.numero_tienda || '',
    web_id: ticketData?.web_id || '',
    portal_url: urlPortal
  };

  // 4. Scout Visual — try/catch defensivo (BUG 1): si scoutVisual lanza
  // una excepción no controlada (e.g. browser crash, OOM, etc.) NO debe
  // matar al daemon completo. Atrapamos y devolvemos resultado estructurado.
  const engine = bridgeClient.isBridgeEnabled() ? bridgeClient : scoutVisual;
  const engineName = bridgeClient.isBridgeEnabled() ? 'bridge' : 'scoutVisual';
  console.log(`[REINO B] motor seleccionado: ${engineName}`);

  let resultado;
  try {
    resultado = await engine.explorarYFacturar({
      portal,
      urlPortal: urlFinal,
      ticketData: ticketDataParaScout,
      perfil: PERFIL_DEFAULT
    });
  } catch (err) {
    console.error(`[REINO B] motor ${engineName} lanzó excepción no controlada: ${err.message}`);
    console.error(err.stack);
    return {
      exito: false,
      etapa: 'scout-throw',
      error: err.message,
      stack: err.stack?.substring(0, 500)
    };
  }

  const costoSrc = resultado.costo?.source || 'local';
  if (costoSrc === 'bridge') {
    console.log(`[REINO B] Scout via bridge: duración ${((resultado.costo.durationMs||0)/1000).toFixed(1)}s requestId=${resultado.bridgeResponse?.requestId || 'n/a'}`);
  } else {
    console.log(`[REINO B] Scout Visual costo: $${resultado.costo.costUsd} (${resultado.costo.calls} calls, ${resultado.costo.inputTokens}+${resultado.costo.outputTokens} tokens)`);
  }

  if (!resultado.exito) {
    console.error(`[REINO B] Scout Visual falló: ${resultado.error}`);
    return {
      exito: false,
      etapa: 'scout',
      error: resultado.error,
      costo: resultado.costo,
      screenshots: resultado.screenshots.length
    };
  }

  console.log(`[REINO B] ✅ Scout Visual OK: UUID=${resultado.uuid} (${resultado.accionesGrabadas.length} acciones grabadas)`);

  // 5a. Generator
  let handler;
  try {
    handler = await generator.generarHandlerDesdeAcciones({
      portal,
      accionesGrabadas: resultado.accionesGrabadas,
      ticketData: ticketDataParaScout
    });
  } catch (err) {
    console.error(`[REINO B] Generator lanzó excepción: ${err.message}`);
    return { exito: true, etapa: 'generator-throw', uuid: resultado.uuid, error: err.message, costo: resultado.costo };
  }

  if (handler.error) {
    console.error(`[REINO B] Generator falló: ${handler.error}${handler.detalle ? ' — ' + handler.detalle : ''}`);
    return {
      exito: true,
      etapa: 'generator-fail',
      uuid: resultado.uuid,
      error: handler.error,
      costo: resultado.costo
    };
  }

  console.log(`[REINO B] Handler generado: ${handler.filename} (${handler.contenido.length} chars)`);

  // 5b. Pusher: PR contra Reino A
  let pushResult;
  try {
    pushResult = await pusher.commitHandler({
      handler,
      portalNombre: portal,
      repoTarget: 'production',
      uuid: resultado.uuid,
      screenshots: resultado.screenshots
    });
  } catch (err) {
    console.error(`[REINO B] Pusher PR falló: ${err.message}`);
    return {
      exito: true,
      etapa: 'pusher-fail',
      uuid: resultado.uuid,
      error: err.message,
      costo: resultado.costo
    };
  }

  console.log(`[REINO B] ✅ PR creado: ${pushResult.prUrl} (#${pushResult.prNumber}) branch=${pushResult.branch}`);

  return {
    exito: true,
    etapa: 'complete',
    uuid: resultado.uuid,
    prUrl: pushResult.prUrl,
    prNumber: pushResult.prNumber,
    branch: pushResult.branch,
    costo: resultado.costo
  };
}

module.exports = { procesarFallo };
