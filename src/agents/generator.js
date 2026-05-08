const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const claudeApi = require('../lib/claudeApi');

const execFileAsync = promisify(execFile);

// Path donde generator.js lee handlers de referencia. Override en producción
// con REINO_A_HANDLERS_PATH (por ejemplo, un clone /tmp del repo Reino A).
const HANDLERS_REF_DIR = process.env.REINO_A_HANDLERS_PATH ||
  '/Users/fival020/facturasat-backend/services/handlers';

async function leerReferencias() {
  const refSeven = await fs.readFile(path.join(HANDLERS_REF_DIR, 'sevenelevenHandler.js'), 'utf8');
  const refBenavides = await fs.readFile(path.join(HANDLERS_REF_DIR, 'benavidesHandler.js'), 'utf8');
  return { refSeven, refBenavides };
}

function buildSystemPrompt(refSeven, refBenavides) {
  return [
    'Eres un agente generador de handlers JS para facturación automatizada de tickets en portales SAT-México.',
    '',
    'CONTRATO ESTRICTO del handler que debes producir:',
    '  module.exports = { ejecutar };',
    '  async function ejecutar(perfil, ticketData) {',
    '    // perfil: { rfc, nombre_sat, email, regimen, uso_cfdi, cp, ... }',
    '    // ticketData: { numero_ticket, folio, monto, ... }',
    '    // retorna: { exito: bool, uuid?: string, error?: string }',
    '  }',
    '',
    'REGLAS:',
    '  - Usar Playwright stealth (require("playwright-extra") con plugin-stealth si está disponible, fallback a playwright base).',
    '  - Logs con prefijo "[AUTO] <portal> - ..." para que el detector del Reino B los parsee.',
    '  - Cerrar el browser en bloque finally.',
    '  - Solo usar selectores que existan en el scoutOutput. No inventar.',
    '  - Retornar { exito: false, error } en cualquier branch de fallo.',
    '  - Output debe ser un único bloque ```javascript ... ``` con código completo, sin texto extra antes ni después.',
    '',
    'HANDLER DE REFERENCIA 1 (7-Eleven, Pattern C — DataDome + Konesh + captcha):',
    '```javascript',
    refSeven,
    '```',
    '',
    'HANDLER DE REFERENCIA 2 (Benavides):',
    '```javascript',
    refBenavides,
    '```'
  ].join('\n');
}

function buildUserMessage(scoutOutput, portalNombre) {
  return [
    `Genera un handler para el portal "${portalNombre}".`,
    '',
    'Mapa estructural capturado por Scout:',
    '```json',
    JSON.stringify(scoutOutput, null, 2),
    '```',
    '',
    `Devuelve un único bloque \`\`\`javascript con el contenido completo de ${portalNombre}Handler.js.`
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

async function generarHandler({ scoutOutput, portalNombre }) {
  let referencias;
  try {
    referencias = await leerReferencias();
  } catch (err) {
    return { error: `No se pudieron leer handlers de referencia (${HANDLERS_REF_DIR}): ${err.message}` };
  }

  const system = buildSystemPrompt(referencias.refSeven, referencias.refBenavides);
  const userMsg = buildUserMessage(scoutOutput, portalNombre);

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
    return { error: 'No se encontró bloque ```javascript en la respuesta de Claude' };
  }

  const sintaxis = await validarSintaxis(contenido);
  if (!sintaxis.ok) {
    return { error: 'sintaxis inválida', detalle: sintaxis.detalle };
  }

  return {
    filename: `${portalNombre}Handler.js`,
    contenido
  };
}

module.exports = { generarHandler };
