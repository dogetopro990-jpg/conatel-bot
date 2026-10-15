const config = require('./config');
const { normalizeText, parseTicketTag } = require('./utils');

const API_BASE = 'https://generativelanguage.googleapis.com/v1/models';

const cache = new Map();
const CACHE_TTL = 120000;

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value) {
  cache.set(key, { value, timestamp: Date.now() });
}

// ============ RESPUESTAS VARIADAS ============

const RESPONSES = {
  saludo: [
    '¡Hola! Soy el asistente de CONATEL. ¿Con quién tengo el gusto de hablar?',
    'Hola, ¿cómo estás? ¿Me puedes decir tu nombre?',
    '¡Buenas! ¿Con quién hablo?',
    'Hola, bienvenido a CONATEL. ¿Me puedes decir tu nombre completo?'
  ],
  pedir_area: [
    '¿En qué área trabajas: soporte, infraestructura o desarrollo?',
    '¿A qué área perteneces?'
  ],
  pedir_cargo: [
    '¿Cuál es tu cargo o puesto?',
    '¿Qué cargo tienes en la empresa?'
  ],
  transicion_a_solicitud: [
    'Bien {nombre}, ¿qué necesitas?',
    'Perfecto {nombre}, ¿en qué te ayudo?',
    'Listo {nombre}, cuéntame.',
    'Ok {nombre}, ¿qué problema tienes?',
    'Muy bien, ¿cómo te puedo ayudar?',
    'Perfecto, ¿qué necesitas?',
    'Listo, cuéntame qué necesitas.',
    'Ok, ¿en qué te puedo ayudar?'
  ],
  agradecimiento: [
    '¡Con gusto! ¿Necesitas algo más?',
    'No hay de qué, para eso estamos.',
    '¡Un placer ayudarte!'
  ],
  despedida: [
    '¡Hasta luego! Que tengas buen día.',
    'Nos vemos, cualquier cosa aquí estoy.',
    '¡Chao! Que te vaya bien.'
  ],
  problema_detectado: [
    'Entiendo, es una molestia. Lo voy a revisar y te aviso.',
    'Entendido, vemos qué podemos hacer. Te mantengo informado.',
    'Ok, lo estoy revisando. Te aviso apenas tenga novedades.',
    'Comprendo, es un problema. Ya lo estamos viendo.',
    'Entendido, lo voy a revisar y te aviso.',
    'Ok, ya lo tengo registrado. Te aviso cuando tenga novedades.',
    'Perfecto, lo estamos viendo. Te mantengo informado.',
    'Listo, ya lo anoté. Te aviso apenas tenga respuesta.',
    'Entendido, lo revisamos y te contamos.',
    'Ok, ya está registrado. Te aviso cuando haya avances.',
    'Perfecto, lo tenemos en seguimiento.',
    'Listo, ya lo estamos viendo. Te aviso pronto.'
  ],
  seguimiento: [
    'Entiendo. ¿Cuándo empezó este problema?',
    'Ok, ¿esto afecta a más personas o solo a ti?',
    '¿Has intentado alguna solución antes?'
  ],
  no_entendido: [
    'No entendí bien. ¿Podrías explicarme qué necesitas?',
    'Disculpa, no capté bien. ¿Me puedes decir de otra forma?',
    'Hmm, no entendí. ¿Puedes ser más específico?'
  ]
};

