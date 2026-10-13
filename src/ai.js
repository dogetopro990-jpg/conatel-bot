const config = require('./config');
const { normalizeText, parseTicketTag } = require('./utils');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

async function gemini(prompt, { json = true } = {}) {
  if (!config.geminiApiKey) {
    console.log(`   ⚠️  Gemini: sin API key, usando fallback`);
    return null;
  }

  const url = `${API_BASE}/${config.geminiModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 1024 }
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

// Fallback sin IA - detecta patrones básicos
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
  if (/\b(gracias|muchas\s?gracias|te\s?agradezco|grac)\b/.test(t)) {
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

async function generateResponse({ intent, employee, activeTicket, userMessage, context = {} }) {
  const prompt = `
Eres un asistente humano de CONATEL por WhatsApp. Respondes de forma natural, amable y profesional, como una persona real.
NO uses emojis excesivos. NO suenes robótico. Sé breve y directo.

Situación actual:
- Mensaje del usuario: ${JSON.stringify(userMessage)}
- Intención detectada: ${intent.intencion}
- Usuario registrado: ${employee ? `${employee.name}, área ${employee.area}, cargo ${employee.role}` : 'NO registrado aún'}
- Ticket activo: ${activeTicket ? `#${activeTicket.id} - ${activeTicket.title} (${activeTicket.area}, ${activeTicket.status})` : 'ninguno'}
- Área detectada: ${intent.area || 'no definida'}
- Urgencia detectada: ${intent.urgencia || 'no definida'}
- Contexto adicional: ${JSON.stringify(context)}

Reglas de respuesta:
1. Si es SALUDO: saluda de vuelta brevemente y pregunta en qué puedes ayudar.
2. Si es REGISTRO y faltan datos: pide amablemente los datos faltantes (nombre, área, cargo).
3. Si es REGISTRO completo: confirma el registro y pregunta si necesita algo más.
4. Si es CREAR_TICKET sin datos suficientes: pide más detalles del problema.
5. Si es CREAR_TICKET claro: confirma que se creó el ticket con su número y área.
6. Si es ACTUALIZAR_TICKET: confirma que se agregó la información al ticket.
7. Si es ACLARACION: confirma que tomaste nota y la agregarás al ticket.
8. Si es CONSULTA: responde brevemente o indica que consultarás con el área correspondiente.
9. Si es AGRADECIMIENTO: responde de forma amable ("con gusto", "para eso estamos").
10. Si es DESPEDIDA: despídete brevemente.
11. Si es OTRO: pide amablemente que aclare qué necesita.

NO inventes números de ticket. NO prometas tiempos específicos.
Responde en máximo 3 líneas. Sin markdown. Sin listas largas.
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
      return 'Hola, soy el asistente de CONATEL. ¿En qué te puedo ayudar hoy?';
    case 'agradecimiento':
      return 'Con gusto. ¿Necesitas algo más?';
    case 'despedida':
      return 'Hasta luego. Cualquier cosa aquí estoy.';
    case 'registro':
      return 'Para registrarte necesito tu nombre, área (soporte, infraestructura o desarrollo) y cargo.';
    case 'crear_ticket':
      if (intent.area) {
        return `Entiendo, es un tema de ${intent.area}. ¿Puedes darme más detalles del problema?`;
      }
      return 'Cuéntame un poco más sobre el problema para crear el ticket.';
    case 'actualizar_ticket':
    case 'aclaracion':
      return 'Listo, tomé nota y lo agrego al ticket.';
    case 'consulta':
      return 'Déjame revisar eso. ¿Puedes darme más detalles?';
    default:
      // Respuestas inteligentes por contenido
      if (/\?/.test(userMessage)) {
        return 'Déjame revisar eso. ¿Puedes darme más detalles?';
      }
      if (/(no|error|falla|problema)/.test(t)) {
        return 'Entiendo que tienes un problema. ¿Puedes describirme qué está pasando?';
      }
      return 'No entendí bien. ¿Podrías explicarme qué necesitas?';
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