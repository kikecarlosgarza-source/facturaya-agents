const scout = require('./agents/scout');
const generator = require('./agents/generator');
const pusher = require('./agents/pusher');
const tester = require('./agents/tester');

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

  console.log('[REINO B] Esperando deploy de Reino C...');
  const deployStatus = await tester.esperarDeployReinoC({ commitHashEsperado: pushResult.commitHash });
  if (!deployStatus.ready) {
    console.error(`[REINO B] Reino C no respondió a tiempo: ${deployStatus.error}`);
    return { exito: false, etapa: 'esperar-deploy', error: deployStatus.error };
  }

  // Ticket de prueba (usar el ticket original que disparó el fallo)
  const ticketPrueba = ticket || { noTicket: 'TEST-AUTO', otrosCampos: 'TBD' };
  const testResult = await tester.probarHandler({
    portal,
    ticketData: ticketPrueba,
    perfil: null
  });

  if (testResult.pasoLaPrueba) {
    console.log(`[REINO B] ✅ Handler ${portal} pasó prueba en Reino C - LISTO PARA PROMOVER A REINO A`);
    console.log(`[REINO B] UUID timbrado: ${testResult.body.uuid}`);
    return {
      exito: true,
      etapa: 'reino-c-validado',
      testResult,
      commitHash: pushResult.commitHash,
      filename: handler.filename
    };
  } else {
    console.log(`[REINO B] ❌ Handler ${portal} FALLÓ en Reino C: ${JSON.stringify(testResult.body || testResult.error)}`);
    return {
      exito: false,
      etapa: 'reino-c-fallo',
      testResult,
      commitHash: pushResult.commitHash
    };
  }
}

module.exports = { procesarFallo };
