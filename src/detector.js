const orchestrator = require('./orchestrator');

const PATRONES_FALLO = [
  /Portal seleccionado:\s*([A-Za-z0-9_-]+)/i,
  /portal no soportado[^A-Za-z]+([A-Za-z0-9_-]+)/i
];

const procesados = new Set();

function isDryRun() {
  const v = String(process.env.DRY_RUN ?? 'true').toLowerCase();
  return v !== 'false';
}

function extraerTicket(message) {
  const match = message.match(/(?:noTicket|ticket|folio)[=:\s]+([A-Za-z0-9-]+)/i);
  return match ? match[1] : 'desconocido';
}

function scanLogs(logs) {
  const entries = Array.isArray(logs) ? logs : (logs?.logs || logs?.data || []);
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    const message = typeof entry === 'string'
      ? entry
      : (entry.message || entry.log || entry.text || JSON.stringify(entry));

    for (const patron of PATRONES_FALLO) {
      const match = message.match(patron);
      if (!match) continue;

      const portal = match[1] || 'desconocido';
      const ticket = extraerTicket(message);
      const key = `${portal}::${ticket}`;
      if (procesados.has(key)) break;
      procesados.add(key);

      console.log(`[REINO B] Fallo detectado: portal=${portal}, ticket=${ticket}`);

      if (isDryRun()) {
        console.log(`[REINO B] DRY_RUN=true — no se ejecutan agentes (Scout/Generator/Pusher)`);
      } else {
        // Fire-and-forget: no bloquear el scan del resto de logs.
        orchestrator.procesarFallo({ portal, ticket }).catch(err => {
          console.error(`[REINO B] Orchestrator error: ${err.message}`);
        });
      }
      break;
    }
  }
}

module.exports = { scanLogs };
