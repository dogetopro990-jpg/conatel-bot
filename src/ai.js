const config = require('./config');
const { normalizeText, parseTicketTag } = require('./utils');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ============ RESPUESTAS VARIADAS ============

const RESPONSES = {
  saludo: [
    '¡Hola! Soy el asistente de CONATEL, ¿en qué te puedo ayudar?',
    'Hola, ¿cómo estás? Dime qué necesitas.',
    '¡Buenas! Estoy aquí para ayudarte con lo que necesites.',
    'Hola, cuéntame ¿qué puedo hacer por ti hoy?',
    '¡Hey! Soy tu asistente de CONATEL, ¿en qué te ayudo?',
    'Buenos días, ¿en qué puedo colaborarte?',
    'Hola, estoy aquí para ayudarte. ¿Qué necesitas?',
    '¡Hola! Cuéntame, ¿en qué te puedo asistir?',
    'Buenas, ¿cómo te puedo ayudar hoy?'
  ],
  agradecimiento: [
    '¡Con gusto! ¿Necesitas algo más?',
    'No hay de qué, para eso estamos.',
    '¡Un placer ayudarte! ¿Algo más en que pueda asistirte?',
    'Me alegra poder ayudarte. ¿Hay algo más?',
    '¡Genial! Si necesitas algo más, aquí estoy.',
    'Con mucho gusto, no dudes en escribirme si necesitas algo.',
    '¡Con gusto! Para eso estamos aquí.',
    'No te preocupes, es mi trabajo. ¿Necesitas algo más?'
  ],
  despedida: [
    '¡Hasta luego! Que tengas buen día.',
    'Nos vemos, cualquier cosa aquí estoy.',
    '¡Chao! Que te vaya bien.',
    'Hasta pronto, no dudes en escribirme cuando necesites.',
    '¡Adiós! Que tengas excelente día.',
    'Nos vemos, cuídate mucho.',
    '¡Hasta pronto! Estoy aquí cuando me necesites.',
    'Chao, que tengas un buen día.'
  ],
  registro: [
    'Para registrarte necesito tu nombre completo, área (soporte, infraestructura o desarrollo) y cargo.',
    'Claro, para registrarte envíame: nombre, área y cargo en un solo mensaje.',
    'Perfecto, necesito algunos datos: nombre, área y cargo. ¿Me los puedes dar?',
    'Para completar tu registro necesito: nombre completo, área y cargo.',
    'Ok, para registrarte envíame tus datos: nombre, área y cargo.'
  ],
  crear_ticket: [
    'Entiendo, cuéntame más detalles del problema para crear el ticket.',
    'Ok, necesito más información. ¿Puedes describirme mejor qué está pasando?',
    'Para crear el ticket necesito más detalles. ¿Qué problema tienes exactamente?',
    'Claro, pero necesito que me expliques un poco más sobre el problema.',
    'Entendido, ¿puedes darme más contexto sobre lo que necesitas?',
    'Ok, cuéntame más sobre el problema para poder ayudarte mejor.'
  ],
  pedir_area: [
    '¿A qué área corresponde esto: soporte, infraestructura o desarrollo?',
    'Necesito saber el área: ¿es de soporte, infraestructura o desarrollo?',
    'Para clasificar mejor, ¿esto es de soporte, infraestructura o desarrollo?'
  ],
  ticket_creado: [
    'Listo, ya creé tu ticket. Te avisaré cuando haya novedades.',
    'Perfecto, ticket creado. Lo revisaré y te mantendré informado.',
    '¡Hecho! Tu ticket está registrado, te aviso cuando tenga actualización.',
    'Ok, ticket creado. Lo tenemos en seguimiento.'
  ],
  actualizar_ticket: [
    'Listo, agregué esa información al ticket.',
    'Ok, tomé nota y lo agrego al ticket.',
    'Perfecto, actualicé el ticket con lo que me dices.',
    'Entendido, lo agrego al ticket para que lo tengan en cuenta.',
    'Anotado, agrego esa info al ticket.'
  ],
  aclaracion: [
    'Gracias por la aclaración, la agrego al ticket.',
    'Ok, tomo nota de eso para el ticket.',
    'Perfecto, eso ayuda a entender mejor el problema.',
    'Entendido, lo agrego al ticket.',
    'Gracias por el detalle, lo anoto en el ticket.'
  ],
  consulta: [
    'Déjame revisar eso. ¿Puedes darme más detalles?',
    'Hmm, necesito un poco más de contexto. ¿Qué exactamente necesitas saber?',
    'Para ayudarte mejor, ¿puedes explicarme un poco más?',
    'Ok, cuéntame más sobre lo que necesitas.',
    'Entiendo, ¿puedes darme más información sobre eso?'
  ],
  problema: [
    'Entiendo que tienes un problema. ¿Puedes describirme qué está pasando?',
    'Ok, cuéntame más detalles sobre el problema.',
    'Para ayudarte necesito entender mejor qué está ocurriendo. ¿Qué ves?',
    'Entiendo, ¿puedes darme más contexto sobre el problema?',
    'Lamento que tengas ese problema. Cuéntame más detalles para ayudarte.'
  ],
  no_entendido: [
    'No entendí bien. ¿Podrías explicarme qué necesitas?',
    'No logré entender tu mensaje. ¿Puedes reformularlo?',
    'Disculpa, no capté bien. ¿Me puedes decir de otra forma qué necesitas?',
    'Hmm, no entendí. ¿Puedes ser más específico?',
    'No estoy seguro de entender. ¿Qué necesitas exactamente?',
    'Perdón, no entendí bien. ¿Puedes explicarme de otra forma?'
  ],
  seguimiento: [
    'Ah entiendo mejor. ¿Puedes contarme más sobre eso?',
    'Ok, voy entendiendo. Cuéntame más detalles.',
    'Gracias por la información. ¿Hay algo más que deba saber?',
    'Entendido. ¿Cuándo empezó este problema?',
    'Ok, ¿esto afecta a más personas o solo a ti?',
    'Gracias. ¿Has intentado alguna solución antes?'
  ]
};

