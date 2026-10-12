const { minutesSince } = require('./utils');

const URGENCY_SCORE = {
  baja: 5,
  media: 25,
  alta: 50,
  critica: 75
};

function calculateScore(ticket) {
  const urgencyScore = URGENCY_SCORE[ticket.urgency] ?? 20;

  const ageScore = Math.min(
    25,
    Math.floor(minutesSince(ticket.updatedAt || ticket.createdAt) / 10) * 3
  );

  const messageScore = Math.min(10, ticket.messages.length);
  const statusScore = ticket.status === 'en_progreso' ? 5 : 0;

  return Math.min(100, urgencyScore + ageScore + messageScore + statusScore);
}

function scoreToLevel(score) {
  if (score >= 85) return 'critica';
  if (score >= 65) return 'alta';
  if (score >= 35) return 'media';
  return 'baja';
}

function refreshPriority(ticket) {
  ticket.score = calculateScore(ticket);
  ticket.priorityLevel = scoreToLevel(ticket.score);
  return ticket;
}

function cooldownForLevel(level) {
  const cooldowns = {
    critica: 15,
    alta: 30,
    media: 60,
    baja: 120
  };

  return cooldowns[level] || 60;
}

module.exports = {
  calculateScore,
  scoreToLevel,
  refreshPriority,
  cooldownForLevel
};