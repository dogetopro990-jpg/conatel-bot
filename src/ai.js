const config = require('./config');
const { normalizeText, parseTicketTag } = require('./utils');

const API_BASE = 'https://generativelanguage.googleapis.com/v1/models';
const cache = new Map();
const CACHE_TTL = 120000;

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL) { cache.delete(key); return null; }
  return item.value;
}
function setCache(key, value) { cache.set(key, { value, timestamp: Date.now() }); }

let customMessages = null;
function setCustomMessages(messages) { customMessages = messages; }
function getMessages(category, fallback) {
  if (customMessages && customMessages[category] && customMessages[category].length > 0) return customMessages[category];
  return fallback;
}

const RESPONSES = {
  saludo: ['¡Hola! Soy el asistente de CONATEL. ¿Con quién tengo el gusto de hablar?', '¡Buenas! ¿Me puedes decir tu nombre para ayudarte mejor?'],
  saludo_registrado: ['¡Hola {nombre}! ¿En qué te puedo ayudar hoy?', '¡Buenas {nombre}! Cuéntame, ¿qué necesitas?'],
  pedir_area: ['Perfecto {nombre}, ¿en qué área trabajas? (Ej: DIGER, DISET, Compras)'],
  pedir_cargo: ['¿Cuál es tu cargo o puesto actual?'],
  pedir_ubicacion: ['¿En qué lugar específico es el problema? (Ej: Piso 3, área de cajas)', '¿Me puedes dar la ubicación exacta?'],
  describir_problema: ['Claro, cuéntame, ¿cuál es el nuevo problema o solicitud que tienes?'],
  transicion_a_solicitud: ['Bien {nombre}, ¿qué necesitas?'],
  agradecimiento: ['¡Con mucho gusto! ¿Hay algo más en lo que pueda ayudarte?'],
  despedida: ['¡Hasta luego! Que tengas un excelente día.'],
  problema_detectado: ['Entendido, ya estoy registrando el problema. Te aviso apenas tenga novedades.'],
  no_entendido: ['No entendí bien. ¿Podrías explicarme con otras palabras qué necesitas?'],
  emoji_solo: ['Veo que enviaste un emoji. 😊 ¿Necesitas ayuda con algo? Si tienes un problema, descríbelo y lo registro.'],
  rechazo: ['Entendido, lo dejamos así. Si necesitas algo en el futuro, aquí estaré.'],
  confirmacion_mismo: ['Perfecto, lo agrego a tu ticket existente.'],
  confirmacion_nuevo: ['Entendido, vamos a registrar un nuevo problema.'],
  adjunto_recibido: ['📎 Recibí tu archivo/imagen. Lo adjuntaré al ticket como evidencia.'],
  ubicacion_gps: ['📍 Recibí tu ubicación GPS. La usaré para registrar el problema.'],
  audio_recibido: ['🎤 Recibí tu nota de voz. La transcribiré y la agregaré al ticket.'],
  sticker_recibido: ['Veo que enviaste un sticker. ¿Podrías describirme el problema con palabras?'],
  mensaje_duplicado: ['Ya recibí ese mensaje anteriormente. ¿Hay algo nuevo que quieras agregar?'],
  mensaje_editado: ['✏️ Veo que editaste tu mensaje. Actualizaré la información del ticket.'],
  queja_escalada: ['Entiendo tu frustración. Escalaré este caso a un supervisor para atención prioritaria.'],
  prueba_sistema: ['Recibido. El sistema está funcionando correctamente.'],
  multiple_problemas: ['Detecté que mencionas varios problemas. Los registraré por separado para mejor seguimiento.'],
  correccion: ['Entendido, actualizaré la información con tu corrección.'],
  fuera_de_horario: ['Recibido. Aunque estamos fuera de horario, tu ticket queda registrado y será atendido a primera hora.'],
  enlace_recibido: ['🔗 Recibí el enlace. Lo guardaré como referencia en el ticket.'],
  contacto_recibido: ['👤 Recibí el contacto. Lo asociaré como referencia del problema.']
};

function getRandomResponse(category, replacements = {}) {
  const responses = getMessages(category, RESPONSES[category]) || RESPONSES.no_entendido;
  let response = responses[Math.floor(Math.random() * responses.length)];
  Object.keys(replacements).forEach(key => {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    response = response.replace(new RegExp(`\\{${escapedKey}\\}`, 'g'), replacements[key] || '');
  });
  return response;
}

function safeArea(value) {
  if (!value) return null;
  const area = normalizeText(value || '').toLowerCase();
  if (!area) return null;
  for (const configuredArea of config.areas) {
    const normalizedConfig = normalizeText(configuredArea).toLowerCase();
    if (area === normalizedConfig || area.includes(normalizedConfig) || normalizedConfig.includes(area)) return configuredArea;
  }
  const areaMappings = {
    'DIGER': ['diget', 'diger', 'digit', 'digital', 'gestion'],
    'DISET': ['diset', 'sistema', 'sistemas', 'soporte', 'mesa', 'helpdesk', 'ti', 'tecnolog', 'informatica', 'computacion', 'software', 'desarrollo', 'infotegnologia', 'infotecnologia', 'informatica'],
    'DIREM': ['direm', 'remuneracion', 'remuneraciones', 'sueldo', 'salario', 'nomina'],
    'LEGAL': ['legal', 'juridic', 'abogad', 'ley', 'contrato'],
    'SECRETARIA': ['secret', 'secretaria', 'direccion general'],
    'Servicios Generales': ['servicio', 'servicios', 'general', 'generales', 'mantenimiento', 'limpieza'],
    'Proteccion al usuario': ['proteccion', 'usuario', 'usuarios', 'consumidor', 'cliente'],
    'Compras': ['compra', 'compras', 'adquisicion', 'adquisiciones', 'proveedor'],
    'Bienes': ['bien', 'bienes', 'inventario', 'activo', 'activos'],
    'Cartera y cobranza': ['cartera', 'cobranza', 'cobro', 'cobros', 'pago', 'pagos', 'deuda'],
    'Contabilidad': ['contab', 'contabilidad', 'finanza', 'finanzas', 'contador'],
    'Gerencia General': ['gerencia', 'gerente', 'direccion', 'directorio'],
    'Comision': ['comision', 'comisiones'],
    'DIPLADE': ['diplade', 'planificacion', 'planeacion', 'desarrollo'],
    'Comunicaciones': ['comunicacion', 'comunicaciones', 'red', 'redes', 'infra', 'infraestructura', 'telecomunicacion', 'internet', 'wifi', 'conexion']
  };
  for (const [areaName, keywords] of Object.entries(areaMappings)) {
    for (const keyword of keywords) {
      if (area.includes(keyword)) return config.areas.find(a => a === areaName) || areaName;
    }
  }
  return null;
}

