// TODO: wrapper para Anthropic SDK.
// Plan:
//   - Inicializar cliente con ANTHROPIC_API_KEY (singleton lazy).
//   - chat({ system, messages, tools, model }) → respuesta + uso de tokens.
//   - Activar prompt caching con cache_control en bloques estables (system, ejemplos).
//   - Reintentos con backoff para 429 / 5xx.

async function chat() {
  throw new Error('claudeApi.chat — TODO');
}

module.exports = { chat };