function getRandomResponse(category) {
  const responses = RESPONSES[category] || RESPONSES.no_entendido;
  return responses[Math.floor(Math.random() * responses.length)];
}

// ============ UTILIDADES ============

function safeArea(value) {
  const area = normalizeText(value || '');
  if (!area) return null;

  if (area.includes('infra')) return 'infraestructura';
  if (area.includes('desarr') || area.includes('software')) return 'desarrollo';
  if (area.includes('soporte') || area.includes('mesa') || area.includes('helpdesk')) return 'soporte';

  if (config.areas.includes(area)) return area;
  return null;
}

function extractJson(text = '') {
  const cleaned = String(text || '').trim();
  try { return JSON.parse(cleaned); } catch {}

  const fence = cleaned.match(/```(?:json)?([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return null;
}

// ============ GEMINI CON RATE LIMIT ============

let lastGeminiCall = 0;
const GEMINI_MIN_INTERVAL = 3000;

async function gemini(prompt, { json = true } = {}) {
  if (!config.geminiApiKey) {
    console.log(`   ⚠️  Gemini: sin API key, usando fallback`);
    return null;
  }

  const now = Date.now();
  const timeSinceLastCall = now - lastGeminiCall;
  if (timeSinceLastCall < GEMINI_MIN_INTERVAL) {
    console.log(`   ⏳ Gemini: esperando ${GEMINI_MIN_INTERVAL - timeSinceLastCall}ms (rate limit)`);
    await new Promise(resolve => setTimeout(resolve, GEMINI_MIN_INTERVAL - timeSinceLastCall));
  }

  lastGeminiCall = Date.now();

  const url = `${API_BASE}/${config.geminiModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.8, maxOutputTokens: 1024 }
  };

  if (json) body.generationConfig.responseMimeType = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    console.log(`   🌐 Gemini: llamando API...`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      console.log(`   ❌ Gemini: error HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';

    if (!text) {
      console.log(`   ❌ Gemini: respuesta vacía`);
      return null;
    }

    console.log(`   ✅ Gemini: respuesta recibida`);
    return json ? extractJson(text) : text;
  } catch (error) {
    console.log(`   ❌ Gemini: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ============ DETECTAR INTENCIÓN AVANZADO ============

function fallbackDetectIntent(text, context = {}) {
  const t = normalizeText(text);
  const ticketId = parseTicketTag(text);

  // Si hay ticket activo y el mensaje es corto, es continuación
  if (context.activeTicket && t.length < 100 && !ticketId) {
    return {
      intencion: 'aclaracion',
      ticket_id: context.activeTicket.id,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: text,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 75,
      info_completa: true
    };
  }

  // Saludos
  if (/^(hola|buenos?\s?(dias|tardes|noches)|hey|hi|que\s?tal|saludos|buenas)\b/.test(t)) {
    return {
      intencion: 'saludo',
      ticket_id: null,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: null,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 90,
      info_completa: false
    };
  }

  // Agradecimientos
  if (/\b(gracias|muchas?\s?gracias|te\s?agradezco|grac|thank)\b/.test(t)) {
    return {
      intencion: 'agradecimiento',
      ticket_id: null,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: null,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 90,
      info_completa: false
    };
  }

  // Despedidas
  if (/\b(adios|chao|hasta\s?(luego|pronto)|nos\s?vemos|bye)\b/.test(t)) {
    return {
      intencion: 'despedida',
      ticket_id: null,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: null,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 90,
      info_completa: false
    };
  }

  // Si hay tag de ticket, es actualización
  if (ticketId) {
    return {
      intencion: 'actualizar_ticket',
      ticket_id: ticketId,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: text,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 85,
      info_completa: true
    };
  }

  // Detectar área
  let area = null;
  if (/(infraestructura|red|internet|wifi|servidor|cable|switch|router|vpn)/.test(t)) {
    area = 'infraestructura';
  } else if (/(desarrollo|software|sistema|bug|api|base\s?de\s?datos|codigo|aplicacion)/.test(t)) {
    area = 'desarrollo';
  } else if (/(soporte|correo|contrasena|acceso|office|excel|word|impresora)/.test(t)) {
    area = 'soporte';
  }

  // Detectar urgencia
  let urgencia = 'media';
  if (/(urgente|critico|caida|produccion|no\s?funciona\s?nada|bloquea|emergencia)/.test(t)) {
    urgencia = 'critica';
  } else if (/(importante|hoy|pronto|afecta|prioridad)/.test(t)) {
    urgencia = 'alta';
  } else if (/(consulta|duda|cuando|como|informacion)/.test(t)) {
    urgencia = 'baja';
  }

  // Problemas/solicitudes → crear ticket
  const problemKeywords = /(no\s?(puedo|funciona|hay|entra)|error|falla|problema|ayuda|solicito|requiero|necesito|caida|sin\s?(acceso|servicio|internet|correo))/;
  
  if (problemKeywords.test(t) && t.length >= 10) {
    return {
      intencion: 'crear_ticket',
      ticket_id: null,
      area,
      urgencia,
      titulo: text.slice(0, 120),
      descripcion: text,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 80,
      info_completa: true,
      falta_area: !area
    };
  }

  // Datos de registro
  if (/(soy|me\s?llamo|mi\s?nombre|trabajo\s?en|cargo|analista|tecnico|ingeniero|desarrollador)/.test(t)) {
    return {
      intencion: 'registro',
      ticket_id: null,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: null,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 65,
      info_completa: false
    };
  }

  // Preguntas sobre detalles/información
  if (/(que\s?(detalles|informacion|necesitas|quieres|puedo)|cuentame|explicame|describe)/.test(t)) {
    return {
      intencion: 'consulta',
      ticket_id: null,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: text,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 60,
      info_completa: false
    };
  }

  // Mensaje muy corto sin patrón claro
  if (t.length < 30) {
    return {
      intencion: 'consulta',
      ticket_id: null,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: text,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 40,
      info_completa: false
    };
  }

  return {
    intencion: 'otro',
    ticket_id: null,
    area: null,
    urgencia: null,
    titulo: null,
    descripcion: text,
    datos_registro: { nombre: null, area: null, cargo: null },
    confianza: 20,
    info_completa: false
  };
}

async function detectIntent(text, { employee, activeTicket, history = [] }) {
  const quickFallback = fallbackDetectIntent(text, { activeTicket });
  
  if (quickFallback.confianza >= 70) {
    console.log(`   ✅ Fallback confiable (${quickFallback.confianza}%), sin IA`);
    return quickFallback;
  }

  const historyText = history
    .slice(-6)
    .map((m) => `${m.from === 'bot' ? 'Bot' : 'Usuario'}: ${m.text}`)
    .join('\n');

  const prompt = `
Eres el clasificador de intención de un bot de WhatsApp corporativo de CONATEL.
Analiza el mensaje del usuario y devuelve SOLO JSON válido.

Contexto:
- Usuario registrado: ${employee ? JSON.stringify(employee) : 'NO'}
- Ticket activo: ${activeTicket ? `#${activeTicket.id} (${activeTicket.area}, estado: ${activeTicket.status})` : 'NO'}
- Historial reciente:
${historyText || '(sin historial)'}

Mensaje del usuario: ${JSON.stringify(text)}

Devuelve este JSON:
{
  "intencion": "saludo|registro|crear_ticket|actualizar_ticket|consulta|agradecimiento|despedida|aclaracion|otro",
  "ticket_id": null,
  "area": "soporte|infraestructura|desarrollo|null",
  "urgencia": "baja|media|alta|critica|null",
  "titulo": "string|null",
  "descripcion": "string|null",
  "datos_registro": { "nombre": null, "area": null, "cargo": null },
  "confianza": 0,
  "info_completa": true
}

Reglas:
1. Si el usuario saluda, intencion = saludo
2. Si dice gracias, intencion = agradecimiento
3. Si dice adios/chao, intencion = despedida
4. Si menciona #T-123, intencion = actualizar_ticket
5. Si hay ticket activo y el mensaje es corto, intencion = aclaracion
6. Si describe un problema, intencion = crear_ticket y info_completa = true
7. Si da sus datos, intencion = registro
8. Si pregunta algo, intencion = consulta
9. area: soporte, infraestructura, desarrollo
10. urgencia: critica, alta, media, baja
11. confianza: 0-100
12. info_completa: true si hay suficiente información para crear ticket, false si falta algo
`.trim();

  const ai = await gemini(prompt, { json: true });

  if (!ai) {
    console.log(`   🔄 Usando fallback sin IA`);
    return quickFallback;
  }

  const merged = { ...quickFallback, ...ai };

  const aiConfidence = Number(ai.confianza) || 0;
  const fallbackConfidence = quickFallback.confianza;

  if (aiConfidence < 50 && fallbackConfidence > 60) {
    console.log(`   🔄 IA poco confiable (${aiConfidence}%), usando fallback (${fallbackConfidence}%)`);
    return quickFallback;
  }

  if (!merged.ticket_id) merged.ticket_id = parseTicketTag(text);
  if (merged.ticket_id && typeof merged.ticket_id === 'string') {
    merged.ticket_id = Number(merged.ticket_id.replace(/\D/g, '')) || null;
  }

  merged.area = safeArea(merged.area);
  merged.confianza = Number(merged.confianza) || 0;

  return merged;
}

// ============ GENERAR RESPUESTA CON CONTEXTO ============

async function generateResponse({ intent, employee, activeTicket, userMessage, context = {}, history = [] }) {
  const quickResponse = fallbackResponse(intent, employee, activeTicket, userMessage, history);
  
  if (['saludo', 'agradecimiento', 'despedida', 'actualizar_ticket', 'aclaracion'].includes(intent.intencion)) {
    console.log(`   ✅ Respuesta rápida sin IA`);
    return quickResponse;
  }

  const prompt = `
Eres un asistente humano de CONATEL por WhatsApp. Respondes de forma natural, amable y profesional.

Situación actual:
- Mensaje del usuario: ${JSON.stringify(userMessage)}
- Intención detectada: ${intent.intencion}
- Usuario registrado: ${employee ? `${employee.name}, área ${employee.area}, cargo ${employee.role}` : 'NO registrado aún'}
- Ticket activo: ${activeTicket ? `#${activeTicket.id} - ${activeTicket.title} (${activeTicket.area}, ${activeTicket.status})` : 'ninguno'}
- Área detectada: ${intent.area || 'no definida'}
- Urgencia detectada: ${intent.urgencia || 'no definida'}

Reglas:
1. SALUDO: Saluda de forma variada
2. REGISTRO: Pide los datos faltantes
3. CREAR_TICKET: Si falta área, pregunta solo por el área. Si falta descripción, pide descripción. Si todo está, confirma creación
4. ACTUALIZAR_TICKET: Confirma que agregaste la información
5. CONSULTA: Pide más contexto o responde
6. AGRADECIMIENTO: Responde de forma variada
7. DESPEDIDA: Despídete de forma variada
8. OTRO: Pide aclaración

NO uses emojis excesivos. Sé breve (máximo 2-3 líneas). Sin markdown.
`.trim();

  const response = await gemini(prompt, { json: false });

  if (response && typeof response === 'string') {
    return response.trim().replace(/^["']|["']$/g, '');
  }

  return quickResponse;
}

function fallbackResponse(intent, employee, activeTicket, userMessage, history = []) {
  const t = normalizeText(userMessage || '');

  if (history.length > 0 && t.length < 50 && intent.intencion === 'consulta') {
    return getRandomResponse('seguimiento');
  }

  switch (intent.intencion) {
    case 'saludo':
      return getRandomResponse('saludo');
    case 'agradecimiento':
      return getRandomResponse('agradecimiento');
    case 'despedida':
      return getRandomResponse('despedida');
    case 'registro':
      return getRandomResponse('registro');
    case 'crear_ticket':
      if (intent.falta_area) {
        return getRandomResponse('pedir_area');
      }
      if (intent.area) {
        return `Entiendo, es un tema de ${intent.area}. Voy a crear el ticket.`;
      }
      return getRandomResponse('crear_ticket');
    case 'actualizar_ticket':
      return getRandomResponse('actualizar_ticket');
    case 'aclaracion':
      return getRandomResponse('aclaracion');
    case 'consulta':
      return getRandomResponse('consulta');
    default:
      if (/\?/.test(userMessage)) {
        return getRandomResponse('consulta');
      }
      if (/(no|error|falla|problema)/.test(t)) {
        return getRandomResponse('problema');
      }
      return getRandomResponse('no_entendido');
  }
}

async function extractRegistration(text) {
  const prompt = `
Extrae datos de registro de empleado para CONATEL.
Devuelve SOLO JSON válido.

Esquema:
{
  "nombre": "string|null",
  "area": "soporte|infraestructura|desarrollo|null",
  "cargo": "string|null"
}

Texto: ${JSON.stringify(String(text))}
`.trim();

  const ai = await gemini(prompt, { json: true });

  if (!ai) {
    const t = normalizeText(text);
    const area = safeArea(t);
    return { nombre: null, area, cargo: null };
  }

  return {
    nombre: ai?.nombre || null,
    area: safeArea(ai?.area),
    cargo: ai?.cargo || null
  };
}

module.exports = {
  detectIntent,
  generateResponse,
  extractRegistration,
  safeArea
};