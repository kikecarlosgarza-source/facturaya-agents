// Scout Visual — Computer Use API agent.
// Adaptado de Reino A services/agentService.js. Cambios principales:
//   - Modelo Opus 4.7 (vs Sonnet 4.6), enable_zoom:true, MAX 50 (vs 20)
//   - Sin SQLite — devuelve { exito, uuid, accionesGrabadas, screenshots, costo }
//   - Cost tracker $5 cap, captcha pre-resolve via CapSolver
//   - finish_task tool custom para señal explícita
//   - playwright-extra + stealth (con fallback a playwright base)

const claudeApi = require('../lib/claudeApi');
const portalHints = require('../lib/portalHints');
const capsolver = require('../lib/capsolver');
const { createCostTracker } = require('../lib/costTracker');

const VIEWPORT = { width: 1280, height: 800 };
const MODEL = 'claude-opus-4-7';
const BETA = 'computer-use-2025-11-24';
const TOOL_TYPE = 'computer_20251124';
const MAX_ITER = 50;
const COST_CAP_USD = 5;
const ACTION_DELAY_MS = 1500;
const RATE_LIMIT_SLEEP_MS = 3000;

const FINISH_TOOL = {
  name: 'finish_task',
  description: 'Llama esto cuando termines la facturación: éxito con UUID timbrado o fallo definitivo. Tras llamarlo, ya no puedes hacer más acciones.',
  input_schema: {
    type: 'object',
    properties: {
      exito: { type: 'boolean' },
      uuid: { type: 'string', description: 'UUID del CFDI timbrado (folio fiscal). Vacío si exito=false.' },
      error: { type: 'string', description: 'Descripción del fallo si exito=false.' },
      resumen: { type: 'string', description: 'Una línea explicando qué se logró/intentó.' }
    },
    required: ['exito']
  }
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function loadChromium() {
  try {
    const playwrightExtra = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth')();
    playwrightExtra.chromium.use(stealth);
    console.log('[REINO B - scoutVisual] usando playwright-extra + stealth');
    return playwrightExtra.chromium;
  } catch (e) {
    console.warn(`[REINO B - scoutVisual] playwright-extra no disponible (${e.message}), usando playwright base`);
    return require('playwright').chromium;
  }
}

// Captura el selector CSS del elemento en (x,y). Patrón portado de
// Reino A agentService.js. Hace match por id > [name] > tag.class:nth-of-type
// con path de máx 4 niveles. Esto permite que el handler reproducible no
// dependa de coordenadas absolutas frágiles.
async function captureSelectorAt(page, coord) {
  if (!Array.isArray(coord)) return { selector: null, tag: null };
  try {
    const info = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      function escId(s) { try { return CSS.escape(s); } catch { return s; } }
      function build(e) {
        if (e.id) return '#' + escId(e.id);
        const name = e.getAttribute && e.getAttribute('name');
        if (name) return e.tagName.toLowerCase() + '[name="' + String(name).replace(/"/g, '\\"') + '"]';
        const path = [];
        let cur = e;
        while (cur && cur.nodeType === 1 && cur !== document.body) {
          let part = cur.tagName.toLowerCase();
          const cls = (cur.className && typeof cur.className === 'string') ? cur.className : '';
          if (cls) {
            const c = cls.split(/\s+/).filter(Boolean).slice(0, 2).map(escId).join('.');
            if (c) part += '.' + c;
          }
          const parent = cur.parentNode;
          if (parent && parent.children) {
            const same = Array.from(parent.children).filter(s => s.tagName === cur.tagName);
            if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
          }
          path.unshift(part);
          if (path.length > 4) break;
          cur = cur.parentNode;
        }
        return path.join(' > ');
      }
      return { selector: build(el), tag: el.tagName };
    }, coord);
    return info || { selector: null, tag: null };
  } catch {
    return { selector: null, tag: null };
  }
}

