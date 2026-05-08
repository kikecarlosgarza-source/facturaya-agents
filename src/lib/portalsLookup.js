// Resolución de URL de portal con prioridad:
//   1. Override manual desde portals.json (match exacto o parcial sobre nombre normalizado)
//   2. Cache en memoria (TTL 30min)
//   3. Web search via Anthropic API (tool web_search_20250305)
//
// Patrón inspirado en Reino A services/scout.js (web_search) pero sin SQLite.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const PORTALS_JSON_PATH = path.join(__dirname, 'portals.json');
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const SEARCH_MODEL = 'claude-sonnet-4-6';
const SEARCH_TIMEOUT_MS = 90000;
const CACHE_TTL_MS = 30 * 60 * 1000;

function normalizar(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function loadOverrides() {
  try {
    const raw = fs.readFileSync(PORTALS_JSON_PATH, 'utf8');
    const data = JSON.parse(raw);
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      out[normalizar(k)] = v;
    }
    return out;
  } catch (err) {
    console.warn(`[REINO B - portalsLookup] no se pudo cargar portals.json: ${err.message}`);
    return {};
  }
}

const overrides = loadOverrides();
const cache = new Map();

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    cache.delete(key);
    return null;
  }
  return e.url;
}

function cacheSet(key, url) {
  cache.set(key, { url, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function webSearch({ portal, establecimiento }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada');

  const target = portal || establecimiento || '';
  const userMsg = `Busca en internet la URL OFICIAL VIGENTE del portal de facturación electrónica de "${target}" en México.

Solo URLs oficiales del propio negocio. NO listicles, blogs, comparativas o sitios de terceros.

Responde SOLO con JSON sin backticks:
{"portal_url": "https://...", "confidence": 0.0-1.0, "razon": "una línea"}

Si no encuentras una URL oficial confiable: {"portal_url": null, "confidence": 0.0, "razon": "..."}`;

  const resp = await axios.post(ANTHROPIC_API, {
    model: SEARCH_MODEL,
    max_tokens: 1024,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: userMsg }]
  }, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    timeout: SEARCH_TIMEOUT_MS
  });

  const text = (resp.data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .replace(/```[\w]*\n?/g, '')
    .trim();

  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('webSearch: respuesta sin JSON');
  return JSON.parse(m[0]);
}

async function lookupPortalUrl({ portal, establecimiento } = {}) {
  const key = normalizar(portal || establecimiento);
  if (!key) return null;

  // 1a. Override exacto
  if (overrides[key]) {
    console.log(`[REINO B - portalsLookup] override exacto: ${key} → ${overrides[key]}`);
    return overrides[key];
  }

  // 1b. Override parcial (substring)
  for (const [overKey, overUrl] of Object.entries(overrides)) {
    if (key.includes(overKey) || overKey.includes(key)) {
      console.log(`[REINO B - portalsLookup] override parcial: ${key} ~ ${overKey} → ${overUrl}`);
      return overUrl;
    }
  }

  // 2. Cache memoria
  const cached = cacheGet(key);
  if (cached !== null) {
    console.log(`[REINO B - portalsLookup] cache hit: ${key} → ${cached}`);
    return cached;
  }

  // 3. Web search
  try {
    const result = await webSearch({ portal, establecimiento });
    if (result.portal_url && /^https?:\/\//.test(result.portal_url)) {
      cacheSet(key, result.portal_url);
      console.log(`[REINO B - portalsLookup] web_search: ${key} → ${result.portal_url} (conf=${result.confidence})`);
      return result.portal_url;
    }
    console.log(`[REINO B - portalsLookup] web_search sin URL para ${key}`);
    return null;
  } catch (err) {
    console.warn(`[REINO B - portalsLookup] web_search falló: ${err.message}`);
    return null;
  }
}

module.exports = { lookupPortalUrl };