function getRandomResponse(category, replacements = {}) {
  const responses = RESPONSES[category] || RESPONSES.no_entendido;
  let response = responses[Math.floor(Math.random() * responses.length)];
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
  if (area.includes('desarr') || area.includes('software') || area.includes('dev')) return 'desarrollo';
  if (area.includes('soporte') || area.includes('mesa') || area.includes('helpdesk') || area.includes('ti')) return 'soporte';
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

let lastGeminiCall = 0;
const GEMINI_MIN_INTERVAL = 3000;

async function gemini(prompt, { json = true } = {}) {
  const cacheKey = `${prompt.substring(0, 150)}_${json}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`   📦 Gemini: desde caché`);
    return cached;
  }

  if (!config.geminiApiKey) {
    console.log(`   ⚠️  Gemini: sin API key`);
    return null;
  }

  const now = Date.now();
  const timeSinceLastCall = now - lastGeminiCall;
  if (timeSinceLastCall < GEMINI_MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, GEMINI_MIN_INTERVAL - timeSinceLastCall));
  }
  lastGeminiCall = Date.now();

  const url = `${API_BASE}/${config.geminiModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
  console.log(`   🔗 Gemini: ${config.geminiModel}`);

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
  };
  if (json) body.generationConfig.responseMimeType = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      console.log(`   ❌ Gemini: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';

    if (!text) {
      console.log(`   ❌ Gemini: respuesta vacía`);
      return null;
    }

    console.log(`   ✅ Gemini: OK`);
    const result = json ? extractJson(text) : text;
    setCache(cacheKey, result);
    return result;
  } catch (error) {
    console.log(`   ❌ Gemini: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ============ UTILIDADES LOCALES ============

function detectUrgencyFromText(text) {
  const t = normalizeText(text);
  if (/(no\s?funciona|caida|sin\s?(servicio|internet|acceso)|emergencia|urgente|bloquea|no\s?puedo\s?trabajar|produccion)/i.test(t)) return 'critica';
  if (/(importante|hoy|pronto|afecta|no\s?puedo|error|falla|problema|lento|molestia|molesto)/i.test(t)) return 'alta';
  if (/(consulta|duda|cuando|como|informacion|pregunta)/i.test(t)) return 'baja';
  return 'media';
}

function extractNameLocal(text) {
  const t = text.trim();
  const patterns = [
    /(?:soy|me\s?llamo|mi\s?nombre\s?es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/i,
    /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,3})/i,
    /hola[,.\s]+soy\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/i
  ];
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      const common = /^(hola|buenos|buenas|gracias|ok|si|no|que|como|cuando|por|para|con|sin|de|del|la|el|los|las|un|una|es|esta)/i;
      if (name.length > 2 && !common.test(name)) return name;
    }
  }
  return null;
}

function extractCargoLocal(text) {
  const patterns = [
    /(?:como|cargo|puesto|rol)\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)/i,
    /\b(analista|técnico|tecnico|ingeniero|desarrollador|administrador|gerente|coordinador|supervisor|asistente|consultor|director|jefe)\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1] || match[0];
  }
  return null;
}

async function extractRegistrationData(text) {
  console.log(`   🔍 Extrayendo datos...`);
  let nombre = extractNameLocal(text);
  let area = safeArea(text);
  let cargo = extractCargoLocal(text);

  if (!nombre || !area) {
    const prompt = `Extrae del mensaje: {"nombre":"string","area":"soporte|infraestructura|desarrollo","cargo":"string"}. Solo JSON. Mensaje: "${text}"`;
    const ai = await gemini(prompt, { json: true });
    if (ai) {
      nombre = ai.nombre || nombre;
      area = safeArea(ai.area) || area;
      cargo = ai.cargo || cargo;
    }
  }

  console.log(`   📊 nombre="${nombre}", area="${area}", cargo="${cargo}"`);
  return { nombre, area, cargo };
}

// ============ DETECTAR INTENCIÓN ============

function fallbackDetectIntent(text, context = {}) {
  const t = normalizeText(text);
  const ticketId = parseTicketTag(text);

  if (context.activeTicket && t.length < 100 && !ticketId) {
    return { intencion: 'aclaracion', ticket_id: context.activeTicket.id, area: null, urgencia: null, descripcion: text, confianza: 75 };
  }

  if (/^(hola|buenos?\s?(dias|tardes|noches)|hey|hi|que\s?tal|saludos|buenas)\b/.test(t)) {
    return { intencion: 'saludo', confianza: 95 };
  }

  if (/\b(gracias|muchas?\s?gracias|te\s?agradezco|thank)\b/.test(t)) {
    return { intencion: 'agradecimiento', confianza: 90 };
  }

  if (/\b(adios|chao|hasta\s?(luego|pronto)|nos\s?vemos|bye)\b/.test(t)) {
    return { intencion: 'despedida', confianza: 90 };
  }

  if (ticketId) {
    return { intencion: 'actualizar_ticket', ticket_id: ticketId, urgencia: detectUrgencyFromText(text), descripcion: text, confianza: 85 };
  }

  let area = null;
  if (/(infraestructura|red|internet|wifi|servidor|cable|switch|router|vpn)/.test(t)) area = 'infraestructura';
  else if (/(desarrollo|software|sistema|bug|api|base\s?de\s?datos|codigo|aplicacion)/.test(t)) area = 'desarrollo';
  else if (/(soporte|correo|contrasena|acceso|office|excel|word|impresora)/.test(t)) area = 'soporte';

  const urgencia = detectUrgencyFromText(text);

  const problemKeywords = /(no\s?(puedo|funciona|hay|entra|sirve|anda)|error|falla|problema|ayuda|solicito|requiero|necesito|caida|sin\s?(acceso|servicio|internet|correo)|computadora|pc|equipo|molestia|molesto|lento|demora|no\s?me\s?deja|no\s?puedo\s?acceder|no\s?carga|no\s?conecta)/i;
  
  if (problemKeywords.test(t) && t.length >= 8) {
    console.log(`   🎯 Problema detectado: ${t.substring(0, 50)}...`);
    return { 
      intencion: 'crear_ticket', 
      area, 
      urgencia, 
      titulo: text.slice(0, 120), 
      descripcion: text, 
      confianza: 85,
      es_problema: true
    };
  }

  if (t.length < 30) {
    return { intencion: 'consulta', descripcion: text, confianza: 40 };
  }

  return { intencion: 'otro', descripcion: text, confianza: 20 };
}

