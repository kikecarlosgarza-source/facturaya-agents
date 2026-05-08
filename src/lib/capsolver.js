// Wrapper de CapSolver para resolver Kaptchas tipo ImageToText.
// Adaptado de Reino A services/handlers/sevenelevenHandler.js (resolverKaptchaConCapSolver).
// Loop sobre módulos common+queueit porque algunos Kaptchas Konesh requieren queueit.

const axios = require('axios');

const CAPSOLVER_API = 'https://api.capsolver.com';
const MODULOS = ['common', 'queueit'];
const POLL_MAX = 20;
const POLL_INTERVAL_MS = 3000;

async function resolverKaptcha(captchaB64) {
  const capKey = process.env.CAPSOLVER_API_KEY;
  if (!capKey) throw new Error('CAPSOLVER_API_KEY no configurada');

  let createData;
  let createErr;

  for (const mod of MODULOS) {
    try {
      const create = await axios.post(`${CAPSOLVER_API}/createTask`, {
        clientKey: capKey,
        task: { type: 'ImageToTextTask', body: captchaB64, module: mod }
      }, { timeout: 15000, validateStatus: () => true });

      console.log(`[REINO B - capsolver] createTask(module=${mod}) status=${create.status}`);

      if (create.data.errorId) {
        createErr = create.data.errorDescription || create.data.errorCode || ('HTTP ' + create.status);
        continue;
      }
      if (create.data.status === 'ready' || create.data.solution?.text || create.data.taskId) {
        createData = { ...create.data, _module: mod };
        break;
      }
      createErr = 'createTask sin solution ni taskId';
    } catch (e) {
      createErr = e.message;
      console.log(`[REINO B - capsolver] createTask(module=${mod}) excepción: ${e.message}`);
    }
  }

  if (!createData) throw new Error('CapSolver createTask falló - ' + createErr);

  // Resolución sincrónica
  if (createData.status === 'ready' || createData.solution?.text) {
    const text = createData.solution?.text || '';
    if (!text) throw new Error('CapSolver status=ready sin texto');
    console.log(`[REINO B - capsolver] resuelto sincrónicamente (module=${createData._module}): "${text}"`);
    return text;
  }

  // Polling
  for (let i = 0; i < POLL_MAX; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const res = await axios.post(`${CAPSOLVER_API}/getTaskResult`, {
      clientKey: capKey,
      taskId: createData.taskId
    }, { timeout: 15000, validateStatus: () => true });

    if (res.data.status === 'ready') {
      const text = res.data.solution?.text || '';
      if (!text) throw new Error('CapSolver ready sin texto en polling');
      console.log(`[REINO B - capsolver] resuelto via polling (module=${createData._module}): "${text}"`);
      return text;
    }
    if (res.data.errorId) {
      throw new Error(`CapSolver error - ${res.data.errorCode}: ${res.data.errorDescription}`);
    }
  }

  throw new Error('CapSolver timeout sin solución');
}

module.exports = { resolverKaptcha };
