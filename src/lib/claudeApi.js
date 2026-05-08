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

module.exports = { chat };
