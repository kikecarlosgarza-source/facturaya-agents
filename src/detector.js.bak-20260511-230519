// Detector de fallos en logs de Reino A.
// Detecta el patron "fallida_temporal" emitido por Reino A cuando un portal
// no tiene handler bespoke. Asocia cada fallo con el ticketData mas cercano
// (dentro de +-30 lineas) y dispara el orchestrator.
//
// Patrones soportados (Reino A commit 7c9b8fd, mayo 2026):
//   [AUTO] Sin handler bespoke para "X" -> fallida_temporal
//   [AUTO] PRIMER alert para portal "X"
//   [AUTO] Portal "X" ya alertado anteriormente - silencio (NO dispara)
//
// Patrones legacy mantenidos por compat:
//   Portal seleccionado: X
//   portal no soportado: X

const orchestrator = require('./orchestrator');

const PATRONES_FALLO = [
  // Reino A actual (post commit 7c9b8fd)
  /\[AUTO\]\s+Sin handler bespoke para\s+"([^"]+)"/i,
  /\[AUTO\]\s+PRIMER alert para portal\s+"([^"]+)"/i,
  // Legacy
  /Portal seleccionado:\s*([A-Za-z0-9_-]+)/i,
  /portal no soportado[^A-Za-z]+([A-Za-z0-9_-]+)/i
];

// "ya alertado anteriormente" NO es fallo nuevo: dedup ya activo en Reino A.
const PATRON_YA_ALERTADO = /\[AUTO\]\s+Portal\s+"([^"]+)"\s+ya alertado anteriormente/i;

const PATRON_TICKET_DATA = /\[TICKET\][^\{]*datos extraidos:\s*(\{[\s\S]*?\})\s*$/;
const VENTANA_MAX = 30;

const procesados = new Set();

// Cursor en memoria: solo procesa logs con timestamp > este valor.
// Inicializa al arrancar con (ahora - 5min) para evitar reprocesar logs viejos
// post-reinicio. Se actualiza después de cada scanLogs.
let lastProcessedTimestamp = Date.now() - 5 * 60 * 1000;

function entryTimestampMs(entry) {
  if (typeof entry === 'string') return null;
  const ts = entry.timestamp || entry.time || entry.ts;
  if (!ts) return null;
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

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

  // Filtrar entries más viejos que el cursor (alta marca de agua).
  // Logs sin timestamp parseable se procesan igual (no podemos compararlos).
  let maxTimestampSeen = lastProcessedTimestamp;
  const entriesFiltradas = entries.filter(entry => {
    const ts = entryTimestampMs(entry);
    if (ts === null) return true; // sin timestamp -> procesar
    if (ts <= lastProcessedTimestamp) return false; // viejo -> skip
    if (ts > maxTimestampSeen) maxTimestampSeen = ts;
    return true;
  });

  const ticketDataIndex = [];
  const fallos = [];

  entriesFiltradas.forEach((entry, i) => {
    const message = extraerMensaje(entry);

    const td = tryParseTicketData(message);
    if (td) ticketDataIndex.push({ position: i, data: td });

    if (PATRON_YA_ALERTADO.test(message)) return;

    const rawPortal = detectarFallo(message);
    if (rawPortal) fallos.push({ position: i, rawPortal });
  });

  // Avanzar cursor solo si hubo logs nuevos (no regresivo)
  if (maxTimestampSeen > lastProcessedTimestamp) {
    lastProcessedTimestamp = maxTimestampSeen;
    console.log(`[REINO B] Cursor avanzado a ${new Date(lastProcessedTimestamp).toISOString()}`);
  }

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
      console.log(`[REINO B] DRY_RUN=true - no se ejecutan agentes (Scout/Generator/Pusher)`);
      continue;
    }

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