function extractJson(text = '') {
  const cleaned = String(text || '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const fence = cleaned.match(/```(?:json)?([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {} }
  return null;
}

let lastGeminiCall = 0;
const GEMINI_MIN_INTERVAL = 1000;

async function gemini(prompt, { json = true } = {}) {
  const cacheKey = `${prompt.substring(0, 150)}_${json}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  if (!config.geminiApiKey) return null;
  const now = Date.now();
  if (now - lastGeminiCall < GEMINI_MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, GEMINI_MIN_INTERVAL - (now - lastGeminiCall)));
  }
  lastGeminiCall = now;
  const url = `${API_BASE}/${config.geminiModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 512 } };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) { console.log(`   ❌ Gemini: HTTP ${response.status}`); return null; }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    if (!text) return null;
    const result = json ? extractJson(text) : text;
    setCache(cacheKey, result);
    return result;
  } catch (error) { console.log(`   ❌ Gemini: ${error.message}`); return null; }
  finally { clearTimeout(timeout); }
}

function detectUrgencyFromText(text) {
  const t = normalizeText(text);
  if (/(no\s?funciona|caida|sin\s?(servicio|internet|acceso)|emergencia|urgente|bloquea|no\s?puedo\s?trabajar|produccion|parado|peligro|riesgo|enchufe\s+quemado|cortocircuito|chispas|humo|fuego|inundacion|derrame)/i.test(t)) return 'critica';
  if (/(importante|hoy|pronto|afecta|no\s?puedo|error|falla|problema|lento|molestia|roto|dañado|quemado|malogrado|averiado|atascado)/i.test(t)) return 'alta';
  if (/(consulta|duda|cuando|como|informacion|pregunta|averiguar|saber)/i.test(t)) return 'baja';
  return 'media';
}

function detectResolution(text) {
  const t = normalizeText(text);
  return /\b(ya\s+(arreglamos|solucionamos|resolvimos|reparamos|quedó\s+listo|está\s+listo|funciona|sirve|anda|carga|imprime|conecta)|problema\s+(resuelto|solucionado|arreglado)|se\s+(arregló|solucionó|resolvió|compuso)|ya\s+no\s+(hay|existe|falla)|está\s+resuelto|quedó\s+resuelto|todo\s+listo|todo\s+ok|todo\s+bien)\b/i.test(t);
}

function detectEmployeeState(text) {
  const t = normalizeText(text);
  if (/\b(estoy\s+(trabajando|encargando|viendo|revisando|atendiendo|en\s+eso|en\s+proceso)|ya\s+estoy\s+(en\s+eso|encargado|revisando|trabajando)|lo\s+estoy\s+(viendo|revisando|atendiendo|trabajando)|estoy\s+en\s+eso)\b/i.test(t)) return 'trabajando';
  if (/\b(estoy\s+(ocupado|lleno|con\s+varios\s+casos)|no\s+puedo\s+(ahora|atender|ver)|tengo\s+mucho\s+trabajo|estoy\s+en\s+otra\s+cosa)\b/i.test(t)) return 'ocupado';
  if (/\b(ya\s+(terminé|acabé|finalicé|culminé)|estoy\s+(disponible|libre|desocupado)|listo\s+para\s+(otro|más)|ya\s+no\s+tengo\s+nada|puedo\s+atender)\b/i.test(t)) return 'disponible';
  return null;
}

function isValidLocation(text) {
  const t = text.trim().toLowerCase();
  if (/^(hola|buenos|buenas|gracias|ok|si|no|vale|listo|perfecto|entendido|adios|chao|bye|cancelar|dejar|olvidar|nada|ninguno)\b/i.test(t)) return false;
  if (/(piso|área|oficina|sala|departamento|edificio|caja|cajas|recepción|entrada|salida|baño|cocina|comedor|pasillo|escalera|ascensor|planta|sector|zona|puesto|estación|mesa|escritorio|ventanilla|mostrador|archivo|almacén|bodega|garaje|estacionamiento|sótano|azotea|terraza)/i.test(t)) return true;
  if (/^(piso\s+\d+|\d+\s*(piso|planta)|área\s+de|oficina\s+\d+|sala\s+\d+)/i.test(t)) return true;
  if (t.length < 8 && !/\d/.test(t)) return false;
  return true;
}

function detectLocation(text) {
  const t = text.trim();
  if (!isValidLocation(t)) return null;
  const patterns = [
    /(?:en|está en|es en|ubicado en|se encuentra en|queda en)\s+(?:el\s+|la\s+|los\s+|las\s+)?(piso\s+\d+|área\s+de\s+\w+|oficina\s+de\s+\w+|sala\s+\w+|departamento\s+de\s+\w+|edificio\s+\w+|puesto\s+\d+|estación\s+\w+|mesa\s+\d+|escritorio\s+\d+)(?:\s*,\s*(.+?))?(?:\.|,|$)/i,
    /(?:área|oficina|sala|departamento|sección|puesto|estación)\s+de\s+([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)(?:\.|,|$)/i,
    /piso\s+(\d+|[a-z]+)(?:\.|,|$)/i,
    /(?:en|por|cerca de|al lado de|frente a|junto a|detrás de)\s+(?:el\s+|la\s+)?([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+){0,4})(?:\.|,|$)/i
  ];
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match) {
      const parts = match.slice(1).filter(p => p && p.length > 1);
      const location = parts.join(', ').trim();
      if (location.length > 2 && location.length < 200) return location;
    }
  }
  if (t.length < 120 && !/^(hola|gracias|ok|si|no|buenos|buenas|que|como|cuando|donde|porque|quien|cual)/i.test(t) && !/\?$/.test(t)) {
    if (/(piso|área|oficina|sala|departamento|edificio|caja|cajas|recepción|entrada|salida|baño|cocina|comedor|pasillo|escalera|ascensor|planta|sector|zona|puesto|estación|mesa|escritorio|ventanilla|mostrador|archivo|almacén|bodega)/i.test(t)) return t;
  }
  return null;
}

