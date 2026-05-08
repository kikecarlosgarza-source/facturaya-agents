// Detector de fallos en logs de Reino A.
// Pre-pass: indexa todos los `[TICKET] datos extraidos: {JSON}` del batch.
// Para cada `Portal seleccionado: X` (o `portal no soportado`), busca el
// ticketData más cercano (dentro de ±30 líneas) y enriquece el payload
// pasado al orchestrator con establecimiento, folio, fecha, total, rfc_emisor,
// numero_tienda, portal_facturacion.

const orchestrator = require('./orchestrator');

const PATRONES_FALLO = [
  /Portal seleccionado:\s*([A-Za-z0-9_-]+)/i,
  /portal no soportado[^A-Za-z]+([A-Za-z0-9_-]+)/i
];
const PATRON_TICKET_DATA = /\[TICKET\][^\{]*datos extraidos:\s*(\{[\s\S]*?\})\s*$/;
const VENTANA_MAX = 30; // líneas máx entre ticketData y fallo para considerarlo "cercano"

const procesados = new Set();

function isDryRun() {
  const v = String(process.env.DRY_RUN ?? 'true').toLowerCase();
  return v !== 'false';
}

function extraerMensaje(entry) {
  if (typeof entry === 'string') return entry;
  return entry.message || entry.log || entry.text || JSON.stringify(entry);
}

function tryParseTicketData(message) {
  const m = message.match(PATRON_TICKET_DATA);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (err) {
    console.warn(`[REINO B] No pude parsear ticketData JSON: ${err.message}`);
    return null;
  }
}

function detectarFallo(message) {
  for (const patron of PATRONES_FALLO) {
    const match = message.match(patron);
    if (match) return match[1] || 'desconocido';
  }
  return null;
}

function buscarTicketDataCercano(ticketDataIndex, position) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const td of ticketDataIndex) {
    const dist = Math.abs(td.position - position);
    if (dist < nearestDist && dist <= VENTANA_MAX) {
      nearestDist = dist;
      nearest = td.data;
    }
  }
  return nearest;
}

function normalizarPortalKey(establecimiento, fallback) {
  const src = establecimiento || fallback || 'unknown';
  return String(src).toLowerCase().trim().replace(/\s+/g, '');
}

function dedupKey(portal, ticketData, fallback) {
  const folio = ticketData?.folio || ticketData?.numero_ticket || fallback || 'unknown';
  return `${portal}::${folio}`;
}

function scanLogs(logs) {
  const entries = Array.isArray(logs) ? logs : (logs?.logs || logs?.data || []);
  if (!Array.isArray(entries)) return;

  // Pre-pass: indexar ticketData y fallos con su posición en el batch.
  const ticketDataIndex = [];
  const fallos = [];

  entries.forEach((entry, i) => {
    const message = extraerMensaje(entry);

    const td = tryParseTicketData(message);
    if (td) ticketDataIndex.push({ position: i, data: td });

    const rawPortal = detectarFallo(message);
    if (rawPortal) fallos.push({ position: i, rawPortal });
  });

  if (fallos.length === 0) return;

  for (const fallo of fallos) {
    const ticketData = buscarTicketDataCercano(ticketDataIndex, fallo.position);
    const portal = normalizarPortalKey(ticketData?.establecimiento, fallo.rawPortal);
    const key = dedupKey(portal, ticketData, fallo.rawPortal);

    if (procesados.has(key)) continue;
    procesados.add(key);

    const enriched = ticketData ? 'enriquecido' : 'minimal';
    console.log(`[REINO B] Fallo detectado: portal=${portal} ticketData=${enriched} key=${key}`);

    if (isDryRun()) {
      console.log(`[REINO B] DRY_RUN=true — no se ejecutan agentes (Scout/Generator/Pusher)`);
      continue;
    }

    // Fire-and-forget — no bloquear el scan del resto.
    orchestrator.procesarFallo({
      portal,
      ticketData: ticketData || null,
      rawLogPortal: fallo.rawPortal
    }).catch(err => {
      console.error(`[REINO B] Orchestrator error: ${err.message}`);
    });
  }
}

module.exports = { scanLogs };
