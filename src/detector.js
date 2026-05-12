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
const reinoAClient = require('./lib/reinoAClient');

// Maximo de intentos por dedup_key. Si Reino A reporta >= este numero de intentos
// previos sin exito_timbrado, el ticket queda para flujo manual del usuario.
// Configurable via env, default 2.
const MAX_INTENTOS_REINO_B = parseInt(process.env.MAX_INTENTOS_REINO_B || '2', 10);

const PATRONES_FALLO = [
  // Patrones LEGACY eliminados (incidente HD 2026-05-11):
  // /Portal seleccionado:/ y /portal no soportado/ matchaban TODOS los
  // tickets con handler bespoke → doble facturación. Si en el futuro
  // necesitamos detectar fallos recuperables de handlers bespoke,
  // Reino A debe emitir un log nuevo y explícito.
  /\[AUTO\]\s+Sin handler bespoke para\s+"([^"]+)"/i,
  /\[AUTO\]\s+PRIMER alert para portal\s+"([^"]+)"/i
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

async function scanLogs(logs) {
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

    // 1. Dedup in-memory del mismo cycle (evita procesar el mismo key 2 veces seguidas)
    if (procesados.has(key)) continue;
    procesados.add(key);

    const enriched = ticketData ? 'enriquecido' : 'minimal';
    console.log(`[REINO B] Fallo detectado: portal=${portal} ticketData=${enriched} key=${key}`);

    if (isDryRun()) {
      console.log(`[REINO B] DRY_RUN=true - no se ejecutan agentes (Scout/Generator/Pusher)`);
      continue;
    }

    // 2. Dedup persistente: consultar historial en Reino A (sobrevive a reinicios)
    const historico = await reinoAClient.consultarIntentos(key);
    if (historico.ya_timbrado) {
      console.log(`[REINO B] ${key} ya timbrado en intento previo, skip`);
      continue;
    }
    if (historico.total >= MAX_INTENTOS_REINO_B) {
      console.log(`[REINO B] ${key} alcanzó MAX_INTENTOS_REINO_B (${MAX_INTENTOS_REINO_B}), skip — flujo manual`);
      continue;
    }
    if (historico.total > 0) {
      console.log(`[REINO B] ${key} intento ${historico.total + 1}/${MAX_INTENTOS_REINO_B} (${historico.total} previos fallidos)`);
    }

    // 3. Procesar (fire-and-forget) + reportar resultado al endpoint cuando termine
    const startedAt = Date.now();
    orchestrator.procesarFallo({
      portal,
      ticketData: ticketData || null,
      rawLogPortal: fallo.rawPortal
    }).then(async (resultado) => {
      const exitoTimbrado = !!(resultado.exito && resultado.uuid);
      try {
        await reinoAClient.reportarIntento({
          solicitudId: key,
          dedupKey: key,
          etapa: resultado.etapa || 'unknown',
          exito: exitoTimbrado,
          uuidCfdi: resultado.uuid,
          errorMensaje: resultado.error,
          costoUsd: resultado.costo?.costUsd,
          motor: resultado.costo?.source,
          prUrl: resultado.prUrl,
          duracionMs: Date.now() - startedAt
        });
      } catch (e) {
        console.warn(`[REINO B] reportarIntento fallo (${key}): ${e.message}`);
      }
    }).catch(async (err) => {
      console.error(`[REINO B] Orchestrator throw (${key}): ${err.message}`);
      try {
        await reinoAClient.reportarIntento({
          solicitudId: key,
          dedupKey: key,
          etapa: 'orchestrator-throw',
          exito: false,
          errorMensaje: err.message,
          duracionMs: Date.now() - startedAt
        });
      } catch (e) {
        console.warn(`[REINO B] reportarIntento del throw también fallo (${key}): ${e.message}`);
      }
    });
  }
}

module.exports = { scanLogs };
