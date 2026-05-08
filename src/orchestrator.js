const scout = require('./agents/scout');
const generator = require('./agents/generator');
const pusher = require('./agents/pusher');

async function procesarFallo({ portal, ticket }) {
  console.log(`[REINO B] Procesando fallo: portal=${portal} ticket=${ticket}`);

  const urlPista = `https://www.${portal}.com/facturacion`;
  const scoutOut = await scout.explorarPortal({ portal, urlPista });
  if (scoutOut.error) {
    console.error(`[REINO B] Scout falló: ${scoutOut.error}`);
    return { exito: false, etapa: 'scout', error: scoutOut.error };
  }
  console.log(`[REINO B] Scout OK: framework=${scoutOut.framework} inputs=${scoutOut.inputs.length} buttons=${scoutOut.buttons.length} hasCaptcha=${scoutOut.hasCaptcha}`);

  const handler = await generator.generarHandler({ scoutOutput: scoutOut, portalNombre: portal });
  if (handler.error) {
    console.error(`[REINO B] Generator falló: ${handler.error}${handler.detalle ? ' — ' + handler.detalle : ''}`);
    return { exito: false, etapa: 'generator', error: handler.error };
  }
  console.log(`[REINO B] Generator OK: ${handler.filename} (${handler.contenido.length} chars)`);

  let pushResult;
  try {
    pushResult = await pusher.commitHandler({ handler, portalNombre: portal, repoTarget: 'sandbox' });
  } catch (err) {
    console.error(`[REINO B] Pusher falló: ${err.message}`);
    return { exito: false, etapa: 'pusher', error: err.message };
  }
  console.log(`[REINO B] Handler pushed: commit=${pushResult.commitHash || '(sin cambios)'} files=${(pushResult.filesPushed || []).join(',') || '-'}`);

  return {
    exito: true,
    commitHash: pushResult.commitHash,
    filename: handler.filename,
    filesPushed: pushResult.filesPushed
  };
}

module.exports = { procesarFallo };
