const PATRONES_FALLO = [
  /Portal seleccionado:\s*([A-Za-z0-9_-]+)/i,
  /portal no soportado[^A-Za-z]+([A-Za-z0-9_-]+)/i
];

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
      if (match) {
        const portal = match[1] || 'desconocido';
        const ticket = extraerTicket(message);
        console.log(`[REINO B] Fallo detectado: portal=${portal}, ticket=${ticket}`);
        break;
      }
    }
  }
}

module.exports = { scanLogs };
