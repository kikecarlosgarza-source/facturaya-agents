// Generator — convierte accionesGrabadas (de scoutVisual) en handler permanente
// reproducible. Segundo pase a Claude (texto, sin Computer Use): le damos los pasos
// con selectores capturados y le pedimos que escriba código Playwright que use los
// selectores cuando estén, fallback a coords cuando no.

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const claudeApi = require('../lib/claudeApi');

const execFileAsync = promisify(execFile);

// Refs bundleados en src/refs/. Son copias snapshot de los handlers de Reino A
// (services/handlers/*.js) — sirven como input al prompt de Claude para que el
// handler nuevo siga el mismo estilo. NO son ejecutables en Reino B.
// Resync manual cuando un handler de Reino A evolucione (Reino A está LOCKED).
const REFS_DIR = path.join(__dirname, '..', 'refs');

async function leerReferencias() {
  const refSeven = await fs.readFile(path.join(REFS_DIR, 'sevenelevenHandler.ref.js'), 'utf8');
  const refBenavides = await fs.readFile(path.join(REFS_DIR, 'benavidesHandler.ref.js'), 'utf8');
  const refOxxoGas = await fs.readFile(path.join(REFS_DIR, 'oxxoGasHandler.ref.js'), 'utf8');
  return { refSeven, refBenavides, refOxxoGas };
}

function buildSystemPrompt(refSeven, refBenavides, refOxxoGas) {
  return [
    'Eres un agente generador de handlers JS para facturación automatizada en portales SAT-México.',
    '',
    'CONTRATO DEL HANDLER:',
    '  module.exports = { ejecutar };',
    '  async function ejecutar(perfil, ticketData) {',
    '    // perfil: { rfc, nombre, email, cp, regimen, uso_cfdi, ... }',
    '    // ticketData: { numero_ticket, folio, total, fecha_compra, ... }',
    '    // retorna: { exito: bool, uuid?: string, mensaje?: string, error?: string }',
    '  }',
    '',
    'INPUT QUE RECIBIRÁS:',
    '- portal: nombre del portal',
    '- ticketData shape esperado',
    '- accionesGrabadas: array de pasos que un agente Computer Use ejecutó EXITOSAMENTE para timbrar una factura. Cada paso tiene { type (left_click | type | key | scroll), coord (cuando aplica), selector (capturado vía elementFromPoint, puede ser null), tag, text (con placeholders {{rfc}}/{{folio}}/etc.), wait }',
    '',
    'REGLAS PARA GENERAR EL HANDLER:',
    '- Usar Playwright stealth: require("playwright-extra") con puppeteer-extra-plugin-stealth, fallback a require("playwright") base si no está disponible.',
    '- Para CADA paso del recording, prefiere usar el selector capturado: page.click(selector) en lugar de page.mouse.click(coord). Solo usa coords si el selector es null.',
    '- Para "type", usa page.fill(selector, valor) si hay selector + tag input/textarea, o page.keyboard.type si no. Reemplaza placeholders del recording: {{rfc}} → perfil.rfc, {{folio}} → ticketData.folio, etc.',
    '- Para "key", usa page.keyboard.press(key) (e.g. "Enter").',
    '- Logs con prefijo "[AUTO] <portal> - paso N: <acción>" para que el detector del Reino B parsee.',
    '- Cierra el browser en bloque finally.',
    '- Retorna { exito: false, error: msg } en cualquier branch de fallo.',
    '- Output: ÚNICO bloque ```javascript ... ``` con código completo, sin texto antes ni después.',
    '',
    'HANDLER DE REFERENCIA 1 (7-Eleven, Pattern C — DataDome + Konesh):',
    '```javascript',
    refSeven,
    '```',
    '',
    'HANDLER DE REFERENCIA 2 (Benavides, Pattern A — HTTP-only + cookie jar):',
    '```javascript',
    refBenavides,
    '```',
    '',
    'HANDLER DE REFERENCIA 3 (OXXO Gas, Pattern A — HTTP-only + reCAPTCHA v2 CapSolver + verificación post-emisión anti-false-success):',
    '```javascript',
    refOxxoGas,
    '```'
  ].join('\n');
}

function buildUserMessage({ portal, accionesGrabadas, ticketData }) {
  return [
    `Genera un handler reproducible para el portal "${portal}".`,
    '',
    'ticketData shape esperado:',
    '```json',
    JSON.stringify(ticketData, null, 2),
    '```',
    '',
    'accionesGrabadas (lo que Computer Use hizo y funcionó):',
    '```json',
    JSON.stringify(accionesGrabadas, null, 2),
    '```',
    '',
    `Devuelve ÚNICO bloque \`\`\`javascript con el contenido completo de ${portal}Handler.js. Conserva los selectores capturados para que el handler sea estable frente a cambios de layout.`
  ].join('\n');
}

function extraerCodigo(text) {
  const match = text.match(/```(?:javascript|js)\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

async function validarSintaxis(contenido) {
  const tmpPath = `/tmp/handler-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.js`;
  try {
    await fs.writeFile(tmpPath, contenido);
    await execFileAsync('node', ['--check', tmpPath]);
    return { ok: true };
  } catch (err) {
    return { ok: false, detalle: (err.stderr || err.message || '').toString() };
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

async function generarHandlerDesdeAcciones({ portal, accionesGrabadas, ticketData }) {
  if (!Array.isArray(accionesGrabadas) || accionesGrabadas.length === 0) {
    return { error: 'accionesGrabadas vacío o inválido' };
  }

  let referencias;
  try {
    referencias = await leerReferencias();
  } catch (err) {
    return { error: `No se pudieron leer handlers de referencia (${REFS_DIR}): ${err.message}` };
  }

  const system = buildSystemPrompt(referencias.refSeven, referencias.refBenavides, referencias.refOxxoGas);
  const userMsg = buildUserMessage({ portal, accionesGrabadas, ticketData });

  let response;
  try {
    response = await claudeApi.chat({
      system,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 8192
    });
  } catch (err) {
    return { error: `Claude API falló: ${err.message}` };
  }

  const contenido = extraerCodigo(response.text);
  if (!contenido) {
    return { error: 'No se encontró bloque ```javascript en respuesta de Claude' };
  }

  const sintaxis = await validarSintaxis(contenido);
  if (!sintaxis.ok) {
    return { error: 'sintaxis inválida', detalle: sintaxis.detalle };
  }

  return {
    filename: `${portal}Handler.js`,
    contenido
  };
}

module.exports = { generarHandlerDesdeAcciones };
