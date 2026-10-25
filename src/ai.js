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

let customMessages = null;

function setCustomMessages(messages) {
  customMessages = messages;
}

function getMessages(category, fallback) {
  if (customMessages && customMessages[category] && customMessages[category].length > 0) {
    return customMessages[category];
  }
  return fallback;
}

const RESPONSES = {
  saludo: [
    '¡Hola! Soy el asistente de CONATEL. ¿Con quién tengo el gusto de hablar?',
    'Hola, ¿cómo estás? ¿Me puedes decir tu nombre?',
    '¡Buenas! ¿Con quién hablo?',
    'Hola, bienvenido a CONATEL. ¿Me puedes decir tu nombre completo?'
  ],
  saludo_registrado: [
    '¡Hola {nombre}! ¿En qué te puedo ayudar?',
    'Hola {nombre}, ¿cómo estás? ¿Qué necesitas?',
    '¡Buenas {nombre}! Cuéntame, ¿en qué te ayudo?',
    'Hola {nombre}, ¿qué tal? ¿En qué puedo ayudarte?',
    '¡Hey {nombre}! ¿Qué necesitas hoy?',
    'Hola {nombre}, aquí estoy. ¿En qué te colaboro?',
    '¡Buenas! ¿Cómo te va {nombre}? ¿Qué necesitas?',
    'Hola {nombre}, dime en qué te puedo ayudar.'
  ],
  pedir_area: [
    'Perfecto {nombre}, ¿en qué área trabajas?',
    'Genial {nombre}, ¿a qué área perteneces?',
    'Ok {nombre}, ¿cuál es tu área de trabajo?',
    'Entendido {nombre}, ¿en qué área estás?'
  ],
  pedir_cargo: [
    '¿Cuál es tu cargo o puesto?',
    '¿Qué cargo tienes en la empresa?',
    '¿Me puedes decir tu cargo?'
  ],
  pedir_ubicacion: [
    '¿En qué lugar específico es el problema?',
    '¿Me puedes decir la ubicación exacta?',
    '¿Dónde exactamente ocurre el problema?',
    '¿En qué oficina o área es?'
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
  multi_ticket_ambiguo: [
    'Tienes más de un ticket activo. ¿Te refieres al "{ticket1}" o al "{ticket2}"?',
    'Para actualizar el correcto, ¿hablas del problema de "{ticket1}" o del de "{ticket2}"?'
  ],
  no_entendido: [
    'No entendí bien. ¿Podrías explicarme qué necesitas?',
    'Disculpa, no capté bien. ¿Me puedes decir de otra forma?',
    'Hmm, no entendí. ¿Puedes ser más específico?'
  ]
};

function getRandomResponse(category, replacements = {}) {
  const responses = getMessages(category, RESPONSES[category]) || RESPONSES.no_entendido;
  let response = responses[Math.floor(Math.random() * responses.length)];
  
  Object.keys(replacements).forEach(key => {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    response = response.replace(regex, replacements[key] || '');
  });
  
  return response;
}

function safeArea(value) {
  if (!value) return null;
  const area = normalizeText(value || '');
  if (!area) return null;
  
  for (const configuredArea of config.areas) {
    const normalizedConfig = normalizeText(configuredArea);
    if (area === normalizedConfig || area.includes(normalizedConfig) || normalizedConfig.includes(area)) {
      return configuredArea;
    }
  }
  
  if (area.includes('infra')) return config.areas.find(a => a.toLowerCase().includes('comunicacion')) || 'Comunicaciones';
  if (area.includes('desarr') || area.includes('software') || area.includes('sistema')) return 'DISET';
  if (area.includes('soporte') || area.includes('mesa') || area.includes('helpdesk')) return 'DISET';
  if (area.includes('gerencia')) return 'Gerencia General';
  if (area.includes('compra')) return 'Compras';
  if (area.includes('contab')) return 'Contabilidad';
  if (area.includes('legal') || area.includes('juridic')) return 'LEGAL';
  if (area.includes('secret')) return 'SECRETARIA';
  if (area.includes('cartera') || area.includes('cobranza')) return 'Cartera y cobranza';
  if (area.includes('bien')) return 'Bienes';
  if (area.includes('servicio')) return 'Servicios Generales';
  if (area.includes('proteccion') || area.includes('usuario')) return 'Proteccion al usuario';
  
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

let lastGeminiCall = 0;
const GEMINI_MIN_INTERVAL = 1000;

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
  // ⬆️ AUMENTADO A 10 SEGUNDOS PARA EVITAR ABORTOS PREMATURES
  const timeout = setTimeout(() => controller.abort(), 10000);

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
    /(?:^|\b)(?:con|soy|me\s?llamo|mi\s?nombre\s?es|soy\s+el|soy\s+la)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,5})/i,
    /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,5})/i,
    /hola[,.\s]+(?:soy|me\s?llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,5})/i,
    /[,.\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,5})/i,
    /\bsoy\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,5})/i,
    /\bme\s+llamo\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,5})/i,
    /\bmi\s+nombre\s+es\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,5})/i
  ];
  
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      const common = /^(hola|buenos|buenas|gracias|ok|si|no|que|como|cuando|por|para|con|sin|de|del|la|el|los|las|un|una|es|esta|este|estos|estas|yo|tu|el|ella|nosotros|ellos|usted|ustedes)/i;
      if (name.length > 2 && !common.test(name)) {
        console.log(`   ✅ Nombre detectado: "${name}"`);
        return name;
      }
    }
  }
  console.log(`   ⚠️  No se detectó nombre en: "${text}"`);
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

