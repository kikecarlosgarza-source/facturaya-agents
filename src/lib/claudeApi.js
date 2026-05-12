const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.Anthropic || sdk.default || sdk;

const RETRYABLE_STATUS = [429, 500, 502, 503, 504];

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY no configurada');
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

async function chat({ system, messages, model = 'claude-sonnet-4-5-20250929', maxTokens = 8192 }) {
  const client = getClient();
  let lastErr;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages
      });
      const text = (resp.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      const usage = resp.usage || {};
      console.log(`[REINO B] Claude usage: input=${usage.input_tokens || 0} output=${usage.output_tokens || 0} model=${model}`);
      return { text, usage };
    } catch (err) {
      lastErr = err;
      const status = err.status || err.response?.status;
      if (!RETRYABLE_STATUS.includes(status) || attempt === 3) break;
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.warn(`[REINO B] Claude API ${status} - retry ${attempt}/3 en ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// chatBeta: variante con beta header. Necesario para Computer Use
// (computer-use-2025-11-24) y otros features beta. Acepta tools y betas
// además de los params estándar. Devuelve content + stop_reason crudos para
// que el caller pueda parsear tool_use blocks.
async function chatBeta({ system, messages, tools, betas, model = 'claude-opus-4-7', maxTokens = 4096, toolChoice, allowParallelTools = false }) {
  const client = getClient();
  let lastErr;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const params = { model, max_tokens: maxTokens, messages };
      if (system) params.system = system;
      if (tools) params.tools = tools;
      // Default: prohibir parallel tool calls. Los agentes DOM-based necesitan
      // que cada acción modifique el DOM antes de decidir la siguiente.
      // Pasar allowParallelTools=true o toolChoice explícito para opt-out.
      if (toolChoice) {
        params.tool_choice = toolChoice;
      } else if (tools && !allowParallelTools) {
        params.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
      }
      if (betas && betas.length > 0) params.betas = betas;

      const resp = await client.beta.messages.create(params);
      const text = (resp.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      const usage = resp.usage || {};
      console.log(`[REINO B] Claude beta usage: input=${usage.input_tokens || 0} output=${usage.output_tokens || 0} model=${model} stop_reason=${resp.stop_reason}`);
      return {
        text,
        usage,
        content: resp.content,
        stop_reason: resp.stop_reason,
        full: resp
      };
    } catch (err) {
      lastErr = err;
      const status = err.status || err.response?.status;
      if (!RETRYABLE_STATUS.includes(status) || attempt === 3) break;
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.warn(`[REINO B] Claude beta API ${status} - retry ${attempt}/3 en ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

module.exports = { chat, chatBeta };
