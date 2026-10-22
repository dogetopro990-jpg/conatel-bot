const { minutesSince } = require('./utils');

const URGENCY_SCORE = {
  baja: 5,
  media: 25,
  alta: 50,
  critica: 75
};

function calculateScore(ticket) {
  // Score base por urgencia
  const urgencyScore = URGENCY_SCORE[ticket.urgency] ?? 20;

  // Score por antigüedad (más reactivo: cada 5 minutos en vez de 10)
  const ageScore = Math.min(
    25,
    Math.floor(minutesSince(ticket.updatedAt || ticket.createdAt) / 5) * 2
  );

  // Score por insistencia del SOLICITANTE (no todos los mensajes)
  const requesterMessages = ticket.messages.filter(
    m => m.from === ticket.requesterPhone
  ).length;
  const insistenceScore = Math.min(15, requesterMessages * 3);

  // Score por estado
  const statusScore = ticket.status === 'en_progreso' ? 5 : 0;

  // Bonus por tiempo sin asignar (si lleva más de 30 min sin asignar)
  let unassignedBonus = 0;
  if (!ticket.assignedTo) {
    const minutesUnassigned = minutesSince(ticket.createdAt);
    if (minutesUnassigned > 30) {
      unassignedBonus = Math.min(10, Math.floor((minutesUnassigned - 30) / 10));
    }
  }

  const totalScore = Math.min(
    100,
    urgencyScore + ageScore + insistenceScore + statusScore + unassignedBonus
  );

  return totalScore;
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