async function extractRegistrationData(text) {
  let nombre = null, area = safeArea(text), cargo = null;
  const nameMatch = text.match(/(?:soy|me llamo|mi nombre es|me dicen|me conocen como)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ\s]{1,40})/i);
  if (nameMatch) nombre = nameMatch[1].trim();
  if (!nombre || !area) {
    const ai = await gemini(`Extrae: {"nombre":"string","area":"string|null","cargo":"string"}. Áreas: ${config.areas.join(', ')}. Mensaje: "${text}"`, { json: true });
    if (ai) { nombre = ai.nombre || nombre; area = safeArea(ai.area) || area; cargo = ai.cargo || cargo; }
  }
  return { nombre, area, cargo };
}

function detectConfirmationResponse(text) {
  const t = text.trim().toLowerCase();
  if (/^(sí|si|s|el mismo|es el mismo|el de antes|el anterior|el que tengo|ese mismo|ese|sí, ese|si, es ese|es ese|el que mencionas|el que me dijiste|correcto|exacto|así es|ajá|aja|claro|por supuesto|afirmativo|ok es ese|vale es ese|listo es ese)\b/i.test(t)) {
    return 'same';
  }
  if (/^(no|n|es nuevo|uno nuevo|otro|otra cosa|diferente|no es ese|no es el mismo|nuevo problema|nueva cosa|es otra cosa|aparte|otro problema|una cosa nueva|algo nuevo|n|para nada|negativo)\b/i.test(t)) {
    return 'new';
  }
  if (/^(cancelar|dejar|olvidar|nada|no importa|déjalo|olvídalo|no quiero|mejor no|ya no|no necesito|olvídalo)\b/i.test(t)) {
    return 'cancel';
  }
  return null;
}

function isEmojiOrNonsense(text) {
  const cleaned = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '').trim();
  if (cleaned.length === 0 && text.length > 0) return true;
  if (/^[^\w\sáéíóúñ]{1,10}$/.test(text)) return true;
  return false;
}

function isTicketStatusQuery(text) {
  const t = text.toLowerCase();
  return /(?:qué|que)\s+(?:pasó|paso|hay|sucedio|acontecio)\s+con\s+(?:mi|el|el\s+ticket|ticket)/i.test(t) ||
         /(?:ya|aun|todavía|todavia)\s+(?:lo|la|se)\s+(?:resolvieron|resolvió|arreglaron|arregló|solucionaron|solucionó)/i.test(t) ||
         /(?:cómo|como)\s+(?:va|está|esta|sigue)\s+(?:mi|el)\s+(?:ticket|problema|caso|solicitud)/i.test(t) ||
         /(?:estado|situación|situacion)\s+(?:de|del|de\s+mi)\s+(?:ticket|problema|caso)/i.test(t);
}

function analyzeTicketContext(text, primaryTicket) {
  if (!primaryTicket) return { action: 'no_ticket', reason: 'No hay ticket activo' };
  const t = text.toLowerCase();
  const ticketTitle = normalizeText(primaryTicket.title || '').toLowerCase();
  const ticketDesc = normalizeText(primaryTicket.description || '').toLowerCase();
  const ticketLocation = normalizeText(primaryTicket.location || '').toLowerCase();
  const ticketContext = `${ticketTitle} ${ticketDesc}`;
  
  const continuationPhrases = [
    /\bcon\s+respecto\s+(a|al|la|lo)\b/i, /\brespecto\s+(a|al|la|del|de\s+la|de\s+lo)\b/i,
    /\bsobre\s+(el|la|los|las|lo\s+de|lo\s+del|esto|eso)\b/i, /\ben\s+relacion\s+(a|con)\b/i,
    /\breferente\s+a\b/i, /\bacerca\s+de\b/i, /\ben\s+cuanto\s+a\b/i, /\blo\s+de\s+(la|el|los|las)\b/i,
    /\blo\s+del\b/i, /\bsigo\s+con\b/i, /\bcontinuando\s+con\b/i, /\bretomando\b/i, /\bvolviendo\s+a\b/i,
    /\brespecto\s+del\b/i, /\bcon\s+relacion\s+(al|a\s+la)\b/i, /\bsobre\s+el\s+tema\b/i,
    /\brespecto\s+al\s+(ticket|problema)\b/i, /\bsobre\s+el\s+(ticket|problema)\b/i,
    /\bhablando\s+de\b/i, /\brelacionado\s+(con|a)\b/i, /\ba\s+la\s+\w+\s+lo\s+que\b/i,
    /\brespecto\s+(a\s+la|al)\b/i, /\bes\s+el\s+mismo\b/i, /\bme\s+refiero\s+(al|a\s+la)\b/i,
    /\bhablo\s+del\b/i, /\bcontinuando\b/i, /\bcomo\s+te\s+decia\b/i, /\bcomo\s+te\s+dije\b/i
  ];
  
  if (continuationPhrases.some(pattern => pattern.test(text))) {
    return { action: 'update_ticket', reason: 'Frase de continuación explícita' };
  }

  if (/(otro\s+problema|nuevo\s+problema|otra\s+cosa|diferente|cambio\s+de\s+tema|aparte|por\s+otro\s+lado|tengo\s+otra\s+consulta|olvida\s+lo\s+anterior|ya\s+no\s+es\s+eso|es\s+otra\s+cosa|no.*es\s+el\s+mismo|es\s+uno\s+nuevo|es\s+otra\s+(impresora|computadora|pc|pantalla|monitor)|es\s+otro\s+(equipo|problema|caso))/i.test(t)) {
    return { action: 'new_ticket', reason: 'Frase de cambio de tema explícita' };
  }

  const ticketKeywords = ticketContext.match(/\b[a-záéíóúñ]{4,}\b/g) || [];
  const stopWords = ['para', 'como', 'pero', 'esta', 'este', 'esto', 'esa', 'ese', 'eso', 'tiene', 'hacer', 'puede', 'necesita', 'sobre', 'con', 'que', 'los', 'las', 'del', 'por', 'fue', 'ser', 'estar', 'han', 'hay', 'una', 'uno'];
  
  const sharedKeywords = ticketKeywords.filter(keyword => {
    if (stopWords.includes(keyword)) return false;
    return t.includes(keyword);
  });

  if (sharedKeywords.length > 0) {
    const msgLocation = detectLocation(text);
    if (msgLocation && ticketLocation && normalizeText(msgLocation).toLowerCase() !== ticketLocation) {
      console.log(`   📍 Ubicación diferente: Ticket="${ticketLocation}" vs Msg="${msgLocation}"`);
      return { action: 'new_ticket', reason: 'Mismo objeto, ubicación diferente' };
    }

    if (/\b(otro|otra|otros|otras|diferente|nuevo|nueva|segundo|segunda|tercer|tercera)\b/i.test(t)) {
      return { action: 'new_ticket', reason: 'Indicador de "otro" objeto similar' };
    }

    const msgHasNewProblem = /(ahora|también|tambien|además|ademas|y\s+también|y\s+además|pero\s+ahora|nuevamente|de\s+nuevo|otra\s+vez|sigue|todavía|todavia|aún|aun)\s+(falla|no\s+funciona|no\s+anda|no\s+carga|no\s+imprime|está|esta|hay|tiene)/i.test(t);
    if (msgHasNewProblem) {
      return { action: 'ask_clarification', reason: 'Problema similar pero posiblemente diferente' };
    }

    return { action: 'ask_clarification', reason: 'Similitud ambigua' };
  }

  return { action: 'unclear', reason: 'Sin coincidencia clara' };
}

