const dns = require('dns').promises;

async function dnsResolves(url, timeoutMs = 3000) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, error: 'URL inválida', host: null };
  }

  try {
    await Promise.race([
      dns.resolve(host),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), timeoutMs))
    ]);
    return { ok: true, host };
  } catch (err) {
    return { ok: false, error: err.message, host };
  }
}

module.exports = { dnsResolves };
