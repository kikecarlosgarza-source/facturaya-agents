// Scout DOM-based con Playwright.
// Reemplaza el scout Computer Use anterior (coordenadas + screenshots) por
// un loop donde:
//   1. Playwright extrae DOM estructurado (inputs, buttons, selects, links)
//   2. Se manda a Claude como JSON con selectors CSS reales
//   3. Claude responde { action, selector, value } o llama finish_task
//   4. Playwright ejecuta por selector
//
// Costo típico: $0.30-0.80 por scout (vs $5 con Computer Use)
// Confiabilidad: alta — Claude trabaja con DOM real, no adivina coordenadas

const claudeApi = require('../lib/claudeApi');
const portalHints = require('../lib/portalHints');
const capsolver = require('../lib/capsolver');
const { createCostTracker } = require('../lib/costTracker');

const VIEWPORT = { width: 1280, height: 800 };
const MODEL = 'claude-opus-4-7';
const MAX_ITER = 30;
const COST_CAP_USD = 3;
const ACTION_DELAY_MS = 800;
const MAX_ELEMENTS_PER_FRAME = 80;

const FINISH_TOOL = {
  name: 'finish_task',
  description: 'Llamar cuando termines: éxito con UUID/folio del CFDI, o fallo. Tras llamarlo no hay más acciones.',
  input_schema: {
    type: 'object',
    properties: {
      exito: { type: 'boolean' },
      uuid: { type: 'string', description: 'Folio fiscal del CFDI o UUID. Vacío si exito=false.' },
      error: { type: 'string', description: 'Descripción del fallo.' },
      resumen: { type: 'string', description: 'Una línea explicando qué se logró.' }
    },
    required: ['exito']
  }
};

const ACTION_TOOL = {
  name: 'browser_action',
  description: 'Ejecutar una acción sobre un elemento del DOM. Usar el selector exacto que aparece en la lista de elementos disponibles.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['click', 'fill', 'select', 'press', 'wait', 'goto'],
        description: 'click: clickear un botón/link. fill: escribir en un input/textarea. select: elegir opción de un <select>. press: presionar tecla (Enter/Tab). wait: esperar N ms. goto: navegar a URL.'
      },
      selector: {
        type: 'string',
        description: 'CSS selector del elemento. Copiarlo EXACTO de la lista de elementos.'
      },
      value: {
        type: 'string',
        description: 'Para fill: texto a escribir. Para select: option value o label. Para press: nombre de tecla (Enter/Tab). Para wait: ms. Para goto: URL.'
      },
      reason: {
        type: 'string',
        description: 'Una línea explicando por qué esta acción (para debug y handler reproducible).'
      }
    },
    required: ['action', 'reason']
  }
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function loadChromium() {
  try {
    const playwrightExtra = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth')();
    playwrightExtra.chromium.use(stealth);
    console.log('[REINO B - scout] usando playwright-extra + stealth');
    return playwrightExtra.chromium;
  } catch (e) {
    console.warn(`[REINO B - scout] playwright-extra no disponible (${e.message}), usando playwright base`);
    return require('playwright').chromium;
  }
}

// Reemplaza valores del ticket/perfil por placeholders {{rfc}}, {{folio}}, etc.
// Se usa al grabar acciones para que el handler reproducible inyecte datos
// del perfil del próximo ticket en lugar de los valores literales de esta sesión.
function placeholderize(text, ctx) {
  if (!text) return text;
  let result = String(text);
  const subs = [
    ['{{folio}}', String(ctx.folio || '')],
    ['{{rfc}}', ctx.perfil.rfc || ''],
    ['{{nombre}}', ctx.perfil.nombre || ''],
    ['{{cp}}', ctx.perfil.cp || ''],
    ['{{email}}', ctx.perfil.email || ''],
    ['{{regimen}}', ctx.perfil.regimen || ''],
    ['{{uso_cfdi}}', ctx.perfil.uso_cfdi || ''],
    ['{{total}}', String(ctx.total || '')],
    ['{{fecha}}', String(ctx.fecha || '')]
  ].filter(([, v]) => v && v.length >= 2)
   .sort((a, b) => b[1].length - a[1].length);
  for (const [ph, val] of subs) {
    const re = new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (re.test(result)) result = result.replace(re, ph);
  }
  return result;
}

async function tomarScreenshotBase64(page) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false });
  return buf.toString('base64');
}