function isMixedGreeting(text) {
  const greetingPattern = /^(hola|buenos?\s?(dias|tardes|noches)|hey|hi|que\s?tal|saludos|buenas|buen\s?dia|buen\s?día)\b[\s,.!]*/i;
  const hasGreeting = greetingPattern.test(text);
  if (!hasGreeting) return false;
  const textWithoutGreeting = text.replace(greetingPattern, '').trim();
  if (textWithoutGreeting.length > 15) {
    console.log(`   🎯 Saludo mixto. Contenido: "${textWithoutGreeting.substring(0, 50)}..."`);
    return true;
  }
  return false;
}

function getProblemKeywords() {
  return [
    /no\s?(puedo|funciona|hay|entra|sirve|anda|imprime|conecta|carga|enciende|responde|prende|arranca|inicia|abre|cierra|funcione)/i,
    /error|falla|problema|ayuda|solicito|requiero|necesito|caida|sin\s?(acceso|servicio|internet|correo|tinta|toner|papel|energia|luz|corriente|señal|senal)/i,
    /computadora|pc|equipo|molestia|lento|demora|no\s?me\s?deja|no\s?puedo\s?acceder|no\s?carga|no\s?conecta|se\s?congelo|se\s?congela|se\s?traba|pantallazo|azul|negra/i,
    /impresora|tinta|toner|falta|se\s?quedo|se\s?queda|papel|atascada|atascado|no\s?imprime|no\s?escanea|no\s?copia|cartucho|inyector|inyectores|cabezal|rodillo|fusor/i,
    /monitor|pantalla|teclado|mouse|raton|cable|enchufe|tomacorriente|lampara|luz|regleta|extension|adaptador|cargador|bateria|pila/i,
    /roto|dañado|dañada|quemado|quemada|malogrado|malograda|averiado|averiada|partido|partida|quebrado|quebrada|deteriorado|deteriorada|descompuesto|descompuesta/i,
    /programa|aplicacion|software|sistema|plataforma|app|aplicativo|portal|pagina|sitio|web|intranet|extranet/i,
    /contraseña|password|clave|acceso|login|usuario|cuenta|correo|email|gmail|outlook|hotmail/i,
    /archivo|documento|pdf|excel|word|powerpoint|presentacion|hoja\s+de\s+calculo|base\s+de\s+datos/i,
    /virus|malware|antivirus|actualizacion|actualizar|instalar|desinstalar|configurar|configuracion/i,
    /internet|wifi|red|conexion|conectividad|pagina|sitio|web|router|modem|switch|access\s+point|punto\s+de\s+acceso|lento|rapido|velocidad|ancho\s+de\s+banda|ip|dns|proxy/i,
    /aire\s+acondicionado|clima|temperatura|ascensor|escalera|puerta|ventana|baño|sanitario|inodoro|lavabo|grifo|llave\s+de\s+agua|tuberia|fuga|goteo|gotera|filtracion/i,
    /silla|escritorio|mesa|mobiliario|oficina|estante|archivador|cajon|cerradura|llave|tarjeta\s+de\s+acceso|gafete|credencial/i,
    /humo|fuego|chispas|cortocircuito|olor|goteo|inundacion|derrame|emergencia|peligro|riesgo|accidente|golpe|caida/i,
    /hace\s?falta|necesita|requiere|se\s?acabo|se\s?termino|sin\s+\w+|no\s?tengo|no\s?hay|se\s?agoto|se\s?agotó|escasez|desabastecimiento/i,
    /telefono|telefonico|central|extension|conmutador|llamada|timbre|auricular|bocina|altavoz|microfono|camara|videoconferencia|zoom|teams|meet/i,
    /vehiculo|carro|coche|auto|camion|camioneta|moto|bicicleta|gasolina|combustible|llanta|neumatico|bateria|motor|freno|aceite/i
  ];
}

