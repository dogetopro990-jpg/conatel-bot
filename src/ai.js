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

  try {
    return JSON.parse(cleaned);
  } catch {}

  const fence = cleaned.match(/```(?:json)?([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {}
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }

  return null;
}

async function gemini(prompt, { json = true } = {}) {
  if (!config.geminiApiKey) return null;

  const url = `${API_BASE}/${config.geminiModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024
    }
  };

  if (json) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) return null;

    const data = await response.json();
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .join('') || '';

    return json ? extractJson(text) : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackClassify(text = '') {
  const t = normalizeText(text);

  const result = {
    accion: 'otro',
    area: null,
    urgencia: 'media',
    titulo: '',
    descripcion: String(text).slice(0, 500),
    ticket_id: parseTicketTag(text),
    confianza: 25
  };

  if (result.ticket_id) {
    result.accion = 'actualizar_ticket';
  }

  if (/(soporte|cuenta|correo|contrasena|usuario|office|excel|word|impresora|acceso)/.test(t)) {
    result.area = 'soporte';
  }

  if (/(infraestructura|red|internet|wifi|servidor|cable|switch|router|vpn|dominio|ip)/.test(t)) {
    result.area = 'infraestructura';
  }

  if (/(desarrollo|software|aplicacion|sistema|bug|api|base de datos|deploy|despliegue|codigo)/.test(t)) {
    result.area = 'desarrollo';
  }

  if (/(caida|sin servicio|no funciona|no hay acceso|produccion|critico|urgente|inmediato|bloquea|fuego)/.test(t)) {
    result.urgencia = 'critica';
  } else if (/(importante|pronto|afecta|hoy|prioridad)/.test(t)) {
    result.urgencia = 'alta';
  } else if (/(consulta|duda|informacion|baja|cuando)/.test(t)) {
    result.urgencia = 'baja';
  }

  const hasRequest =
    /(ayuda|problema|error|falla|solicitud|requerimiento|ticket|reporte|necesito|no puedo|no funciona|habilitar|acceso|crear|revisar|configurar)/.test(t);

  if (!result.ticket_id && hasRequest && String(text).trim().length >= 12) {
    result.accion = 'crear_ticket';
  }

  if (result.accion === 'crear_ticket' && !result.titulo) {
    result.titulo = String(text).slice(0, 90);
  }

  return result;
}

async function classifyMessage(text, { activeTicketId = null } = {}) {
  const fallback = fallbackClassify(text);

  const prompt = `
Clasifica el siguiente mensaje de WhatsApp para el sistema de tickets de CONATEL.

Devuelve SOLO JSON válido, sin markdown, sin comentarios.

Usa exactamente este esquema:
{
  "accion": "crear_ticket|actualizar_ticket|consulta|registro|otro",
  "area": "soporte|infraestructura|desarrollo|null",
  "urgencia": "baja|media|alta|critica|null",
  "titulo": "string",
  "descripcion": "string",
  "ticket_id": null,
  "confianza": 0
}

Reglas:
1. area puede ser soporte, infraestructura o desarrollo.
2. urgencia critica si hay caida, produccion, bloqueo total, sin servicio o riesgo alto.
3. urgencia alta si afecta operación o necesita atención pronta.
4. urgencia media si es un problema normal.
5. urgencia baja si es consulta o solicitud simple.
6. ticket_id debe ser número si el usuario menciona algo como #T-123.
7. titulo debe ser corto y claro.
8. descripcion debe resumir el problema.
9. Si el mensaje parece una aclaración de algo anterior, usa accion actualizar_ticket.
10. Si parece una solicitud nueva, usa accion crear_ticket.

Mensaje del usuario: ${JSON.stringify(String(text))}
  `.trim();

  const ai = await gemini(prompt, { json: true });

  const merged = {
    ...fallback,
    ...(ai || {})
  };

  if (typeof merged.ticket_id === 'string') {
    merged.ticket_id = Number(merged.ticket_id.replace(/\D/g, '')) || null;
  }

  if (!merged.ticket_id && activeTicketId && ['actualizar_ticket', 'otro', 'consulta'].includes(merged.accion)) {
    merged.ticket_id = activeTicketId;
  }

  if (activeTicketId && merged.accion === 'otro' && String(text).trim().length <= 300) {
    merged.accion = 'actualizar_ticket';
    merged.ticket_id = activeTicketId;
    merged.confianza = Math.max(Number(merged.confianza) || 0, 60);
  }

  merged.area = safeArea(merged.area || fallback.area);

  if (!['crear_ticket', 'actualizar_ticket', 'consulta', 'registro', 'otro'].includes(merged.accion)) {
    merged.accion = fallback.accion;
  }

  if (!['baja', 'media', 'alta', 'critica'].includes(merged.urgencia)) {
    merged.urgencia = fallback.urgencia || 'media';
  }

  merged.confianza = Number(merged.confianza) || 0;

  return merged;
}

function fallbackRegistration(text = '') {
  const raw = String(text).replace(/\n/g, ',');
  const parts = raw.split(/[,;]/).map((part) => part.trim()).filter(Boolean);

  const area = safeArea(raw);
  let nombre = null;
  let cargo = null;

  for (const part of parts) {
    const maybeArea = safeArea(part);
    const maybeRole = /(cargo|jefe|analista|ingenier|tecnico|gerente|asistente|coordinador|developer|desarrollador|admin|consultor|soporte)/i.test(part);

    if (!maybeArea && !maybeRole && part.length > 3 && !nombre) {
      nombre = part;
    } else if (maybeRole && !cargo) {
      cargo = part;
    }
  }

  if (!cargo && parts.length >= 3) {
    cargo = parts[parts.length - 1];
  }

  if (!nombre && parts.length >= 1) {
    nombre = parts[0];
  }

  return {
    nombre,
    area,
    cargo
  };
}

async function extractRegistration(text) {
  const fallback = fallbackRegistration(text);

  const prompt = `
Extrae datos de registro de un empleado para CONATEL.

Devuelve SOLO JSON válido.

Usa exactamente este esquema:
{
  "nombre": "string|null",
  "area": "soporte|infraestructura|desarrollo|null",
  "cargo": "string|null"
}

Texto del usuario: ${JSON.stringify(String(text))}
  `.trim();

  const ai = await gemini(prompt, { json: true });

  return {
    nombre: ai?.nombre || fallback.nombre || null,
    area: safeArea(ai?.area || fallback.area),
    cargo: ai?.cargo || fallback.cargo || null
  };
}

module.exports = {
  classifyMessage,
  extractRegistration,
  safeArea
};