async function detectarYResolverCaptcha(page) {
  const captchaInfo = await page.evaluate(() => {
    const selectores = ['#Kaptcha', '#captcha', 'img[id*="aptcha" i]'];
    for (const sel of selectores) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent && el.tagName === 'IMG' && el.src) {
        return { selector: sel, src: el.src };
      }
    }
    return null;
  });
  if (!captchaInfo) return null;

  console.log(`[REINO B - scout] captcha detectado en ${captchaInfo.selector}, pre-resolviendo via CapSolver`);
  try {
    const kaptchaResp = await page.request.get(captchaInfo.src);
    const buf = await kaptchaResp.body();
    if (buf.length < 500) {
      console.warn(`[REINO B - scout] captcha image sospechosamente pequeña (${buf.length} bytes), skip`);
      return null;
    }
    const texto = await capsolver.resolverKaptcha(buf.toString('base64'));
    return { selector: captchaInfo.selector, texto };
  } catch (err) {
    console.warn(`[REINO B - scout] CapSolver pre-resolve falló: ${err.message}`);
    return null;
  }
}

// Extrae los elementos interactivos visibles del DOM con CSS selectors estables.
// Limita a MAX_ELEMENTS_PER_FRAME para no saturar el contexto del modelo.
async function extraerDOM(page) {
  return await page.evaluate((max) => {
    function escId(s) { try { return CSS.escape(s); } catch { return s; } }

    function buildSelector(el) {
      if (el.id) return '#' + escId(el.id);
      const name = el.getAttribute('name');
      if (name) return `${el.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
      // Path con clases (max 4 niveles)
      const path = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.body && path.length < 4) {
        let part = cur.tagName.toLowerCase();
        const cls = (typeof cur.className === 'string') ? cur.className : '';
        if (cls) {
          const c = cls.split(/\s+/).filter(Boolean).slice(0, 2).map(escId).join('.');
          if (c) part += '.' + c;
        }
        const parent = cur.parentNode;
        if (parent && parent.children) {
          const same = Array.from(parent.children).filter(s => s.tagName === cur.tagName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
        path.unshift(part);
        cur = cur.parentNode;
      }
      return path.join(' > ');
    }

    function isVisible(el) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
    }

    function textoVisible(el) {
      let t = (el.innerText || el.textContent || '').trim();
      if (t.length > 80) t = t.substring(0, 77) + '...';
      return t;
    }

    const selectores = 'input, textarea, select, button, a[href], [role="button"], [role="link"], [role="checkbox"], [role="radio"], label';
    const elementos = Array.from(document.querySelectorAll(selectores))
      .filter(isVisible)
      .slice(0, max);

    return elementos.map(el => {
      const info = {
        selector: buildSelector(el),
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        placeholder: el.placeholder || null,
        name: el.getAttribute('name') || null,
        value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') ? (el.value || '').substring(0, 40) : null,
        text: textoVisible(el),
        ariaLabel: el.getAttribute('aria-label') || null,
        required: el.required || el.getAttribute('aria-required') === 'true' || null
      };
      // Si es <select>, agregar las opciones
      if (el.tagName === 'SELECT') {
        info.options = Array.from(el.options).slice(0, 50).map(o => ({
          value: o.value,
          label: (o.textContent || '').trim().substring(0, 60)
        }));
      }
      // Limpiar nulls
      return Object.fromEntries(Object.entries(info).filter(([, v]) => v !== null && v !== ''));
    });
  }, MAX_ELEMENTS_PER_FRAME);
}

// Mensajes de error visibles en la página (rojo, alertas, validaciones)
async function extraerMensajesError(page) {
  return await page.evaluate(() => {
    const selectores = '[class*="error" i], [class*="alert" i], [role="alert"], .invalid-feedback, [class*="invalid" i]';
    return Array.from(document.querySelectorAll(selectores))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map(el => (el.innerText || el.textContent || '').trim())
      .filter(t => t.length > 0 && t.length < 200)
      .slice(0, 10);
  });
}

async function ejecutarAccionDOM(page, accion, ctx) {
  const { action, selector, value, reason } = accion;
  console.log(`[REINO B - scout] ${action} ${selector || ''} value="${(value || '').substring(0, 40)}" — ${reason}`);

  switch (action) {
    case 'click': {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      await locator.click({ timeout: 5000 });
      return { type: 'click', selector, reason, wait: 800 };
    }
    case 'fill': {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      await locator.fill(String(value || ''));
      return { type: 'fill', selector, value: placeholderize(value, ctx), reason, wait: 300 };
    }
    case 'select': {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      // Probar por value primero, después por label
      try {
        await locator.selectOption({ value: String(value) });
      } catch {
        await locator.selectOption({ label: String(value) });
      }
      return { type: 'select', selector, value: placeholderize(value, ctx), reason, wait: 500 };
    }
    case 'press': {
      await page.keyboard.press(String(value || 'Enter'));
      return { type: 'press', key: value, reason, wait: 500 };
    }
    case 'wait': {
      const ms = Math.min(Number(value) || 1000, 5000);
      await sleep(ms);
      return { type: 'wait', ms, reason };
    }
    case 'goto': {
      await page.goto(String(value), { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { type: 'goto', url: value, reason, wait: 2000 };
    }
    default:
      throw new Error(`Acción desconocida: ${action}`);
  }
}

async function explorarYFacturar({ portal, urlPortal, ticketData, perfil }) {
  const cost = createCostTracker({ capUsd: COST_CAP_USD, model: MODEL });
  const accionesGrabadas = [];
  const screenshots = [];
  let browser;

  const ctx = {
    folio: ticketData.folio || '',
    fecha: ticketData.fecha_compra || ticketData.fecha || '',
    total: ticketData.total || '',
    numero_tienda: ticketData.numero_tienda || '',
    numero_ticket: ticketData.numero_ticket || '',
    web_id: ticketData.web_id || '',
    portal_url: urlPortal,
    establecimiento: ticketData.establecimiento || portal,
    perfil: {
      rfc: perfil.rfc || '',
      nombre: perfil.nombre || '',
      cp: perfil.cp || '',
      email: perfil.email || '',
      regimen: perfil.regimen || '612',
      uso_cfdi: perfil.uso_cfdi || 'G03'
    }
  };

  try {
    const chromium = await loadChromium();
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`]
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      viewport: VIEWPORT
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    console.log(`[REINO B - scout] navigating to ${urlPortal}`);
    await page.goto(urlPortal, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);

    const captchaInfo = await detectarYResolverCaptcha(page);
    const hintDominio = portalHints.buildHintForPortal(urlPortal, ctx);
    const captchaHint = captchaInfo
      ? `\nCAPTCHA pre-resuelto = "${captchaInfo.texto}". Usalo cuando llegues al campo del captcha.\n`
      : '';

    const systemPrompt = `Sos un agente que completa portales de facturación CFDI en México.

REGLA #1: En cada turno te paso una lista de elementos visibles del DOM (inputs, buttons, selects, etc) con sus CSS selectors EXACTOS. Vos elegís UN elemento y UNA acción. NUNCA inventes un selector — siempre copialo de la lista que te paso.

REGLA #2: Para escribir en un input usá action="fill" con selector + value. Para clickear botón/link usá action="click" con selector. Para elegir opción de <select> usá action="select" con selector + value (probá value primero, después label).

REGLA #3: Si ves un mensaje de error en pantalla, intentá corregir (probablemente escribiste algo mal en el último campo). Si el error persiste, llamá finish_task con exito=false.

REGLA #4: El portal NO siempre acepta cualquier régimen fiscal + uso CFDI. Si el portal rechaza por "régimen inválido", probá con régimen "612" + uso "G03". Si rechaza por "nombre fiscal no coincide", abortá con finish_task exito=false y error claro.

REGLA #5: Si reconocés que estás en la pantalla final con un folio fiscal / UUID timbrado / mensaje "Factura generada exitosamente", llamá finish_task con exito=true y el UUID. NUNCA inventes un UUID.

DATOS DEL TICKET ACTUAL:
- Folio del ticket de compra: ${ctx.folio}
- Total: $${ctx.total}
- Fecha: ${ctx.fecha}
- Número de tienda: ${ctx.numero_tienda || 'N/A'}
- Establecimiento: ${ctx.establecimiento}

DATOS FISCALES DEL CLIENTE:
- RFC: ${ctx.perfil.rfc}
- Nombre fiscal: ${ctx.perfil.nombre}
- CP: ${ctx.perfil.cp}
- Email: ${ctx.perfil.email}
- Régimen fiscal: ${ctx.perfil.regimen}
- Uso CFDI: ${ctx.perfil.uso_cfdi}

${hintDominio}
${captchaHint}`;

    const messages = [];

    let iter = 0;
    let resultado = null;

    while (iter < MAX_ITER) {
      iter++;

      if (!cost.puedeContinuar()) {
        const stats = cost.getStats();
        console.warn(`[REINO B - scout] cost cap $${stats.capUsd} alcanzado en iter ${iter}: $${stats.costUsd}`);
        resultado = { exito: false, error: `cost cap $${stats.capUsd} alcanzado` };
        break;
      }

      console.log(`[REINO B - scout] iter ${iter}/${MAX_ITER}`);

      // Extraer DOM + errores
      const elementos = await extraerDOM(page);
      const erroresVisibles = await extraerMensajesError(page);
      const urlActual = page.url();

      const turnoText = `URL actual: ${urlActual}\n\n` +
        (erroresVisibles.length > 0 ? `ERRORES VISIBLES EN PANTALLA:\n${erroresVisibles.map(e => '- ' + e).join('\n')}\n\n` : '') +
        `ELEMENTOS DISPONIBLES (${elementos.length}):\n` +
        JSON.stringify(elementos, null, 2);

      messages.push({ role: 'user', content: turnoText });

      let respuesta;
      try {
        respuesta = await claudeApi.chatBeta({
          model: MODEL,
          system: systemPrompt,
          messages,
          tools: [ACTION_TOOL, FINISH_TOOL],
          betas: [],
          maxTokens: 1024
        });
      } catch (err) {
        const status = err.status || err.response?.status;
        if (status === 429) {
          console.log('[REINO B - scout] rate limit 429, esperando 60s');
          await sleep(60000);
          messages.pop();
          continue;
        }
        throw err;
      }

      cost.addUsage(respuesta.usage);
      messages.push({ role: 'assistant', content: respuesta.content });

      const toolUses = (respuesta.content || []).filter(b => b.type === 'tool_use');

      const finishCall = toolUses.find(b => b.name === 'finish_task');
      if (finishCall) {
        console.log(`[REINO B - scout] finish_task: ${JSON.stringify(finishCall.input)}`);
        resultado = {
          exito: !!finishCall.input.exito,
          uuid: finishCall.input.uuid || null,
          error: finishCall.input.error || null,
          resumen: finishCall.input.resumen || null
        };
        break;
      }

      const actionCall = toolUses.find(b => b.name === 'browser_action');
      if (!actionCall) {
        const texto = respuesta.content.filter(b => b.type === 'text').map(b => b.text).join('');
        console.warn(`[REINO B - scout] stop sin tool_use, texto: ${texto.substring(0, 200)}`);
        resultado = { exito: false, error: 'modelo terminó sin acción ni finish_task' };
        break;
      }

      let resultadoBlock;
      try {
        const grabada = await ejecutarAccionDOM(page, actionCall.input, ctx);
        accionesGrabadas.push(grabada);
        await sleep(ACTION_DELAY_MS);
        resultadoBlock = `Acción ejecutada OK: ${actionCall.input.action} ${actionCall.input.selector || ''}`;
      } catch (err) {
        console.warn(`[REINO B - scout] acción falló: ${err.message}`);
        resultadoBlock = `Acción FALLÓ: ${err.message}. Probá otro selector de la lista.`;
      }

      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: actionCall.id,
          content: resultadoBlock
        }]
      });

      // Screenshot cada 5 iter para debug
      if (iter % 5 === 0 && screenshots.length < 5) {
        const sc = await tomarScreenshotBase64(page);
        screenshots.push({ iter, base64: sc });
      }
    }

    if (!resultado) {
      resultado = { exito: false, error: `MAX_ITER ${MAX_ITER} alcanzado sin finish_task` };
    }

    // Screenshot final
    if (screenshots.length < 5) {
      const sc = await tomarScreenshotBase64(page);
      screenshots.push({ iter: 'final', base64: sc });
    }

    return {
      ...resultado,
      accionesGrabadas,
      screenshots,
      costo: cost.getStats()
    };
  } catch (err) {
    console.error(`[REINO B - scout] error: ${err.message}`);
    return {
      exito: false,
      uuid: null,
      error: err.message,
      accionesGrabadas,
      screenshots,
      costo: cost.getStats()
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { explorarYFacturar };