// ✅ NUEVO: Detectar tipo de mensaje (texto, imagen, audio, video, documento, ubicación, contacto, sticker)
function detectMessageType(message) {
  if (!message) return { type: 'unknown', hasMedia: false, caption: null };
  
  if (message.conversation || message.extendedTextMessage) {
    return { type: 'text', hasMedia: false, caption: null };
  }
  
  if (message.imageMessage) {
    return { type: 'image', hasMedia: true, caption: message.imageMessage.caption || null };
  }
  
  if (message.videoMessage) {
    return { type: 'video', hasMedia: true, caption: message.videoMessage.caption || null };
  }
  
  if (message.audioMessage) {
    return { type: 'audio', hasMedia: true, caption: null };
  }
  
  if (message.documentMessage) {
    return { type: 'document', hasMedia: true, caption: message.documentMessage.caption || null };
  }
  
  if (message.locationMessage) {
    return { type: 'location', hasMedia: true, caption: message.locationMessage.comment || null };
  }
  
  if (message.contactMessage) {
    return { type: 'contact', hasMedia: true, caption: null };
  }
  
  if (message.stickerMessage) {
    return { type: 'sticker', hasMedia: true, caption: null };
  }
  
  if (message.reactionMessage) {
    return { type: 'reaction', hasMedia: false, caption: null };
  }
  
  return { type: 'unknown', hasMedia: false, caption: null };
}

// ✅ NUEVO: Detectar si el mensaje fue reenviado (forward)
function isForwarded(message) {
  return message?.extendedTextMessage?.contextInfo?.isForwarded || 
         message?.imageMessage?.contextInfo?.isForwarded ||
         message?.videoMessage?.contextInfo?.isForwarded ||
         message?.documentMessage?.contextInfo?.isForwarded || false;
}

// ✅ NUEVO: Detectar si el mensaje es una respuesta a otro mensaje (reply)
function isReply(message) {
  return !!(message?.extendedTextMessage?.contextInfo?.quotedMessage ||
            message?.imageMessage?.contextInfo?.quotedMessage ||
            message?.videoMessage?.contextInfo?.quotedMessage);
}

// ✅ NUEVO: Detectar si el mensaje fue editado
function isEdited(message) {
  return !!(message?.editedMessage || message?.protocolMessage?.editedMessage);
}

// ✅ NUEVO: Extraer información técnica (códigos de error, modelos, seriales)
function extractTechnicalInfo(text) {
  const t = text.toLowerCase();
  const info = {
    errorCodes: [],
    models: [],
    serialNumbers: [],
    urls: [],
    emails: [],
    phoneNumbers: []
  };
  
  // Códigos de error (ej: 0x80070005, Error 404, E_FAIL)
  const errorCodePatterns = [
    /\b(0x[a-f0-9]+)\b/gi,
    /\berror\s+(\d+)\b/gi,
    /\b([a-z_]+_error|err_[a-z0-9]+)\b/gi,
    /\b(code|código)\s+([a-z0-9-]+)\b/gi
  ];
  
  errorCodePatterns.forEach(pattern => {
    const matches = t.match(pattern);
    if (matches) info.errorCodes.push(...matches);
  });
  
  // Modelos de equipos (ej: HP LaserJet 4050, Dell OptiPlex 7050)
  const modelPatterns = [
    /\b(hp|dell|lenovo|samsung|canon|epson|brother|xerox|ricoh|konica)\s+([a-z0-9\s-]+)\b/gi
  ];
  
  modelPatterns.forEach(pattern => {
    const matches = t.match(pattern);
    if (matches) info.models.push(...matches);
  });
  
  // Números de serie (patrones comunes)
  const serialPatterns = [
    /\bs[\/\s-]?n[:\s]+([a-z0-9-]+)\b/gi,
    /\bserial[:\s]+([a-z0-9-]+)\b/gi,
    /\b([a-z]{2}\d{6,})\b/g
  ];
  
  serialPatterns.forEach(pattern => {
    const matches = t.match(pattern);
    if (matches) info.serialNumbers.push(...matches);
  });
  
  // URLs
  const urlPattern = /https?:\/\/[^\s]+/gi;
  const urlMatches = text.match(urlPattern);
  if (urlMatches) info.urls.push(...urlMatches);
  
  // Emails
  const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const emailMatches = text.match(emailPattern);
  if (emailMatches) info.emails.push(...emailMatches);
  
  // Números de teléfono
  const phonePattern = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}/g;
  const phoneMatches = text.match(phonePattern);
  if (phoneMatches) info.phoneNumbers.push(...phoneMatches);
  
  return info;
}

// ✅ NUEVO: Detectar múltiples problemas en un mensaje
function detectMultipleProblems(text) {
  const t = text.toLowerCase();
  const separators = [
    /\s+y\s+/,  // "y"
    /\s+también\s+/,  // "también"
    /\s+además\s+/,  // "además"
    /\s+pero\s+/,  // "pero"
    /;\s*/,  // punto y coma
    /\.\s+/,  // punto seguido
    /\n/  // nueva línea
  ];
  
  const problems = [];
  let currentText = t;
  
  for (const separator of separators) {
    const parts = currentText.split(separator);
    if (parts.length > 1) {
      const problemKeywords = getProblemKeywords();
      parts.forEach(part => {
        const hasProblem = problemKeywords.some(pattern => pattern.test(part));
        if (hasProblem && part.trim().length > 10) {
          problems.push(part.trim());
        }
      });
    }
  }
  
  return problems.length > 1 ? problems : null;
}

