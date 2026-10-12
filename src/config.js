require('dotenv').config();

const cleanPhone = (value = '') => String(value).replace(/\D/g, '');

module.exports = {
  ownerPhones: (process.env.OWNER_PHONES || '')
    .split(',')
    .map(cleanPhone)
    .filter(Boolean),

  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  dataFile: process.env.DATA_FILE || 'data.json',
  authFolder: process.env.AUTH_FOLDER || 'auth_info',

  alertIntervalMs: Number(process.env.ALERT_INTERVAL_MS || 5 * 60 * 1000),
  minDelayMs: Number(process.env.MIN_DELAY_MS || 3500),
  maxDelayMs: Number(process.env.MAX_DELAY_MS || 8000),
  priorityThreshold: Number(process.env.PRIORITY_THRESHOLD || 70),
  activeTicketTtlMs: Number(process.env.ACTIVE_TICKET_TTL_MS || 15 * 60 * 1000),

  botName: process.env.BOT_NAME || 'CONATEL Bot',
  areas: ['soporte', 'infraestructura', 'desarrollo'],

  isOwner(phone) {
    return this.ownerPhones.includes(cleanPhone(phone));
  }
};