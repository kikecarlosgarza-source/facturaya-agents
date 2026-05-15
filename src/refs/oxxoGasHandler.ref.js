// Handler para OXXO Gas (facturacion.oxxogas.com).
// Stack: jQuery + Bootstrap clásico (NO SPA) → Pattern A HTTP puro.
//
// Pattern A — HTTP-only con cookie jar manual + reCAPTCHA v2 via CapSolver:
//   1. GET / para sembrar cookies de sesión (HttpOnly)
//   2. Resolver reCAPTCHA v2 (ReCaptchaV2TaskProxyLess, CapSolver)
//   3. POST /login (username + password + g-recaptcha-response) → 302 a / = OK
//   4. POST /facturacion/facturar/getRfc → verificar que el RFC del perfil
//      esté registrado en la cuenta del portal (registro fiscal es one-time
//      UI manual; si no está, abortar con mensaje accionable al usuario)
//   5. POST /facturacion/facturar/tickets (estacion E#####, ticket, monto)
//   6. POST /facturacion/facturar/factura (isCFDI4=true + datos fiscales)
//   7. CRÍTICO — fix false-success: el POST /factura puede responder OK pero
//      no timbrar. Verificación real = POST /facturacion/facturas/getList
//      (mes/año del ticket) y BUSCAR el folio en la respuesta. Reintentar
//      con backoff (5s, 15s, 30s) antes de declarar éxito.
//   8. Descargar XML+PDF por folio y devolverlos al usuario.
//
// Sin CSRF token (solo cookies de sesión). Hidden input siempre: isCFDI4=true.
// Keepalive POST /checkuser durante las esperas largas de verificación para
// no perder la sesión mientras hacemos backoff.

const axios = require('axios');
const claudeAgent = require('../claudeAgent');

const BASE = 'https://facturacion.oxxogas.com';
const RECAPTCHA_SITEKEY = '6LffM8gUAAAAAFIRetb-JWSrQFPIZ--N6ptkY1WY';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function makeReportApi(portal) {
  return (endpoint, request, e) =>
    claudeAgent.analyzeApiFailure({
      portal, endpoint, request,
      responseStatus: e.response?.status,
      responseBody: e.response?.data,
      error: e.message
    }).catch(err => console.warn(`[OTA ${portal}] analyzeApiFailure falló (${endpoint}):`, err.message));
}

// reCAPTCHA v2 via CapSolver (ReCaptchaV2TaskProxyLess). Devuelve el token
// gRecaptchaResponse que va en el campo g-recaptcha-response del form de login.
// Loop de polling clonado del estilo del handler de 7-Eleven.
async function resolverRecaptchaV2(websiteURL) {
  const capKey = process.env.CAPSOLVER_API_KEY;
  if (!capKey) throw new Error('CAPSOLVER_API_KEY no configurada');

  const create = await axios.post('https://api.capsolver.com/createTask', {
    clientKey: capKey,
    task: {
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL,
      websiteKey: RECAPTCHA_SITEKEY
    }
  }, { timeout: 15000, validateStatus: () => true });

  console.log(`[AUTO] OXXO Gas - CapSolver createTask status=${create.status} errorId=${create.data?.errorId || 0}`);
  if (create.data?.errorId) {
    throw new Error('CapSolver createTask error - ' + (create.data.errorDescription || create.data.errorCode));
  }
  const taskId = create.data?.taskId;
  if (!taskId) throw new Error('CapSolver createTask sin taskId: ' + JSON.stringify(create.data).substring(0, 200));

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await axios.post('https://api.capsolver.com/getTaskResult',
      { clientKey: capKey, taskId },
      { timeout: 15000, validateStatus: () => true });
    console.log(`[AUTO] OXXO Gas - CapSolver getTaskResult[${i}] status=${res.data?.status} errorId=${res.data?.errorId || 0}`);
    if (res.data?.status === 'ready') {
      const token = res.data.solution?.gRecaptchaResponse || '';
      if (!token) throw new Error('CapSolver ready sin gRecaptchaResponse');
      console.log('[AUTO] OXXO Gas - reCAPTCHA resuelto, token len=' + token.length);
      return token;
    }
    if (res.data?.errorId) {
      throw new Error(`CapSolver error - ${res.data.errorCode}: ${res.data.errorDescription}`);
    }
  }
  throw new Error('CapSolver timeout sin solución reCAPTCHA');
}

