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

// ============ GEMINI ============

async function gemini(prompt, { json = true } = {}) {
  if (!config.geminiApiKey) {
    console.log(`   ⚠️  Gemini: sin API key, usando fallback`);
    return null;
  }

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

// ============ DETECTAR INTENCIÓN ============

function fallbackDetectIntent(text) {
  const t = normalizeText(text);
  const ticketId = parseTicketTag(text);

  // Saludos
  if (/^(hola|buenos\s?(dias|tardes|noches)|hey|hi|que\s?tal|saludos|buenas)\b/.test(t)) {
    return {
      intencion: 'saludo',
      ticket_id: null,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: null,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 90
    };
  }

  // Agradecimientos
  if (/\b(gracias|muchas\s?gracias|te\s?agradezco|grac|thank)\b/.test(t)) {
    return {
      intencion: 'agradecimiento',
      ticket_id: null,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: null,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 90
    };
  }

  // Despedidas
  if (/\b(adios|chao|hasta\s?luego|nos\s?vemos|bye|hasta\s?pronto)\b/.test(t)) {
    return {
      intencion: 'despedida',
      ticket_id: null,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: null,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 90
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
      descripcion: t,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 85
    };
  }

  // Problemas/solicitudes → crear ticket
  const problemKeywords = /(no\s?(puedo|funciona|hay|entra)|error|falla|problema|ayuda|solicito|requiero|necesito|caida|sin\s?(acceso|servicio|internet|correo))/;
  if (problemKeywords.test(t) && t.length >= 10) {
    let area = 'soporte';
    let urgencia = 'media';

    if (/(infraestructura|red|internet|wifi|servidor|cable|switch|router|vpn)/.test(t)) {
      area = 'infraestructura';
    } else if (/(desarrollo|software|sistema|bug|api|base\s?de\s?datos|codigo|aplicacion)/.test(t)) {
      area = 'desarrollo';
    }

    if (/(urgente|critico|caida|produccion|no\s?funciona\s?nada|bloquea)/.test(t)) {
      urgencia = 'critica';
    } else if (/(importante|hoy|pronto|afecta)/.test(t)) {
      urgencia = 'alta';
    } else if (/(consulta|duda|cuando|como)/.test(t)) {
      urgencia = 'baja';
    }

    return {
      intencion: 'crear_ticket',
      ticket_id: null,
      area,
      urgencia,
      titulo: text.slice(0, 120),
      descripcion: text,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 70
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
      confianza: 65
    };
  }

  // Mensaje muy corto sin patrón claro → probablemente saludo o consulta
  if (t.length < 20) {
    return {
      intencion: 'consulta',
      ticket_id: null,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: text,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 40
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
    confianza: 20
  };
}

async function detectIntent(text, { employee, activeTicket, history = [] }) {
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
  "confianza": 0
}

Reglas:
1. Si el usuario saluda (hola, buenos dias, hey), intencion = saludo
2. Si dice gracias, intencion = agradecimiento
3. Si dice adios/chao, intencion = despedida
4. Si menciona #T-123, intencion = actualizar_ticket y ticket_id = 123
5. Si hay ticket activo y el mensaje es corto o parece continuación, intencion = aclaracion o actualizar_ticket
6. Si describe un problema/solicitud nueva, intencion = crear_ticket
7. Si da sus datos (nombre, area, cargo), intencion = registro
8. Si pregunta algo general, intencion = consulta
9. area: soporte (correos, accesos, office), infraestructura (red, servidores, internet), desarrollo (software, bugs, sistemas)
10. urgencia: critica (caída total, producción), alta (afecta operación), media (normal), baja (consulta)
11. confianza: 0-100 según qué tan claro es el mensaje
`.trim();

  const ai = await gemini(prompt, { json: true });

  // Si Gemini falla, usar fallback robusto
  if (!ai) {
    console.log(`   🔄 Usando fallback sin IA`);
    return fallbackDetectIntent(text);
  }

  const fallback = fallbackDetectIntent(text);
  const merged = { ...fallback, ...ai };

  // Priorizar IA si tiene alta confianza, sino usar fallback
  const aiConfidence = Number(ai.confianza) || 0;
  const fallbackConfidence = fallback.confianza;

  if (aiConfidence < 50 && fallbackConfidence > 60) {
    console.log(`   🔄 IA poco confiable (${aiConfidence}%), usando fallback (${fallbackConfidence}%)`);
    return fallback;
  }

  if (!merged.ticket_id) merged.ticket_id = parseTicketTag(text);
  if (merged.ticket_id && typeof merged.ticket_id === 'string') {
    merged.ticket_id = Number(merged.ticket_id.replace(/\D/g, '')) || null;
  }

  merged.area = safeArea(merged.area);
  merged.confianza = Number(merged.confianza) || 0;

  return merged;
}

// ============ GENERAR RESPUESTA ============

async function generateResponse({ intent, employee, activeTicket, userMessage, context = {} }) {
  const prompt = `
Eres un asistente humano de CONATEL por WhatsApp. Respondes de forma natural, amable y profesional.

IMPORTANTE: Varía tus respuestas. NO uses siempre las mismas frases. Sé creativo y natural.

Situación actual:
- Mensaje del usuario: ${JSON.stringify(userMessage)}
- Intención detectada: ${intent.intencion}
- Usuario registrado: ${employee ? `${employee.name}, área ${employee.area}, cargo ${employee.role}` : 'NO registrado aún'}
- Ticket activo: ${activeTicket ? `#${activeTicket.id} - ${activeTicket.title} (${activeTicket.area}, ${activeTicket.status})` : 'ninguno'}
- Área detectada: ${intent.area || 'no definida'}
- Urgencia detectada: ${intent.urgencia || 'no definida'}

Reglas:
1. SALUDO: Saluda de forma variada y pregunta cómo puedes ayudar. Ejemplos: "¡Hola! ¿En qué te ayudo?", "Buenas, ¿qué necesitas?", "Hola, cuéntame qué puedo hacer por ti"
2. REGISTRO: Pide los datos faltantes de forma amable
3. CREAR_TICKET: Pide más detalles del problema
4. ACTUALIZAR_TICKET: Confirma que agregaste la información
5. CONSULTA: Pide más contexto
6. AGRADECIMIENTO: Responde de forma variada: "Con gusto", "No hay de qué", "Un placer ayudarte"
7. DESPEDIDA: Despídete de forma variada: "Hasta luego", "Nos vemos", "Chao, cuídate"
8. OTRO: Pide aclaración de forma amable

NO uses emojis excesivos. NO suenes robótico. Sé breve (máximo 2-3 líneas). Sin markdown.
Responde de forma DIFERENTE cada vez, no repitas las mismas frases.
`.trim();

  const response = await gemini(prompt, { json: false });

  if (response && typeof response === 'string') {
    return response.trim().replace(/^["']|["']$/g, '');
  }

  return fallbackResponse(intent, employee, activeTicket, userMessage);
}

function fallbackResponse(intent, employee, activeTicket, userMessage) {
  const t = normalizeText(userMessage || '');

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
      if (intent.area) {
        return `Entiendo, es un tema de ${intent.area}. ${getRandomResponse('crear_ticket')}`;
      }
      return getRandomResponse('crear_ticket');
    case 'actualizar_ticket':
      return getRandomResponse('actualizar_ticket');
    case 'aclaracion':
      return getRandomResponse('aclaracion');
    case 'consulta':
      return getRandomResponse('consulta');
    default:
      // Respuestas inteligentes por contenido
      if (/\?/.test(userMessage)) {
        return getRandomResponse('consulta');
      }
      if (/(no|error|falla|problema)/.test(t)) {
        return getRandomResponse('problema');
      }
      return getRandomResponse('no_entendido');
  }
}

// ============ EXTRAER REGISTRO ============

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
    // Fallback simple
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