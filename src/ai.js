const config = require('./config');
const { normalizeText, parseTicketTag } = require('./utils');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ============ RESPUESTAS VARIADAS ============

const RESPONSES = {
  saludo: [
    '¡Hola! Soy el asistente de CONATEL. ¿Con quién tengo el gusto de hablar?',
    'Hola, ¿cómo estás? ¿Me puedes decir tu nombre?',
    '¡Buenas! ¿Con quién hablo?',
    'Hola, bienvenido a CONATEL. ¿Me puedes decir tu nombre completo?',
    '¡Hey! Soy tu asistente de CONATEL. ¿Cómo te llamas?',
    'Buenos días, ¿con quién tengo el placer de hablar?',
    'Hola, ¿me puedes decir tu nombre para ayudarte mejor?',
    '¡Hola! ¿Con quién hablo hoy?',
    'Buenas, ¿me puedes decir tu nombre?'
  ],
  pedir_area: [
    '¿En qué área trabajas: soporte, infraestructura o desarrollo?',
    '¿A qué área perteneces: soporte, infraestructura o desarrollo?',
    'Para ayudarte mejor, ¿me puedes decir tu área: soporte, infraestructura o desarrollo?'
  ],
  pedir_cargo: [
    '¿Cuál es tu cargo o puesto?',
    '¿Qué cargo tienes en la empresa?',
    '¿Me puedes decir tu cargo?'
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
  transicion_a_solicitud: [
    'Bien {nombre}, ahora dime, ¿qué necesitas?',
    'Perfecto {nombre}, ¿en qué te puedo ayudar hoy?',
    'Listo {nombre}, cuéntame, ¿qué problema tienes?',
    'Ok {nombre}, ¿qué necesitas que te ayude a resolver?',
    'Muy bien {nombre}, ¿cómo te puedo ayudar?'
  ],
  crear_ticket: [
    'Entiendo, voy a crear el ticket.',
    'Ok, voy a registrar esto como un ticket.',
    'Entendido, voy a crear el ticket para esto.'
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

function getRandomResponse(category, replacements = {}) {
  const responses = RESPONSES[category] || RESPONSES.no_entendido;
  let response = responses[Math.floor(Math.random() * responses.length)];
  
  // Reemplazar placeholders
  Object.keys(replacements).forEach(key => {
    response = response.replace(`{${key}}`, replacements[key]);
  });
  
  return response;
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

// ============ DETECTAR URGENCIA AUTOMÁTICA ============

function detectUrgencyFromText(text) {
  const t = normalizeText(text);
  
  // Crítica: problemas que bloquean operaciones completas
  if (/(no\s?funciona|caida|sin\s?(servicio|internet|acceso|luz)|emergencia|critico|urgente|bloquea|no\s?puedo\s?trabajar|produccion|todo\s?el\s?(area|departamento|edificio))/i.test(t)) {
    return 'critica';
  }
  
  // Alta: problemas importantes pero no bloqueantes totales
  if (/(importante|hoy|pronto|afecta|prioridad|no\s?puedo|error|falla|problema|lento|demora)/i.test(t)) {
    return 'alta';
  }
  
  // Baja: consultas o problemas menores
  if (/(consulta|duda|cuando|como|informacion|pregunta|saber|puedes\s?decirme)/i.test(t)) {
    return 'baja';
  }
  
  // Media: por defecto
  return 'media';
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

  // Saludos - pedir nombre
  if (/^(hola|buenos?\s?(dias|tardes|noches)|hey|hi|que\s?tal|saludos|buenas)\b/.test(t)) {
    return {
      intencion: 'saludo',
      ticket_id: null,
      area: null,
      urgencia: null,
      titulo: null,
      descripcion: null,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 95,
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
      urgencia: detectUrgencyFromText(text),
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

  // Detectar urgencia automáticamente
  const urgencia = detectUrgencyFromText(text);

  // Problemas/solicitudes → crear ticket
  const problemKeywords = /(no\s?(puedo|funciona|hay|entra)|error|falla|problema|ayuda|solicito|requiero|necesito|caida|sin\s?(acceso|servicio|internet|correo)|computadora|pc|equipo)/;
  
  if (problemKeywords.test(t) && t.length >= 10) {
    return {
      intencion: 'crear_ticket',
      ticket_id: null,
      area,
      urgencia,
      titulo: text.slice(0, 120),
      descripcion: text,
      datos_registro: { nombre: null, area: null, cargo: null },
      confianza: 85,
      info_completa: true,
      falta_area: !area
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
7. DETECTA URGENCIA AUTOMÁTICAMENTE del contexto:
   - critica: si dice "no funciona", "caída", "emergencia", "urgente", "bloquea", "no puedo trabajar"
   - alta: si dice "importante", "hoy", "afecta", "error", "falla", "problema"
   - baja: si es consulta o pregunta
   - media: por defecto
8. area: soporte, infraestructura, desarrollo
9. confianza: 0-100
10. info_completa: true si hay suficiente información para crear ticket
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

  // Si no detectó urgencia, usar detección automática
  if (!merged.urgencia || merged.urgencia === 'null') {
    merged.urgencia = detectUrgencyFromText(text);
  }

  return merged;
}

// ============ GENERAR RESPUESTA CON CONTEXTO ============

async function generateResponse({ intent, employee, activeTicket, userMessage, context = {}, history = [] }) {
  const quickResponse = fallbackResponse(intent, employee, activeTicket, userMessage, history);
  
  if (['saludo', 'agradecimiento', 'despedida', 'actualizar_ticket', 'aclaracion'].includes(intent.intencion)) {
    console.log(`   ✅ Respuesta rápida sin IA`);
    return quickResponse;
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
    case 'crear_ticket':
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
  safeArea,
  detectUrgencyFromText,
  getRandomResponse
};