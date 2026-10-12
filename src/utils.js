const toPhone = (jid = '') => {
  return String(jid || '')
    .split('@')[0]
    .replace(/\D/g, '');
};

const nowISO = () => new Date().toISOString();

const minutesSince = (iso) => {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return 0;
  return Math.max(0, (Date.now() - time) / 60000);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ticketTag = (id) => `#T-${id}`;

const parseTicketTag = (text = '') => {
  const match = String(text).match(/#t[-\s]?(\d+)/i);
  return match ? Number(match[1]) : null;
};

const truncate = (text, n = 300) => {
  const value = String(text || '');
  return value.length > n ? `${value.slice(0, n)}...` : value;
};

const normalizeText = (text = '') => {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
};

module.exports = {
  toPhone,
  nowISO,
  minutesSince,
  sleep,
  ticketTag,
  parseTicketTag,
  truncate,
  normalizeText
};