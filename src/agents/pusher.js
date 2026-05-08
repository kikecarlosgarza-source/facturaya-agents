// TODO: Pusher — commit + push del handler al Reino A (facturasat-backend).
// Plan:
//   - Mantener checkout local de facturasat-backend (clone fresco con GITHUB_PAT).
//   - git pull antes de cada push (evitar diverge).
//   - Escribir handler nuevo en services/handlers/<portal>Handler.js.
//   - Registrar portal en portals/portals.json si aplica.
//   - git add + commit con mensaje descriptivo + push origin main.
//   - Render del Reino A redeployará automático al detectar push.

async function commitHandler() {
  throw new Error('pusher.commitHandler — TODO');
}

module.exports = { commitHandler };
