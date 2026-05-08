// Hints específicos por dominio. El agente CU entra a ciegas; cada hint le da
// los campos exactos del form, su orden y el valor que debe inyectar.
// Reglas comunes (NO presionar F11/Escape) las repetimos por hint en lugar de
// un system prompt para que estén siempre junto a los pasos.
//
// Hints alsea/shell/heb portados de Reino A services/agentService.js (líneas 120-170).
// Hints walmart/oxxo nuevos — basados en estructura típica; conviene refinar tras el
// primer ciclo end-to-end.

function buildHintForPortal(url, ctx) {
  if (!url) return '';

  if (url.includes('alsea.interfactura.com')) {
    const tienda = ctx.numero_tienda || '(no detectado en el ticket — búscalo)';
    const ticket = ctx.numero_ticket || ctx.folio;
    return (
      'alsea.interfactura.com tiene flujo de 2 pasos. Llena ambos en orden:\n\n' +
      'Paso 1 - Datos del ticket:\n' +
      '1. RFC: ' + ctx.perfil.rfc + '\n' +
      '2. Número de ticket (9 dígitos): ' + ticket + '\n' +
      '3. Número de tienda (5 dígitos): ' + tienda + '\n' +
      '4. Fecha: ' + ctx.fecha + '\n' +
      '5. Monto: ' + ctx.total + '\n' +
      'Presiona Enviar/Continuar.\n\n' +
      'Paso 2 - Datos fiscales (aparece después del paso 1):\n' +
      '1. Selecciona Persona Física\n' +
      '2. Régimen fiscal: ' + ctx.perfil.regimen + '\n' +
      '3. Uso CFDI: ' + ctx.perfil.uso_cfdi + '\n' +
      '4. Email: ' + ctx.perfil.email + '\n' +
      '5. Presiona Enviar.\n\n' +
      'NO presiones F11, Escape ni teclas de sistema.\n\n'
    );
  }

  if (url.includes('shell.com.mx/electronic-billing')) {
    return (
      'shell.com.mx/electronic-billing NO tiene un form único — es un selector de estado.\n' +
      'La página muestra una lista de estados de México (Aguascalientes, CDMX, Coahuila, etc.).\n' +
      'Cada estado redirige a un portal específico de Shell para esa región.\n' +
      'Pasos:\n' +
      '1. Identifica el estado de la estación Shell donde se cargó. Si el ticket o el establecimiento "' + (ctx.establecimiento || '') + '" no permite determinarlo, reporta el problema.\n' +
      '2. Click en el estado correspondiente.\n' +
      '3. En el portal del estado, busca el form de facturación y llénalo con:\n' +
      '   RFC: ' + ctx.perfil.rfc + ', Nombre: ' + ctx.perfil.nombre + ', CP: ' + ctx.perfil.cp + ', Email: ' + ctx.perfil.email + '\n' +
      '   Folio: ' + ctx.folio + ', Total: ' + ctx.total + ', Fecha: ' + ctx.fecha + '\n' +
      'NO presiones F11, Escape ni teclas de sistema.\n\n'
    );
  }

  if (url.includes('heb.com.mx')) {
    const tienda = ctx.numero_tienda || '(busca el número de Sucursal en el ticket)';
    return (
      'Pasos exactos para facturacion.heb.com.mx - llena los 4 campos del form "Agregar ticket":\n' +
      '1. Sucursal: ' + tienda + ' (es un autocomplete: escribe el número, espera la opción y selecciónala)\n' +
      '2. Ticket: ' + ctx.folio + ' (campo numérico)\n' +
      '3. Fecha: ' + ctx.fecha + ' (datepicker, formato dd/mm/aaaa)\n' +
      '4. Venta (Total): ' + ctx.total + '\n' +
      'Después presiona el botón "Agregar ticket". Luego el portal pedirá datos fiscales:\n' +
      'RFC ' + ctx.perfil.rfc + ', CP ' + ctx.perfil.cp + ', Email ' + ctx.perfil.email + '.\n' +
      'NO presiones F11, Escape ni teclas de sistema.\n\n'
    );
  }

  if (url.includes('walmartmexico.com.mx') || url.includes('facturacion.walmart')) {
    const ticket = ctx.numero_ticket || ctx.folio;
    return (
      'Pasos para facturacion.walmartmexico.com.mx (form único o flujo de 2 pasos):\n' +
      '1. Localiza el form de facturación (puede haber un botón "Comenzar" o "Facturar mi ticket" en la landing).\n' +
      '2. Datos del ticket:\n' +
      '   - Número de ticket / CFDI: ' + ticket + '\n' +
      '   - Fecha de compra: ' + ctx.fecha + '\n' +
      '   - Total / Importe: ' + ctx.total + '\n' +
      '3. Datos fiscales:\n' +
      '   - RFC: ' + ctx.perfil.rfc + '\n' +
      '   - Nombre / Razón social: ' + ctx.perfil.nombre + '\n' +
      '   - Código Postal: ' + ctx.perfil.cp + '\n' +
      '   - Email: ' + ctx.perfil.email + '\n' +
      '   - Régimen fiscal: ' + ctx.perfil.regimen + '\n' +
      '   - Uso CFDI: ' + ctx.perfil.uso_cfdi + '\n' +
      '4. Acepta términos / aviso de privacidad si aparecen.\n' +
      '5. Presiona "Facturar" o "Generar CFDI".\n' +
      'NO presiones F11, Escape ni teclas de sistema.\n\n'
    );
  }

  if (url.includes('factura.oxxo.com') || url.includes('factura.oxxo')) {
    const webId = ctx.web_id || ctx.folio;
    return (
      'Pasos para factura.oxxo.com (suele ser flujo de 2 pasos):\n' +
      '1. Datos del ticket en pantalla inicial:\n' +
      '   - Folio web / ID web: ' + webId + '\n' +
      '   - Total: ' + ctx.total + '\n' +
      '   - Fecha: ' + ctx.fecha + '\n' +
      '   Presiona Continuar / Siguiente.\n' +
      '2. Datos fiscales en segunda pantalla:\n' +
      '   - RFC: ' + ctx.perfil.rfc + '\n' +
      '   - Nombre / Razón social: ' + ctx.perfil.nombre + '\n' +
      '   - Código Postal: ' + ctx.perfil.cp + '\n' +
      '   - Email: ' + ctx.perfil.email + '\n' +
      '   - Régimen fiscal: ' + ctx.perfil.regimen + '\n' +
      '   - Uso CFDI: ' + ctx.perfil.uso_cfdi + '\n' +
      '3. Presiona Facturar.\n' +
      'NO presiones F11, Escape ni teclas de sistema.\n\n'
    );
  }

  return '';
}

module.exports = { buildHintForPortal };