// Reemplaza valores literales (rfc, folio, etc.) por placeholders en el text
// grabado, para que el handler reproducible inyecte datos del perfil/ticket
// en lugar de los valores específicos de esta sesión.
function placeholderize(text, ctx) {
  if (!text) return text;
  let result = String(text);
  const subs = [
    ['{{folio}}',    String(ctx.folio || '')],
    ['{{rfc}}',      ctx.perfil.rfc || ''],
    ['{{nombre}}',   ctx.perfil.nombre || ''],
    ['{{cp}}',       ctx.perfil.cp || ''],
    ['{{email}}',    ctx.perfil.email || ''],
    ['{{regimen}}',  ctx.perfil.regimen || ''],
    ['{{uso_cfdi}}', ctx.perfil.uso_cfdi || ''],
    ['{{total}}',    String(ctx.total || '')],
    ['{{fecha}}',    String(ctx.fecha || '')]
  ].filter(([, v]) => v && v.length >= 2)
   .sort((a, b) => b[1].length - a[1].length);
  for (const [ph, val] of subs) {
    const re = new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (re.test(result)) result = result.replace(re, ph);
  }
  return result;
}

// Mapping de teclas que Claude API devuelve (formato xdotool/CapsLowerCase)
// a los valores que Playwright espera. Sin esto, page.keyboard.press("ctrl+Tab")
// silencia el comando — Playwright requiere "Control+Tab".
const KEY_NORMALIZE = {
  ctrl: 'Control', control: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  cmd: 'Meta', meta: 'Meta', super: 'Meta', win: 'Meta',
  enter: 'Enter', return: 'Enter',
  tab: 'Tab',
  escape: 'Escape', esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete', del: 'Delete',
  space: 'Space',
  up: 'ArrowUp', arrowup: 'ArrowUp',
  down: 'ArrowDown', arrowdown: 'ArrowDown',
  left: 'ArrowLeft', arrowleft: 'ArrowLeft',
  right: 'ArrowRight', arrowright: 'ArrowRight',
  home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown'
};

function normalizarTeclas(text) {
  if (!text) return text;
  return String(text).split('+').map(part => {
    const lower = part.toLowerCase().trim();
    return KEY_NORMALIZE[lower] || part;
  }).join('+');
}

async function ejecutarAccion(page, input) {
  const action = input.action;
  console.log('[REINO B - scoutVisual] ejecutando:', action, JSON.stringify(input).substring(0, 100));

  switch (action) {
    case 'screenshot':
      break;
    case 'left_click':
      await page.mouse.click(input.coordinate[0], input.coordinate[1]);
      await sleep(800);
      break;
    case 'right_click':
      await page.mouse.click(input.coordinate[0], input.coordinate[1], { button: 'right' });
      await sleep(500);
      break;
    case 'double_click':
      await page.mouse.dblclick(input.coordinate[0], input.coordinate[1]);
      await sleep(500);
      break;
    case 'triple_click':
      await page.mouse.click(input.coordinate[0], input.coordinate[1], { clickCount: 3 });
      await sleep(500);
      break;
    case 'type':
      await page.keyboard.type(input.text, { delay: 50 });
      await sleep(300);
      break;
    case 'key': {
      const rawKey = input.text || input.key;
      const normalized = normalizarTeclas(rawKey);
      await page.keyboard.press(normalized);
      await sleep(300);
      break;
    }
    case 'scroll': {
      const dir = input.scroll_direction || input.direction;
      const amt = input.scroll_amount || 3;
      if (Array.isArray(input.coordinate)) {
        await page.mouse.move(input.coordinate[0], input.coordinate[1]);
      }
      const dy = (dir === 'up' ? -1 : 1) * amt * 100;
      const dx = (dir === 'left' ? -1 : (dir === 'right' ? 1 : 0)) * amt * 100;
      await page.mouse.wheel(dx, dy);
      await sleep(300);
      break;
    }
    case 'mouse_move':
      await page.mouse.move(input.coordinate[0], input.coordinate[1]);
      break;
    case 'wait':
      await sleep(Math.min((input.duration || 1) * 1000, 5000));
      break;
    default:
      console.log(`[REINO B - scoutVisual] acción no implementada: ${action}`);
  }
}

async function tomarScreenshotBase64(page) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false });
  return buf.toString('base64');
}