function detectResolution(text) {
  const t = normalizeText(text);
  const resolutionPatterns = [
    /\b(ya\s+(arreglamos|solucionamos|resolvimos|reparamos|hicimos|terminamos|quedó\s+listo|está\s+listo))\b/i,
    /\b(esto\s+ya\s+(se\s+)?(arregló|solucionó|resolvió|hizo|terminó))\b/i,
    /\b(problema\s+(resuelto|solucionado|arreglado))\b/i,
    /\b(ya\s+no\s+(hay|existe)\s+(el\s+)?problema)\b/i,
    /\b(ya\s+funciona|ya\s+está\s+funcionando)\b/i,
    /\b(listo|terminado|completado|finalizado)\b/i,
    /\b(se\s+arregló|se\s+solucionó|se\s+resolvió)\b/i,
    /\b(quedó\s+(arreglado|solucionado|resuelto|listo))\b/i
  ];
  for (const pattern of resolutionPatterns) {
    if (pattern.test(t)) return true;
  }
  return false;
}

function detectEmployeeState(text) {
  const t = normalizeText(text);
  if (/\b(estoy\s+(trabajando|encargando|viendo|revisando|atendiendo|en\s+eso))\b/i.test(t) ||
      /\b(ya\s+estoy\s+(en\s+eso|encargado|revisando))\b/i.test(t) ||
      /\b(lo\s+estoy\s+(viendo|revisando|atendiendo))\b/i.test(t)) {
    return 'trabajando';
  }
  if (/\b(estoy\s+ocupado|tengo\s+varios\s+casos|no\s+puedo\s+ahora|estoy\s+lleno)\b/i.test(t)) {
    return 'ocupado';
  }
  if (/\b(ya\s+terminé|ya\s+estoy\s+libre|disponible|listo\s+para\s+otro)\b/i.test(t)) {
    return 'disponible';
  }
  return null;
}

function detectLocation(text) {
  const t = text.trim();
  const patterns = [
    /(?:en|está en|es en|ubicado en|se encuentra en)\s+(el\s+)?(piso\s+\d+|área\s+de\s+\w+|oficina\s+de\s+\w+|sala\s+\w+|departamento\s+de\s+\w+)(?:\s*,\s*(.+?))?(?:\.|,|$)/i,
    /(piso\s+\d+)\s+(por|cerca de|al lado de|frente a)\s+(el\s+)?(área\s+de\s+\w+|oficina\s+de\s+\w+|sala\s+\w+)(?:\.|,|$)/i,
    /(?:área|oficina|sala|departamento|sección)\s+de\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)(?:\.|,|$)/i,
    /piso\s+(\d+|[a-z]+)(?:\.|,|$)/i,
    /(?:en|por|cerca de|al lado de|frente a)\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+){0,5})(?:\.|,|$)/i
  ];
  
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match) {
      const parts = match.slice(1).filter(p => p && p.length > 1);
      const location = parts.join(', ').trim();
      if (location.length > 2 && location.length < 150) {
        console.log(`   📍 Ubicación detectada: "${location}"`);
        return location;
      }
    }
  }
  
  if (t.length < 80 && 
      !/^(hola|gracias|ok|si|no|buenos|buenas|que|como|cuando|donde)/i.test(t) &&
      !/\?$/.test(t)) {
    if (/(piso|área|oficina|sala|departamento|edificio|caja|cajas|recepción|entrada|salida|baño|cocina|comedor)/i.test(t)) {
      console.log(`   📍 Ubicación detectada (mensaje corto): "${t}"`);
      return t;
    }
  }
  return null;
}