// ✅ NUEVO: Detectar referencias temporales
function extractTemporalReferences(text) {
  const t = text.toLowerCase();
  const references = {
    past: [],
    present: [],
    future: [],
    duration: []
  };
  
  // Pasado
  const pastPatterns = [
    /\b(ayer|anteayer|anoche|esta\s+mañana|esta\s+tarde|anoche|hace\s+\d+\s+(días?|horas?|minutos?|semanas?|meses?))\b/gi
  ];
  
  pastPatterns.forEach(pattern => {
    const matches = t.match(pattern);
    if (matches) references.past.push(...matches);
  });
  
  // Presente
  const presentPatterns = [
    /\b(ahora|ahorita|en\s+este\s+momento|actualmente|recién|recien|justo\s+ahora)\b/gi
  ];
  
  presentPatterns.forEach(pattern => {
    const matches = t.match(pattern);
    if (matches) references.present.push(...matches);
  });
  
  // Futuro
  const futurePatterns = [
    /\b(mañana|pasado\s+mañana|próxima\s+semana|proximo\s+mes|en\s+\d+\s+(días?|horas?|minutos?))\b/gi
  ];
  
  futurePatterns.forEach(pattern => {
    const matches = t.match(pattern);
    if (matches) references.future.push(...matches);
  });
  
  // Duración
  const durationPatterns = [
    /\b(desde\s+hace\s+\d+\s+(días?|horas?|minutos?|semanas?|meses?))\b/gi,
    /\b(lleva\s+\d+\s+(días?|horas?|minutos?))\b/gi
  ];
  
  durationPatterns.forEach(pattern => {
    const matches = t.match(pattern);
    if (matches) references.duration.push(...matches);
  });
  
  return references;
}

// ✅ NUEVO: Detectar solicitudes de acción vs reporte de problema
function isActionRequest(text) {
  const t = text.toLowerCase();
  const actionPatterns = [
    /\b(reinicia|reiniciar|reinícialo|reboot|reset|resetea|resetear)\b/i,
    /\b(envía|enviar|manda|mandar)\s+(técnico|tecnico|persona|alguien)\b/i,
    /\b(ven|venir|pasa|pasar)\s+(a\s+ver|a\s+revisar|a\s+arreglar)\b/i,
    /\b(instala|instalar|configura|configurar|actualiza|actualizar)\b/i,
    /\b(desinstala|desinstalar|elimina|eliminar|borra|borrar)\b/i
  ];
  
  return actionPatterns.some(pattern => pattern.test(t));
}

// ✅ NUEVO: Detectar quejas y escalamientos
function isComplaintOrEscalation(text) {
  const t = text.toLowerCase();
  const patterns = [
    /\b(inaceptable|vergüenza|verguenza|descaro|colmo|increíble|increible)\b/i,
    /\b(supervisor|gerente|jefe|director|encargado|responsable)\b/i,
    /\b(queja|reclamo|demanda|denuncia)\b/i,
    /\b(llevo\s+(días?|semanas?|meses?)\s+esperando)\b/i,
    /\b(nadie\s+me\s+atiende|nadie\s+hace\s+nada|no\s+me\s+pelan)\b/i,
    /\b(esto\s+es\s+el\s+colmo|ya\s+me\s+cansé|ya\s+me\scansé|estoy\s+harto|estoy\sharta)\b/i
  ];
  
  return patterns.some(pattern => pattern.test(t));
}

// ✅ NUEVO: Detectar mensajes de prueba
function isTestMessage(text) {
  const t = text.trim().toLowerCase();
  return /^(prueba|test|testing|123|probando|hol[a]?|test[a-z]*)$/i.test(t);
}

// ✅ NUEVO: Detectar si el mensaje está fuera de horario laboral
function isOutOfHours() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0 = domingo, 6 = sábado
  
  // Fuera de horario: antes de las 8am, después de las 6pm, o fines de semana
  if (day === 0 || day === 6) return true;
  if (hour < 8 || hour >= 18) return true;
  return false;
}

// ✅ NUEVO: Detectar correcciones de mensajes anteriores
function isCorrection(text) {
  const t = text.toLowerCase();
  return /\b(quise\s+decir|dije\s+mal|me\s+equivoqué|me\sequivoqué|corrección|correccion|rectificación|rectificacion|perdón|perdon|disculpa|lo\s+siento|sorry)\b/i.test(t);
}

// ✅ NUEVO: Analizar sentimiento/frustración
function analyzeSentiment(text) {
  const t = text.toLowerCase();
  const frustratedPatterns = [
    /\b(molesto|molesta|enojado|enojada|frustrado|frustrada|furioso|furiosa|indignado|indignada)\b/i,
    /!\s*!\s*!/,  // Múltiples signos de exclamación
    /\b(maldición|maldicion|mierda|joder|carajo|puta|mierda)\b/i
  ];
  
  const satisfiedPatterns = [
    /\b(excelente|perfecto|genial|maravilloso|increíble|increible|buenísimo|buenisimo|fantástico|fantastico)\b/i,
    /\b(gracias|muchas\s+gracias|te\s+agradezco)\b/i
  ];
  
  if (frustratedPatterns.some(pattern => pattern.test(t))) return 'frustrated';
  if (satisfiedPatterns.some(pattern => pattern.test(t))) return 'satisfied';
  return 'neutral';
}