// Pre-resolución de captcha: si hay <img id*=Kaptcha> visible al cargar,
// lo descargamos y resolvemos con CapSolver antes del loop. El texto se
// inyecta como hint en el primer mensaje para que Claude lo use cuando
// llegue al campo correspondiente.
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

  console.log(`[REINO B - scoutVisual] captcha detectado en ${captchaInfo.selector}, pre-resolviendo via CapSolver`);
  try {
    const kaptchaResp = await page.request.get(captchaInfo.src);
    const buf = await kaptchaResp.body();
    if (buf.length < 500) {
      console.warn(`[REINO B - scoutVisual] captcha image sospechosamente pequeña (${buf.length} bytes), skip`);
      return null;
    }
    const texto = await capsolver.resolverKaptcha(buf.toString('base64'));
    return { selector: captchaInfo.selector, texto };
  } catch (err) {
    console.warn(`[REINO B - scoutVisual] CapSolver pre-resolve falló: ${err.message}`);
    return null;
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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`
      ]
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      viewport: VIEWPORT
    });
    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    console.log(`[REINO B - scoutVisual] navigating to ${urlPortal}`);
    await page.goto(urlPortal, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);

    const captchaInfo = await detectarYResolverCaptcha(page);
    const hintDominio = portalHints.buildHintForPortal(urlPortal, ctx);
    const hintCaptcha = captchaInfo
      ? `\nCAPTCHA DETECTADO en ${captchaInfo.selector}: el texto del captcha ya está pre-resuelto = "${captchaInfo.texto}". Cuando llegues al campo del captcha, escribe ese valor exacto.\n`
      : '';

    const messages = [{
      role: 'user',
      content: [{
        type: 'text',
        text: 'Completa la solicitud de factura electrónica en este portal.\n\n' +
          hintDominio +
          hintCaptcha +
          'DATOS DEL TICKET:\n' +
          `- Folio/Orden: ${ctx.folio}\n` +
          `- Total: $${ctx.total}\n` +
          `- Fecha: ${ctx.fecha}\n\n` +
          'DATOS FISCALES:\n' +
          `- RFC: ${ctx.perfil.rfc}\n` +
          `- Nombre: ${ctx.perfil.nombre}\n` +
          `- CP: ${ctx.perfil.cp}\n` +
          `- Email: ${ctx.perfil.email}\n` +
          `- Régimen fiscal: ${ctx.perfil.regimen}\n` +
          `- Uso CFDI: ${ctx.perfil.uso_cfdi}\n\n` +
          'Toma un screenshot para ver el estado actual y comienza. Cuando termines la facturación o detectes que es imposible, llama al tool finish_task con el UUID timbrado y exito=true. Si fallas definitivamente, llama finish_task con exito=false y un error descriptivo.'
      }]
    }];

    const tools = [
      {
        type: TOOL_TYPE,
        name: 'computer',
        display_width_px: VIEWPORT.width,
        display_height_px: VIEWPORT.height,
        enable_zoom: true
      },
      FINISH_TOOL
    ];

    let iter = 0;
    let resultado = null;

    while (iter < MAX_ITER) {
      iter++;

      if (!cost.puedeContinuar()) {
        const stats = cost.getStats();
        console.warn(`[REINO B - scoutVisual] cost cap $${stats.capUsd} alcanzado en iter ${iter}: $${stats.costUsd}`);
        resultado = { exito: false, error: `cost cap $${stats.capUsd} alcanzado` };
        break;
      }

      await sleep(RATE_LIMIT_SLEEP_MS);
      console.log(`[REINO B - scoutVisual] iter ${iter}/${MAX_ITER}`);

      // Asegurar que el último user msg tenga screenshot si no hay tool_result
      const ultimoMsg = messages[messages.length - 1];
      if (ultimoMsg.role === 'user' && Array.isArray(ultimoMsg.content)) {
        const tieneToolResult = ultimoMsg.content.some(c => c.type === 'tool_result');
        const tieneImagen = ultimoMsg.content.some(c => c.type === 'image');
        if (!tieneToolResult && !tieneImagen) {
          const sc = await tomarScreenshotBase64(page);
          ultimoMsg.content.push({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: sc }
          });
          if (screenshots.length < 5) screenshots.push({ iter, base64: sc });
        }
      }

      let respuesta;
      try {
        respuesta = await claudeApi.chatBeta({
          model: MODEL,
          messages,
          tools,
          betas: [BETA],
          maxTokens: 4096
        });
      } catch (err) {
        const status = err.status || err.response?.status;
        if (status === 429) {
          console.log('[REINO B - scoutVisual] rate limit 429, esperando 60s');
          await sleep(60000);
          continue;
        }
        throw err;
      }

      cost.addUsage(respuesta.usage);
      messages.push({ role: 'assistant', content: respuesta.content });

      const toolUseBlocks = (respuesta.content || []).filter(b => b.type === 'tool_use');

      // finish_task → terminar
      const finishCall = toolUseBlocks.find(b => b.name === 'finish_task');
      if (finishCall) {
        console.log(`[REINO B - scoutVisual] finish_task: ${JSON.stringify(finishCall.input)}`);
        resultado = {
          exito: !!finishCall.input.exito,
          uuid: finishCall.input.uuid || null,
          error: finishCall.input.error || null,
          resumen: finishCall.input.resumen || null
        };
        break;
      }

      // stop_reason !== 'tool_use' sin finish_task → fallback heurístico
      if (respuesta.stop_reason !== 'tool_use') {
        const textoFinal = respuesta.content.filter(b => b.type === 'text').map(b => b.text).join('');
        console.log(`[REINO B - scoutVisual] stop_reason=${respuesta.stop_reason}, texto: ${textoFinal.substring(0, 200)}`);
        const cuerpo = await page.textContent('body').catch(() => '');
        const exitoso = /exit|complet|factura/i.test(textoFinal) ||
                        /exitosa|enviada|generada/i.test(cuerpo);
        resultado = {
          exito: exitoso,
          uuid: null,
          error: exitoso ? null : 'Claude terminó sin llamar finish_task'
        };
        break;
      }

      // Procesar acciones del computer tool
      const toolResults = [];
      for (const block of toolUseBlocks) {
        if (block.name !== 'computer') continue;
        const input = block.input;
        const action = input.action;

        let resultadoBlock;
        if (action === 'screenshot') {
          await sleep(1000);
          const sc = await tomarScreenshotBase64(page);
          if (screenshots.length < 5) screenshots.push({ iter, base64: sc });
          resultadoBlock = [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: sc }
          }];
        } else {
          const isClick = action === 'left_click' || action === 'right_click' ||
                          action === 'double_click' || action === 'triple_click';
          let selectorInfo = { selector: null, tag: null };
          if (isClick) {
            selectorInfo = await captureSelectorAt(page, input.coordinate);
          }

          await ejecutarAccion(page, input);
          await sleep(ACTION_DELAY_MS);

          if (isClick) {
            accionesGrabadas.push({
              type: action,
              coord: input.coordinate,
              selector: selectorInfo.selector,
              tag: selectorInfo.tag,
              wait: 800
            });
          } else if (action === 'type') {
            accionesGrabadas.push({
              type: 'type',
              text: placeholderize(input.text, ctx),
              wait: 300
            });
          } else if (action === 'key') {
            accionesGrabadas.push({
              type: 'key',
              key: normalizarTeclas(input.text || input.key),
              wait: 300
            });
          } else if (action === 'scroll') {
            accionesGrabadas.push({
              type: 'scroll',
              coord: input.coordinate,
              direction: input.scroll_direction || input.direction,
              amount: input.scroll_amount,
              wait: 300
            });
          }

          const sc = await tomarScreenshotBase64(page);
          if (screenshots.length < 5) screenshots.push({ iter, base64: sc });
          resultadoBlock = [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: sc }
          }];
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: resultadoBlock
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    if (!resultado) {
      resultado = { exito: false, error: `MAX_ITER ${MAX_ITER} alcanzado sin finish_task` };
    }

    return {
      ...resultado,
      accionesGrabadas,
      screenshots,
      costo: cost.getStats()
    };
  } catch (err) {
    console.error(`[REINO B - scoutVisual] error: ${err.message}`);
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