async function detectIntent(text, { employee, activeTicket, history = [] }) {
  const fallback = fallbackDetectIntent(text, { activeTicket });

  if (fallback.confianza >= 80) {
    console.log(`   ✅ Fallback (${fallback.confianza}%)`);
    return fallback;
  }

  console.log(`   🤖 Usando Gemini...`);
  const historyText = history.slice(-4).map(m => `${m.from === 'bot' ? 'Bot' : 'Usuario'}: ${m.text}`).join(' | ');

  const prompt = `Clasifica el mensaje en un chat de soporte CONATEL.
Contexto: ${historyText || '(inicio)'}
Mensaje: "${text}"
Usuario: ${employee ? employee.name : 'no'}
Ticket activo: ${activeTicket ? '#' + activeTicket.id : 'no'}

Devuelve JSON:
{"intencion":"saludo|crear_ticket|actualizar_ticket|consulta|agradecimiento|despedida|aclaracion|otro","area":"soporte|infraestructura|desarrollo|null","urgencia":"baja|media|alta|critica|null","titulo":"string|null","descripcion":"string|null","confianza":0,"es_problema":false}`;

  const ai = await gemini(prompt, { json: true });

  if (!ai) {
    console.log(`   🔄 Fallback`);
    return fallback;
  }

  const merged = { ...fallback, ...ai };
  merged.area = safeArea(merged.area) || fallback.area;
  merged.urgencia = merged.urgencia || detectUrgencyFromText(text);
  merged.confianza = Number(merged.confianza) || fallback.confianza;

  return merged;
}

// ============ GENERAR RESPUESTA ============

async function generateResponse({ intent, employee, activeTicket, userMessage, context = {}, history = [] }) {
  if (['saludo', 'agradecimiento', 'despedida'].includes(intent.intencion)) {
    return getRandomResponse(intent.intencion);
  }

  if (intent.intencion === 'crear_ticket' && intent.es_problema) {
    return getRandomResponse('problema_detectado');
  }

  const historyText = history.slice(-6).map(m => `${m.from === 'bot' ? 'Bot' : 'Usuario'}: ${m.text}`).join('\n');

  const prompt = `Eres un asistente de CONATEL. Responde natural, breve (1-2 líneas), sin emojis excesivos.

Historial:
${historyText || '(inicio)'}

Mensaje: "${userMessage}"
Intención: ${intent.intencion}
Usuario: ${employee ? employee.name : 'no registrado'}
Ticket: ${activeTicket ? '#' + activeTicket.id : 'ninguno'}

Responde como persona real. Sin markdown.`;

  const response = await gemini(prompt, { json: false });

  if (response && typeof response === 'string') {
    return response.trim().replace(/^["']|["']$/g, '');
  }

  switch (intent.intencion) {
    case 'crear_ticket':
      return getRandomResponse('problema_detectado');
    case 'actualizar_ticket':
    case 'aclaracion':
      return 'Listo, tomé nota y lo agrego al ticket.';
    case 'consulta':
      return '¿Puedes darme más detalles?';
    default:
      return getRandomResponse('no_entendido');
  }
}

module.exports = {
  detectIntent,
  generateResponse,
  extractRegistrationData,
  safeArea,
  detectUrgencyFromText,
  getRandomResponse
};