function fallbackDetectIntent(text, context = {}) {
  const t = normalizeText(text);
  const tLower = text.toLowerCase();
  const ticketId = parseTicketTag(text);
  const activeTickets = context.activeTickets || (context.activeTicket ? [context.activeTicket] : []);
  const primaryTicket = activeTickets[0] || null;

  // ESCENARIO 1: Mensajes de solo emojis o sin sentido
  if (isEmojiOrNonsense(text)) {
    return { intencion: 'emoji_o_sin_sentido', descripcion: text, confianza: 90 };
  }

  // ESCENARIO 2: Respuestas de confirmación
  const confirmation = detectConfirmationResponse(text);
  if (confirmation && primaryTicket) {
    if (confirmation === 'same') return { intencion: 'aclaracion_automatica', ticket_id: primaryTicket.id, descripcion: text, confianza: 95 };
    if (confirmation === 'new') return { intencion: 'describir_problema', confianza: 95 };
    if (confirmation === 'cancel') return { intencion: 'cancelar_operacion', confianza: 95 };
  }

  // ESCENARIO 3: Rechazo o cancelación explícita
  if (/^(cancelar|dejar|olvidar|nada|no importa|déjalo|olvídalo|no quiero|mejor no|ya no|no necesito|olvídalo|nunca mente| olvídalo|no gracias|no, gracias)\b/i.test(tLower)) {
    return { intencion: 'cancelar_operacion', confianza: 95 };
  }

  // ESCENARIO 4: Mención explícita de ID de ticket
  if (ticketId) return { intencion: 'actualizar_ticket', ticket_id: ticketId, urgencia: detectUrgencyFromText(text), descripcion: text, confianza: 95 };

  // ESCENARIO 5: Saludos MIXTOS
  if (isMixedGreeting(text)) {
    const greetingPattern = /^(hola|buenos?\s?(dias|tardes|noches)|hey|hi|que\s?tal|saludos|buenas|buen\s?dia|buen\s?día)\b[\s,.!]*/i;
    const textWithoutGreeting = text.replace(greetingPattern, '').trim();
    return fallbackDetectIntent(textWithoutGreeting, context);
  }

  // ESCENARIO 6: Intenciones básicas PURAS
  if (/^(hola|buenos?\s?(dias|tardes|noches)|hey|hi|que\s?tal|saludos|buenas|buen\s?dia|buen\s?día)\b/i.test(tLower)) return { intencion: 'saludo', confianza: 95 };
  if (/\b(gracias|muchas?\s?gracias|te\s?agradezco|agradecido|agradecida|thank you|thx|grax|graciasss)\b/i.test(tLower)) return { intencion: 'agradecimiento', confianza: 95 };
  if (/\b(adios|adiós|chao|chau|hasta\s?(luego|pronto|despues|después)|nos\s?vemos|bye|bye bye|me voy|me retiro|me despido|buenas noches)\b/i.test(tLower)) return { intencion: 'despedida', confianza: 95 };

  // ESCENARIO 7: Resolución o cambio de estado
  if (primaryTicket && primaryTicket.assignedTo === context.employeePhone) {
    if (detectResolution(text)) return { intencion: 'resolver_ticket', ticket_id: primaryTicket.id, confianza: 95 };
    const empState = detectEmployeeState(text);
    if (empState) return { intencion: 'cambiar_estado_empleado', estado: empState, ticket_id: primaryTicket.id, confianza: 90 };
  }

  // ESCENARIO 8: Consulta sobre el estado de un ticket
  if (isTicketStatusQuery(text) && primaryTicket) {
    return { intencion: 'consultar_estado_ticket', ticket_id: primaryTicket.id, ticket_tema: primaryTicket.title, ticket_estado: primaryTicket.status, confianza: 90 };
  }

  // ESCENARIO 9: Quejas y escalamientos
  if (isComplaintOrEscalation(text)) {
    return { intencion: 'queja_escalada', descripcion: text, confianza: 95, sentiment: 'frustrated' };
  }

  // ESCENARIO 10: Correcciones
  if (isCorrection(text) && primaryTicket) {
    return { intencion: 'correccion', ticket_id: primaryTicket.id, descripcion: text, confianza: 90 };
  }

  // ESCENARIO 11: Múltiples tickets activos y mensaje ambiguo
  if (activeTickets.length > 1 && t.length < 50) {
    return { intencion: 'clarificar_multi_ticket', tickets: activeTickets, confianza: 90 };
  }

  // ESCENARIO 12: Análisis profundo del ticket activo
  if (primaryTicket && primaryTicket.requesterPhone === context.employeePhone) {
    const analysis = analyzeTicketContext(text, primaryTicket);
    
    if (analysis.action === 'update_ticket') {
      console.log(`   📝 ACLARACIÓN del ticket #T-${primaryTicket.id} (${analysis.reason})`);
      return { intencion: 'aclaracion_automatica', ticket_id: primaryTicket.id, descripcion: text, confianza: 95 };
    }
    
    if (analysis.action === 'new_ticket') {
      console.log(`   🆕 NUEVO TICKET detectado (${analysis.reason})`);
      return { intencion: 'crear_ticket', area: safeArea(text), urgencia: detectUrgencyFromText(text), titulo: text.slice(0, 120), descripcion: text, confianza: 95, es_problema: true };
    }
    
    if (analysis.action === 'ask_clarification') {
      console.log(`   ❓ AMBIGÜEDAD detectada (${analysis.reason}).`);
      return { intencion: 'clarificar_similitud', ticket_id: primaryTicket.id, ticket_tema: primaryTicket.title, ticket_ubicacion: primaryTicket.location || 'ubicación anterior', descripcion: text, confianza: 95 };
    }
    
    if (t.length < 80) {
      return { intencion: 'clarificar_similitud', ticket_id: primaryTicket.id, ticket_tema: primaryTicket.title, ticket_ubicacion: primaryTicket.location || 'ubicación anterior', descripcion: text, confianza: 85 };
    }
  }

  // ESCENARIO 13: Detección de problemas
  const problemKeywords = getProblemKeywords();
  const hasProblemKeyword = problemKeywords.some(pattern => pattern.test(t));
  
  if (hasProblemKeyword && t.length >= 5) {
    return { intencion: 'crear_ticket', area: safeArea(text), urgencia: detectUrgencyFromText(text), titulo: text.slice(0, 120), descripcion: text, confianza: 95, es_problema: true };
  }

  // ESCENARIO 14: Mensajes muy cortos sin contexto
  if (t.length < 15 && !hasProblemKeyword) {
    return { intencion: 'consulta', descripcion: text, confianza: 40 };
  }

  // ESCENARIO 15: Pregunta general
  if (/\?/.test(text) && t.length < 100) {
    return { intencion: 'consulta', descripcion: text, confianza: 60 };
  }

  return { intencion: 'otro', descripcion: text, confianza: 20 };
}

