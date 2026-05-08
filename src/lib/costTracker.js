// Tarifas en USD por millón de tokens.
const PRECIOS = {
  'claude-opus-4-7':   { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3,  output: 15 }
};

function createCostTracker({ capUsd = 5, model = 'claude-opus-4-7' } = {}) {
  const precios = PRECIOS[model];
  if (!precios) {
    throw new Error(`costTracker: precios no definidos para modelo "${model}"`);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;

  function addUsage(usage = {}) {
    // Cache_creation y cache_read se cuentan como input para simplificar.
    inputTokens  += (usage.input_tokens || 0);
    inputTokens  += (usage.cache_creation_input_tokens || 0);
    inputTokens  += (usage.cache_read_input_tokens || 0);
    outputTokens += (usage.output_tokens || 0);
    calls++;
  }

  function getCostUsd() {
    return (inputTokens * precios.input + outputTokens * precios.output) / 1_000_000;
  }

  function puedeContinuar() {
    return getCostUsd() < capUsd;
  }

  function getStats() {
    return {
      calls,
      inputTokens,
      outputTokens,
      costUsd: Math.round(getCostUsd() * 1000) / 1000,
      capUsd,
      model
    };
  }

  return { addUsage, puedeContinuar, getStats, getCostUsd };
}

module.exports = { createCostTracker, PRECIOS };