// El portal opera por mes/año. Extraer {mes:1-12, anio} de la fecha del ticket
// (acepta YYYY-MM-DD o DD/MM/YYYY). Default: fecha actual con warn.
function mesAnioDeFecha(s) {
  const orig = String(s || '').trim();
  let m = orig.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { mes: parseInt(m[2], 10), anio: parseInt(m[1], 10) };
  m = orig.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return { mes: parseInt(m[2], 10), anio: parseInt(m[3], 10) };
  const now = new Date();
  console.warn('[AUTO] OXXO Gas - fecha no parseable, usando mes/año actual:', orig);
  return { mes: now.getMonth() + 1, anio: now.getFullYear() };
}

// monto como texto con 2 decimales (el portal lo espera como string).
function montoStr(total) {
  if (total == null) return '';
  const n = Number(total);
  return Number.isFinite(n) ? n.toFixed(2) : String(total);
}

// Solo código SAT, sin "código - descripción".
function soloCodigo(value) {
  if (value == null) return '';
  return String(value).trim().split('-')[0].trim();
}

async function ejecutar(perfil, ticketData, solicitudId) {
  const reportApi = makeReportApi('oxxo gas');

  // ── Validación de inputs ───────────────────────────────────────────────
  const folio    = String(ticketData.folio || ticketData.numero_ticket || '').trim();
  const estacion = String(ticketData.estacion || ticketData.numero_estacion || ticketData.web_id || '').trim();
  const monto    = montoStr(ticketData.total);
  const { mes, anio } = mesAnioDeFecha(ticketData.fecha_compra || ticketData.fecha);

  if (!folio)            return { success: false, mensaje: 'OXXO Gas: folio del ticket requerido' };
  if (!estacion)         return { success: false, mensaje: 'OXXO Gas: código de estación (E#####) requerido' };
  if (!ticketData.total) return { success: false, mensaje: 'OXXO Gas: monto del ticket requerido' };
  if (!perfil?.rfc)      return { success: false, mensaje: 'OXXO Gas: RFC del perfil requerido' };

  // Credenciales del portal (cuenta del usuario en OXXO Gas).
  let creds = {};
  try { creds = JSON.parse(perfil.password_portales || '{}')?.oxxo_gas || {}; } catch {}
  if (!creds.email || !creds.password) {
    return {
      success: false,
      manual: true,
      mensaje: 'Credenciales OXXO Gas no configuradas. Ve a Perfil > Portales.'
    };
  }

  // ── Cookie jar manual ──────────────────────────────────────────────────
  const jar = {};
  const parseCookies = (h) => {
    const sc = h?.['set-cookie']; if (!sc) return;
    (Array.isArray(sc) ? sc : [sc]).forEach(c => {
      const [nv] = c.split(';'); const [n, v] = nv.split('=');
      if (n) jar[n.trim()] = v ? v.trim() : '';
    });
  };
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');

  // application/x-www-form-urlencoded (form jQuery/Bootstrap clásico).
  function formOpts(extraHeaders = {}) {
    return {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': BASE + '/',
        'Origin': BASE,
        'User-Agent': UA,
        'Cookie': cookieHeader(),
        ...extraHeaders
      },
      timeout: 30000,
      maxRedirects: 0,                       // queremos ver el 302 del login
      validateStatus: () => true
    };
  }
  const form = (obj) => new URLSearchParams(obj).toString();

  // Keepalive best-effort para no perder sesión durante backoff largo.
  async function keepalive() {
    try {
      await axios.post(BASE + '/checkuser', form({}), formOpts());
      console.log('[AUTO] OXXO Gas - keepalive /checkuser OK');
    } catch (e) {
      console.warn('[AUTO] OXXO Gas - keepalive /checkuser falló (no crítico):', e.message);
    }
  }

  // ── STEP 0: GET inicial — sembrar cookies ──────────────────────────────
  try {
    const r = await axios.get(BASE + '/', {
      headers: { 'User-Agent': UA },
      timeout: 30000,
      maxRedirects: 0,
      validateStatus: () => true
    });
    parseCookies(r.headers);
    console.log('[AUTO] OXXO Gas - paso 0: GET / status=' + r.status + ' cookies=' + Object.keys(jar).join(','));
  } catch (e) {
    reportApi(BASE + '/', null, e);
    return { success: false, mensaje: 'OXXO Gas: GET inicial falló — ' + e.message };
  }

  // ── STEP 1: reCAPTCHA + LOGIN ──────────────────────────────────────────
  let recaptchaToken;
  try {
    recaptchaToken = await resolverRecaptchaV2(BASE + '/login');
  } catch (e) {
    reportApi('CapSolver/ReCaptchaV2', { websiteURL: BASE + '/login' }, e);
    return { success: false, mensaje: 'OXXO Gas: reCAPTCHA no resuelto — ' + e.message };
  }

  try {
    const r = await axios.post(BASE + '/login', form({
      username: creds.email,
      password: creds.password,
      'g-recaptcha-response': recaptchaToken
    }), formOpts());
    parseCookies(r.headers);
    const loc = r.headers?.location || '';
    console.log('[AUTO] OXXO Gas - paso 1: POST /login status=' + r.status + ' location=' + loc);

    // Éxito esperado: 302 a / (root con dashboard). Cualquier 200 que
    // re-renderice /login = credenciales/captcha rechazados.
    const okLogin = r.status === 302 && (loc === '/' || loc === BASE + '/' || loc.endsWith('/'));
    if (!okLogin) {
      const bodyStr = typeof r.data === 'string' ? r.data.substring(0, 200) : JSON.stringify(r.data).substring(0, 200);
      return {
        success: false,
        manual: true,
        mensaje: `OXXO Gas: login falló (status=${r.status}). Verificá email/contraseña del portal. ${bodyStr}`
      };
    }
  } catch (e) {
    reportApi(BASE + '/login', { username: creds.email }, e);
    return { success: false, mensaje: 'OXXO Gas: excepción en login — ' + e.message };
  }

  // ── STEP 2: getRfc — el RFC debe estar registrado en la cuenta ─────────
  // El alta de datos fiscales es one-time vía UI del portal; el handler NO
  // lo automatiza. Si el RFC no está, abortar con mensaje accionable.
  try {
    const r = await axios.post(BASE + '/facturacion/facturar/getRfc', form({}), formOpts());
    parseCookies(r.headers);
    console.log('[AUTO] OXXO Gas - paso 2: getRfc status=' + r.status);
    if (r.status >= 400) {
      return { success: false, mensaje: `OXXO Gas: getRfc HTTP ${r.status}` };
    }
    const lista = Array.isArray(r.data) ? r.data : (r.data?.rfcs || r.data?.data || []);
    const rfcTarget = String(perfil.rfc).toUpperCase();
    const encontrado = (lista || []).some(item => {
      const v = (typeof item === 'string' ? item : (item.rfc || item.RFC || item.value || '')).toUpperCase();
      return v === rfcTarget;
    });
    if (!encontrado) {
      return {
        success: false,
        manual: true,
        error: 'RFC_NO_REGISTRADO',
        mensaje: `OXXO Gas: el RFC ${rfcTarget} no está registrado en tu cuenta del portal. Ingresá tus datos fiscales una vez en facturacion.oxxogas.com y reintentá.`
      };
    }
  } catch (e) {
    reportApi(BASE + '/facturacion/facturar/getRfc', null, e);
    return { success: false, mensaje: 'OXXO Gas: excepción en getRfc — ' + e.message };
  }

  // ── STEP 3: AGREGAR TICKET ─────────────────────────────────────────────
  try {
    const r = await axios.post(BASE + '/facturacion/facturar/tickets', form({
      estacion,
      ticket: folio,
      monto
    }), formOpts());
    parseCookies(r.headers);
    console.log('[AUTO] OXXO Gas - paso 3: tickets status=' + r.status + ' estacion=' + estacion + ' ticket=' + folio + ' monto=' + monto);
    if (r.status >= 400) {
      return { success: false, mensaje: `OXXO Gas: agregar ticket HTTP ${r.status}` };
    }
    const ok = r.data?.success === true || r.data?.ok === true || r.data?.status === 'ok' || r.data === true;
    if (!ok) {
      const msg = r.data?.message || r.data?.error || JSON.stringify(r.data).substring(0, 200);
      return {
        success: false,
        error: 'TICKET_RECHAZADO',
        mensaje: `OXXO Gas: ticket rechazado — ${msg} (estacion=${estacion}, folio=${folio})`
      };
    }
  } catch (e) {
    reportApi(BASE + '/facturacion/facturar/tickets', { estacion, ticket: folio, monto }, e);
    return { success: false, mensaje: 'OXXO Gas: excepción agregando ticket — ' + e.message };
  }

  // ── STEP 4: GENERAR CFDI ───────────────────────────────────────────────
  const facturaPayload = {
    isCFDI4: 'true',                                  // hidden input siempre
    rfc: String(perfil.rfc).toUpperCase(),
    regimen_fiscal: soloCodigo(perfil.regimen_fiscal || perfil.regimen) || '612',
    usocfdi: soloCodigo(perfil.uso_cfdi) || 'G03',
    rfc_email: perfil.email || creds.email || ''
  };
  try {
    const r = await axios.post(BASE + '/facturacion/facturar/factura', form(facturaPayload), formOpts());
    parseCookies(r.headers);
    console.log('[AUTO] OXXO Gas - paso 4: factura status=' + r.status);
    if (r.status >= 400) {
      return { success: false, mensaje: `OXXO Gas: generar CFDI HTTP ${r.status}` };
    }
    // NOTA: NO confiar en este response para declarar éxito. El portal puede
    // responder OK y no timbrar (false-success). La verdad está en getList.
    const respMsg = r.data?.message || r.data?.error || '';
    if (r.data?.success === false || /error|inválid|rechaz/i.test(String(respMsg))) {
      return {
        success: false,
        error: 'FACTURA_RECHAZADA',
        mensaje: `OXXO Gas: /factura rechazó la solicitud — ${respMsg || JSON.stringify(r.data).substring(0, 200)}`
      };
    }
    console.log('[AUTO] OXXO Gas - /factura aceptó solicitud; verificando en getList...');
  } catch (e) {
    reportApi(BASE + '/facturacion/facturar/factura', facturaPayload, e);
    return { success: false, mensaje: 'OXXO Gas: excepción generando CFDI — ' + e.message };
  }

  // ── STEP 5 (CRÍTICO): VERIFICAR POST-EMISIÓN — fix false-success ───────
  // Buscar el folio en /facturacion/facturas/getList del mes/año del ticket.
  // Backoff: espera inicial 4s, luego reintentos 5s/15s/30s. Keepalive entre
  // medias para no perder la sesión durante el backoff largo.
  const esperas = [4000, 5000, 15000, 30000];
  let facturaEmitida = null;

  for (let intento = 0; intento < esperas.length; intento++) {
    await new Promise(r => setTimeout(r, esperas[intento]));
    if (esperas[intento] >= 15000) await keepalive();

    try {
      const r = await axios.post(BASE + '/facturacion/facturas/getList', form({ mes, anio }), formOpts());
      parseCookies(r.headers);
      console.log(`[AUTO] OXXO Gas - paso 5: getList intento ${intento} status=${r.status} mes=${mes} anio=${anio}`);
      if (r.status >= 400) {
        console.warn(`[AUTO] OXXO Gas - getList HTTP ${r.status}, reintentando...`);
        continue;
      }
      const arr = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.facturas || []);
      const match = (arr || []).find(f => {
        const fFolio = String(f.Folio ?? f.folio ?? '').trim();
        const fRfc   = String(f.RFC ?? f.rfc ?? '').toUpperCase();
        return fFolio === folio && (!fRfc || fRfc === String(perfil.rfc).toUpperCase());
      });
      if (match) {
        facturaEmitida = match;
        console.log('[AUTO] OXXO Gas - factura CONFIRMADA en getList:', JSON.stringify(match).substring(0, 200));
        break;
      }
      console.warn(`[AUTO] OXXO Gas - folio ${folio} aún no aparece en getList (intento ${intento})`);
    } catch (e) {
      reportApi(BASE + '/facturacion/facturas/getList', { mes, anio }, e);
      console.warn('[AUTO] OXXO Gas - getList excepción (reintentando):', e.message);
    }
  }

  if (!facturaEmitida) {
    // false-success: NO marcar exitoso. El ticket pudo agregarse pero el
    // timbrado no se confirmó — el orquestador lo tratará como fallido.
    return {
      success: false,
      error: 'TIMBRADO_NO_CONFIRMADO',
      mensaje: `OXXO Gas: la solicitud se envió pero el folio ${folio} no apareció en getList tras 3 reintentos. Posible false-success — marcado como fallido para no entregar factura inexistente.`
    };
  }

  // ── STEP 6: DESCARGAR XML + PDF ────────────────────────────────────────
  const folioEmitido = String(facturaEmitida.Folio ?? facturaEmitida.folio ?? folio).trim();
  let xmlBase64 = null;
  let pdfBase64 = null;
  try {
    const rx = await axios.get(`${BASE}/facturacion/facturas/xml/${encodeURIComponent(folioEmitido)}`, {
      headers: { 'User-Agent': UA, 'Cookie': cookieHeader(), 'Referer': BASE + '/' },
      responseType: 'arraybuffer', timeout: 30000, validateStatus: () => true
    });
    if (rx.status < 400) {
      xmlBase64 = Buffer.from(rx.data).toString('base64');
      console.log('[AUTO] OXXO Gas - XML descargado bytes=' + rx.data.length);
    } else {
      console.warn('[AUTO] OXXO Gas - XML HTTP ' + rx.status);
    }
  } catch (e) {
    reportApi(`${BASE}/facturacion/facturas/xml/${folioEmitido}`, null, e);
    console.warn('[AUTO] OXXO Gas - XML excepción (no crítico):', e.message);
  }
  try {
    const rp = await axios.get(`${BASE}/facturacion/facturas/pdf/${encodeURIComponent(folioEmitido)}`, {
      headers: { 'User-Agent': UA, 'Cookie': cookieHeader(), 'Referer': BASE + '/' },
      responseType: 'arraybuffer', timeout: 30000, validateStatus: () => true
    });
    if (rp.status < 400) {
      pdfBase64 = Buffer.from(rp.data).toString('base64');
      console.log('[AUTO] OXXO Gas - PDF descargado bytes=' + rp.data.length);
    } else {
      console.warn('[AUTO] OXXO Gas - PDF HTTP ' + rp.status);
    }
  } catch (e) {
    reportApi(`${BASE}/facturacion/facturas/pdf/${folioEmitido}`, null, e);
    console.warn('[AUTO] OXXO Gas - PDF excepción (no crítico):', e.message);
  }

  const uuid = facturaEmitida.UUID || facturaEmitida.uuid || facturaEmitida.Uuid || '';
  return {
    success: true,
    uuid,
    folio: folioEmitido,
    xmlBase64,
    pdfBase64,
    mensaje: `Factura OXXO Gas emitida y confirmada (folio ${folioEmitido}${uuid ? ', UUID ' + uuid : ''})`
  };
}

module.exports = { ejecutar };