async function detectIntent(text, { employee, activeTickets = [], activeTicket = null, history = [], employeePhone = null }) {
  const tickets = activeTickets.length > 0 ? activeTickets : (activeTicket ? [activeTicket] : []);
  const fallback = fallbackDetectIntent(text, { activeTickets: tickets, activeTicket: tickets[0] || null, employeePhone, employee });

  if (fallback && fallback.confianza >= 75) {
    console.log(`   ✅ Fallback local (${fallback.confianza}%)`);
    return fallback;
  }

  console.log(`   🤖 Usando Gemini...`);
  const historyText = history.slice(-4).map(m => `${m.from === 'bot' ? 'Bot' : 'Usuario'}: ${m.text}`).join(' | ');
  const prompt = `Clasifica el mensaje. Contexto: ${historyText || '(inicio)'}. Mensaje: "${text}". Usuario: ${employee ? employee.name : 'no'}. Tickets activos: ${tickets.length > 0 ? tickets.map(t => `ID:${t.id},titulo:"${t.title}",ubicacion:"${t.location}"`).join(', ') : 'Ninguno'}. Áreas: ${config.areas.join(', ')}. Devuelve JSON: {"intencion":"saludo|crear_ticket|actualizar_ticket|resolver_ticket|aclarar_ticket|clarificar_similitud|clarificar_multi_ticket|consultar_estado_ticket|cancelar_operacion|emoji_o_sin_sentido|queja_escalada|correccion|describir_problema|consulta|agradecimiento|despedida|otro","ticket_id":null,"ticket_tema":"string|null","ticket_ubicacion":"string|null","ticket_estado":"string|null","area":"string|null","urgencia":"baja|media|alta|critica|null","titulo":"string|null","descripcion":"string|null","confianza":0,"es_problema":false,"sentiment":"neutral|frustrated|satisfied"}`;

  const ai = await gemini(prompt, { json: true });
  if (!ai || !ai.intencion) {
    console.log(`   🔄 Fallback por error de Gemini`);
    return fallback || { intencion: 'otro', descripcion: text, confianza: 20 };
  }

  const merged = { ...fallback, ...ai };
  merged.area = safeArea(merged.area) || (fallback ? fallback.area : null);
  merged.urgencia = merged.urgencia || detectUrgencyFromText(text);
  merged.confianza = Number(merged.confianza) || (fallback ? fallback.confianza : 50);

  if (merged.intencion === 'aclarar_ticket' && tickets.length === 1) {
    merged.intencion = 'actualizar_ticket';
    merged.ticket_id = tickets[0].id;
  }
  return merged;
}

async function generateResponse({ intent, employee, activeTickets = [], activeTicket = null, userMessage, context = {}, history = [] }) {
  const tickets = activeTickets.length > 0 ? activeTickets : (activeTicket ? [activeTicket] : []);

  if (['saludo', 'agradecimiento', 'despedida'].includes(intent.intencion)) {
    return getRandomResponse(intent.intencion === 'saludo' && employee ? 'saludo_registrado' : intent.intencion, { nombre: employee?.name || '' });
  }

  if (intent.intencion === 'describir_problema') return getRandomResponse('describir_problema');
  if (intent.intencion === 'cancelar_operacion') return getRandomResponse('rechazo');
  if (intent.intencion === 'emoji_o_sin_sentido') return getRandomResponse('emoji_solo');
  if (intent.intencion === 'queja_escalada') return getRandomResponse('queja_escalada');
  if (intent.intencion === 'correccion') return getRandomResponse('correccion');
  
  if (intent.intencion === 'clarificar_similitud') {
    return `Veo que ya tienes un ticket activo sobre: "${intent.ticket_tema}" en ${intent.ticket_ubicacion}.\n\n¿Te refieres a ese mismo problema, o es un problema nuevo con otro equipo/lugar?\n\n(Por favor, respóndeme "es el mismo" o "es nuevo")`;
  }

  if (intent.intencion === 'clarificar_multi_ticket') {
    const ticketList = (intent.tickets || tickets).map((t, i) => `${i + 1}. ${t.ticketId || `T-${t.id}`} - ${t.title}`).join('\n');
    return `Tienes varios tickets activos:\n${ticketList}\n\n¿A cuál te refieres? (Dime el número o el nombre del problema)`;
  }

  if (intent.intencion === 'consultar_estado_ticket') {
    const estadoMap = { 'abierta': 'Abierto ⏳', 'en_progreso': 'En Progreso 🔧', 'cerrada': 'Cerrado ✅' };
    return `Tu ticket sobre "${intent.ticket_tema}" está en estado: ${estadoMap[intent.ticket_estado] || intent.ticket_estado}. ¿Necesitas algo más?`;
  }

  if (intent.confianza < 50 && intent.intencion === 'otro') return getRandomResponse('no_entendido');
  if (intent.confianza < 50 && intent.intencion === 'consulta') return '¿Podrías darme un poco más de detalle para ayudarte mejor?';

  if (intent.intencion === 'crear_ticket' && intent.es_problema) {
    const location = detectLocation(userMessage);
    if (!location) return getRandomResponse('pedir_ubicacion');
    return getRandomResponse('problema_detectado');
  }

  if (intent.intencion === 'resolver_ticket' && intent.ticket_id) {
    return `¡Excelente! Procedo a marcar el ticket #${intent.ticket_id} como resuelto. ¿Necesitas algo más?`;
  }

  if ((intent.intencion === 'actualizar_ticket' || intent.intencion === 'aclaracion_automatica') && intent.ticket_id) {
    return `Entendido. Agrego esta información al ticket #${intent.ticket_id} y notifico al equipo.`;
  }

  switch (intent.intencion) {
    case 'crear_ticket': return getRandomResponse('problema_detectado');
    case 'actualizar_ticket': case 'aclaracion_automatica': return 'Listo, tomé nota y lo agrego al ticket.';
    case 'consulta': return '¿Puedes darme más detalles?';
    default: return getRandomResponse('no_entendido');
  }
}

module.exports = {
  detectIntent, generateResponse, extractRegistrationData, safeArea, detectUrgencyFromText,
  getRandomResponse, setCustomMessages, detectResolution, detectEmployeeState, detectLocation,
  isValidLocation, analyzeTicketContext, isMixedGreeting, detectConfirmationResponse,
  isEmojiOrNonsense, isTicketStatusQuery, detectMessageType, isForwarded, isReply, isEdited,
  extractTechnicalInfo, detectMultipleProblems, extractTemporalReferences, isActionRequest,
  isComplaintOrEscalation, isTestMessage, isOutOfHours, isCorrection, analyzeSentiment
};