async function extractRegistrationData(text) {
  console.log(`   🔍 Extrayendo datos...`);
  let nombre = extractNameLocal(text);
  let area = safeArea(text);
  let cargo = extractCargoLocal(text);

  if (!nombre || !area) {
    const areasList = config.areas.join(', ');
    const prompt = `Extrae del mensaje: {"nombre":"string","area":"string|null","cargo":"string"}. 
El área debe ser una de: ${areasList}. 
Solo JSON. 
Mensaje: "${text}"`;
    
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

function fallbackDetectIntent(text, context = {}) {
  const t = normalizeText(text);
  const ticketId = parseTicketTag(text);
  
  // Soporta tanto activeTickets (array) como activeTicket (objeto) por compatibilidad
  const activeTickets = context.activeTickets || (context.activeTicket ? [context.activeTicket] : []);
  const primaryTicket = activeTickets[0] || null;

  // PRIORIDAD 0: Detectar resolución
  if (primaryTicket && primaryTicket.assignedTo === context.employeePhone) {
    if (detectResolution(text)) {
      console.log(`   ✅ Resolución detectada para ticket #T-${primaryTicket.id}`);
      return { 
        intencion: 'resolver_ticket', 
        ticket_id: activeTickets.length === 1 ? primaryTicket.id : null,
        descripcion: text,
        confianza: 90 
      };
    }
    
    const empState = detectEmployeeState(text);
    if (empState) {
      console.log(`   👤 Estado de empleado detectado: ${empState}`);
      return { 
        intencion: 'cambiar_estado_empleado',
        estado: empState,
        ticket_id: activeTickets.length === 1 ? primaryTicket.id : null,
        confianza: 85
      };
    }
  }

  if (/^(hola|buenos?\s?(dias|tardes|noches)|hey|hi|que\s?tal|saludos|buenas)\b/i.test(t)) {
    return { intencion: 'saludo', confianza: 95 };
  }

  if (/\b(gracias|muchas?\s?gracias|te\s?agradezco|thank)\b/i.test(t)) {
    return { intencion: 'agradecimiento', confianza: 90 };
  }

  if (/\b(adios|chao|hasta\s?(luego|pronto)|nos\s?vemos|bye)\b/i.test(t)) {
    return { intencion: 'despedida', confianza: 90 };
  }

  if (ticketId) {
    return { intencion: 'actualizar_ticket', ticket_id: ticketId, urgencia: detectUrgencyFromText(text), descripcion: text, confianza: 85 };
  }

  // PRIORIDAD 1: Si hay ticket activo y el usuario es el SOLICITANTE, es aclaración
  if (primaryTicket && primaryTicket.requesterPhone === context.employeePhone) {
    console.log(`   📝 Aclaración del solicitante para ticket #T-${primaryTicket.id}`);
    return { 
      intencion: 'aclaracion_automatica', 
      ticket_id: primaryTicket.id,
      descripcion: text,
      confianza: 90 
    };
  }

  // PRIORIDAD 2: Si el empleado asignado habla sobre su ticket activo
  if (primaryTicket && primaryTicket.assignedTo === context.employeePhone) {
    console.log(`   📝 Aclaración automática para ticket #T-${primaryTicket.id}`);
    return { 
      intencion: 'aclaracion_automatica', 
      ticket_id: primaryTicket.id,
      descripcion: text,
      confianza: 90 
    };
  }

  // PRIORIDAD 3: Si hay ticket activo y el mensaje parece ser información adicional
  if (primaryTicket) {
    const additionalInfo = /^(mira|oye|ah|por\s+cierto|tambien|ademas|sobre|respecto|referente|relacionado|lo\s+que|eso|eso\s+era|era\s+que|resulta\s+que|pasa\s+que|es\s+que)/i;
    
    if (additionalInfo.test(t) || t.length < 100) {
      console.log(`   📝 Información adicional para ticket #T-${primaryTicket.id}`);
      return { 
        intencion: 'aclaracion_automatica', 
        ticket_id: primaryTicket.id,
        descripcion: text,
        confianza: 85 
      };
    }
    
    const ticketRef = /(ticket\s+(anterior|activo|actual|este)|el\s+ticket|mi\s+ticket|actualizar|agregar|añadir|informar|comentar)/i;
    if (ticketRef.test(t)) {
      return { 
        intencion: 'actualizar_ticket', 
        ticket_id: primaryTicket.id, 
        urgencia: detectUrgencyFromText(text), 
        descripcion: text, 
        confianza: 90 
      };
    }
  }

  let area = safeArea(text);
  const urgencia = detectUrgencyFromText(text);

  const problemKeywords = /(no\s?(puedo|funciona|hay|entra|sirve|anda|imprime|conecta|carga)|error|falla|problema|ayuda|solicito|requiero|necesito|caida|sin\s?(acceso|servicio|internet|correo|tinta|toner)|computadora|pc|equipo|molestia|molesto|lento|demora|no\s?me\s?deja|no\s?puedo\s?acceder|no\s?carga|no\s?conecta|impresora|tinta|toner|falta|se\s?quedo|se\s?queda|papel|atascada|no\s?imprime|no\s?escanea|no\s?copia)/i;
  
  if (problemKeywords.test(t) && t.length >= 5 && activeTickets.length === 0) {
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

  const indirectProblem = /(le\s?hace\s?falta|le\s?falta|necesita|requiere|se\s?acabo|se\s?termino|sin\s+\w+|no\s?tengo)/i;
  if (indirectProblem.test(t) && t.length >= 5 && activeTickets.length === 0) {
    return { 
      intencion: 'crear_ticket', 
      area, 
      urgencia, 
      titulo: text.slice(0, 120), 
      descripcion: text, 
      confianza: 80,
      es_problema: true
    };
  }

  if (t.length < 30) {
    return { intencion: 'consulta', descripcion: text, confianza: 40 };
  }

  return { intencion: 'otro', descripcion: text, confianza: 20 };
}

async function detectIntent(text, { employee, activeTickets = [], activeTicket = null, history = [], employeePhone = null }) {
  const tickets = activeTickets.length > 0 ? activeTickets : (activeTicket ? [activeTicket] : []);
  const fallback = fallbackDetectIntent(text, { activeTickets: tickets, activeTicket: tickets[0] || null, employeePhone, employee });

  if (fallback && fallback.confianza >= 75) {
    console.log(`   ✅ Fallback (${fallback.confianza}%)`);
    return fallback;
  }

  console.log(`   🤖 Usando Gemini...`);
  const historyText = history.slice(-4).map(m => `${m.from === 'bot' ? 'Bot' : 'Usuario'}: ${m.text}`).join(' | ');
  const areasList = config.areas.join(', ');

  let ticketsContext = 'Ninguno';
  if (tickets.length > 0) {
    ticketsContext = tickets.map(t => `ID: ${t.id}, Título: "${t.title || 'Sin título'}", Área: ${t.area || 'Desconocida'}`).join(' | ');
  }

  const prompt = `Clasifica el mensaje en un chat de soporte CONATEL.
Contexto: ${historyText || '(inicio)'}
Mensaje: "${text}"
Usuario: ${employee ? employee.name : 'no'}
Tickets activos del usuario: ${ticketsContext}
Áreas disponibles: ${areasList}

Reglas:
1. Si el usuario tiene VARIOS tickets activos y su mensaje es ambiguo (ej: "ya lo arreglé"), devuelve intencion: "aclarar_ticket".
2. Si menciona un número o el contexto apunta claramente a un ticket activo, usa intencion: "actualizar_ticket" o "resolver_ticket" y pon el "ticket_id" correcto.

Devuelve JSON:
{"intencion":"saludo|crear_ticket|actualizar_ticket|resolver_ticket|aclarar_ticket|consulta|agradecimiento|despedida|aclaracion|otro","ticket_id":null,"area":"string|null","urgencia":"baja|media|alta|critica|null","titulo":"string|null","descripcion":"string|null","confianza":0,"es_problema":false,"requiere_ubicacion":false}`;

  const ai = await gemini(prompt, { json: true });

  if (!ai || !ai.intencion) {
    console.log(`   🔄 Fallback`);
    return fallback || { intencion: 'otro', descripcion: text, confianza: 20 };
  }

  const merged = { ...fallback, ...ai };
  merged.area = safeArea(merged.area) || (fallback ? fallback.area : null);
  merged.urgencia = merged.urgencia || detectUrgencyFromText(text);
  merged.confianza = Number(merged.confianza) || (fallback ? fallback.confianza : 50);

  // Si la IA detectó "aclarar_ticket" pero hay solo 1 ticket, forzamos a actualizar ese.
  if (merged.intencion === 'aclarar_ticket' && tickets.length === 1) {
    merged.intencion = 'actualizar_ticket';
    merged.ticket_id = tickets[0].id;
  }

  return merged;
}

async function generateResponse({ intent, employee, activeTickets = [], activeTicket = null, userMessage, context = {}, history = [] }) {
  const tickets = activeTickets.length > 0 ? activeTickets : (activeTicket ? [activeTicket] : []);

  // 1. Respuestas 100% locales e instantáneas (Sin llamar a la IA)
  if (['saludo', 'agradecimiento', 'despedida'].includes(intent.intencion)) {
    return getRandomResponse(intent.intencion === 'saludo' && employee ? 'saludo_registrado' : intent.intencion, { nombre: employee?.name || '' });
  }

  // 2. Fallbacks inteligentes si la confianza es baja (Evita llamar a Gemini y fallar con 503/Abort)
  if (intent.confianza < 50 && intent.intencion === 'otro') {
    return getRandomResponse('no_entendido');
  }
  if (intent.confianza < 50 && intent.intencion === 'consulta') {
    return '¿Podrías darme un poco más de detalle para ayudarte mejor?';
  }

  // 3. Lógica específica para múltiples tickets
  if (intent.intencion === 'aclarar_ticket' && tickets.length >= 2) {
    const t1 = tickets[0].title || `Ticket #${tickets[0].id}`;
    const t2 = tickets[1].title || `Ticket #${tickets[1].id}`;
    return getRandomResponse('multi_ticket_ambiguo', { ticket1: t1, ticket2: t2 });
  }

  if (intent.intencion === 'crear_ticket' && intent.es_problema) {
    const location = detectLocation(userMessage);
    if (!location) {
      return getRandomResponse('pedir_ubicacion');
    }
    return getRandomResponse('problema_detectado');
  }

  if (intent.intencion === 'resolver_ticket' && intent.ticket_id) {
    return `¡Excelente! Procedo a marcar el ticket #${intent.ticket_id} como resuelto. ¿Necesitas algo más?`;
  }

  if ((intent.intencion === 'actualizar_ticket' || intent.intencion === 'aclaracion_automatica') && intent.ticket_id) {
    return `Entendido. Agrego esta información al ticket #${intent.ticket_id} y notifico al equipo.`;
  }

  // 4. Solo si la confianza es alta, intentamos generar con IA
  const historyText = history.slice(-6).map(m => `${m.from === 'bot' ? 'Bot' : 'Usuario'}: ${m.text}`).join('\n');
  const prompt = `Eres un asistente de CONATEL. Responde natural, breve (1-2 líneas), sin emojis excesivos.

Historial:
${historyText || '(inicio)'}

Mensaje: "${userMessage}"
Intención: ${intent.intencion}
Usuario: ${employee ? employee.name : 'no registrado'}
Ticket: ${intent.ticket_id ? '#' + intent.ticket_id : 'ninguno'}

Responde como persona real. Sin markdown.`;

  const response = await gemini(prompt, { json: false });

  if (response && typeof response === 'string' && response.trim().length > 0) {
    return response.trim().replace(/^["']|["']$/g, '');
  }

  // 5. Fallback final si la IA falla completamente
  switch (intent.intencion) {
    case 'crear_ticket':
      return getRandomResponse('problema_detectado');
    case 'actualizar_ticket':
    case 'aclaracion':
    case 'aclaracion_automatica':
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
  getRandomResponse,
  setCustomMessages,
  detectResolution,
  detectEmployeeState,
  detectLocation
};