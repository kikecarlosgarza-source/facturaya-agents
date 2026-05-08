// Orquestador del Reino B. Flow:
//   detector (DRY_RUN=false) → procesarFallo({portal, ticket})
//   1. portalsLookup (override portals.json + cache + web_search Claude)
//   2. dnsCheck (timeout corto, abortar si URL muerta)
//   3. scoutVisual (Computer Use API loop con captura de selectores)
//   4. Si Scout factura OK:
//        a. generator (segundo pase a Claude text-mode → handler.js reproducible)
//        b. pusher (modo PR contra Reino A, NUNCA push directo a main)
//   5. Si Scout falla → log + costo + screenshots para debug humano

const portalsLookup = require('./lib/portalsLookup');
const dnsCheck = require('./lib/dnsCheck');
const scoutVisual = require('./agents/scoutVisual');
const generator = require('./agents/generator');
const pusher = require('./agents/pusher');

// Perfil default para tickets que llegan sin perfil resuelto. Para producción,
// orchestrator deberá enriquecer con datos reales del usuario (TODO: data wiring).
const PERFIL_DEFAULT = {
  rfc: 'GAME860412CY6',
  nombre: 'ENRIQUE CARLOS GARZA MONTEMAYOR',
  cp: '66230',
  regimen: '612',
  uso_cfdi: 'G03',
  email: 'kikecarlosgarza@gmail.com'
};

async function procesarFallo({ portal, ticket }) {
  console.log(`[REINO B] Procesando fallo: portal=${portal} ticket=${ticket}`);

  // 1. Resolver URL del portal
  const urlPortal = await portalsLookup.lookupPortalUrl({ portal });
  if (!urlPortal) {
    console.error(`[REINO B] No se pudo resolver URL para portal=${portal}`);
    return { exito: false, etapa: 'lookup', error: 'URL no encontrada' };
  }
  console.log(`[REINO B] URL resuelta: ${urlPortal}`);

  // 2. DNS pre-check (evita gasto inútil si la URL no resuelve)
  const dnsOk = await dnsCheck.dnsResolves(urlPortal);
  if (!dnsOk.ok) {
    console.error(`[REINO B] DNS no resuelve para ${urlPortal}: ${dnsOk.error}`);
    return { exito: false, etapa: 'dns', error: dnsOk.error, url: urlPortal };
  }
  console.log(`[REINO B] DNS OK: ${dnsOk.host}`);

  // 3. ticketData minimal (solo conocemos el ticket id desde el log de Reino A)
  const ticketData = {
    numero_ticket: ticket,
    folio: ticket,
    total: '',
    fecha_compra: '',
    establecimiento: portal
  };

  // 4. Scout Visual
  const resultado = await scoutVisual.explorarYFacturar({
    portal,
    urlPortal,
    ticketData,
    perfil: PERFIL_DEFAULT
  });

  console.log(`[REINO B] Scout Visual costo: $${resultado.costo.costUsd} (${resultado.costo.calls} calls, ${resultado.costo.inputTokens}+${resultado.costo.outputTokens} tokens)`);

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

  // 5a. Generator: convertir acciones a handler permanente
  const handler = await generator.generarHandlerDesdeAcciones({
    portal,
    accionesGrabadas: resultado.accionesGrabadas,
    ticketData
  });

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
