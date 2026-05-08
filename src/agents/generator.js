// TODO: Generator — genera handler nuevo con Claude API.
// Plan:
//   - Recibir mapa estructural del Scout + handler base más similar del Reino A.
//   - Prompt a Claude con system caching (template de handler + ejemplos).
//   - Pedir handler nuevo siguiendo el contrato { ejecutar(perfil, ticketData, solicitudId) }.
//   - Validar sintaxis con node --check antes de pasar al Pusher.
//   - Retornar { filename, contenido }.

async function generarHandler() {
  throw new Error('generator.generarHandler — TODO');
}

module.exports = { generarHandler };
