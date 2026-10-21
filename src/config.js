require('dotenv').config();

function parsePhones(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const ownerPhones = parsePhones(process.env.OWNER_PHONES);

// Áreas por defecto (se pueden modificar desde el panel)
const DEFAULT_AREAS = [
  'DIGER',
  'DISET',
  'DIREM',
  'LEGAL',
  'SECRETARIA',
  'Servicios Generales',
  'Proteccion al usuario',
  'Compras',
  'Bienes',
  'Cartera y cobranza',
  'Contabilidad',
  'Gerencia General',
  'Comision',
  'DIPLADE',
  'Comunicaciones'
];

module.exports = {
  botName: process.env.BOT_NAME || 'CONATEL Bot',
  ownerPhones,
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  areas: DEFAULT_AREAS,
  dataFile: process.env.DATA_FILE || './data/store.json',
  authFolder: process.env.AUTH_FOLDER || './auth_info',
  alertIntervalMs: Number(process.env.ALERT_INTERVAL_MS) || 300000,
  minDelayMs: Number(process.env.MIN_DELAY_MS) || 300,
  maxDelayMs: Number(process.env.MAX_DELAY_MS) || 800,
  priorityThreshold: Number(process.env.PRIORITY_THRESHOLD) || 70,
  activeTicketTtlMs: Number(process.env.ACTIVE_TICKET_TTL_MS) || 900000,
  selfTest: process.env.SELF_TEST === 'true',
  selfTestPrefix: process.env.SELF_TEST_PREFIX || '!',
  logLevel: process.env.LOG_LEVEL || 'info',
  isOwner(phone) {
    return ownerPhones.includes(String(phone || '').trim());
  }
};