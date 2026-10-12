const config = require('./config');
const { refreshPriority, cooldownForLevel } = require('./priority');
const { minutesSince, truncate, ticketTag } = require('./utils');

function startAlerts({ sendText, store, logger }) {
  setInterval(() => {
    runAlerts({ sendText, store, logger }).catch((error) => {
      logger.error(error, 'Error ejecutando alertas');
    });
  }, config.alertIntervalMs);
}

async function runAlerts({ sendText, store, logger }) {
  const settings = store.getSettings();

  if (!settings.autoAlerts) return;

  const threshold = Number(settings.priorityThreshold ?? config.priorityThreshold);

  const openTickets = store
    .listOpenTickets()
    .map((ticket) => refreshPriority(ticket))
    .sort((a, b) => b.score - a.score);

  let alertedCount = 0;

  for (const ticket of openTickets) {
    if (alertedCount >= 5) break;

    const shouldAlert =
      ticket.priorityLevel === 'critica' || ticket.score >= threshold;

    if (!shouldAlert) continue;

    const cooldown = cooldownForLevel(ticket.priorityLevel);

    if (ticket.lastAlertAt && minutesSince(ticket.lastAlertAt) < cooldown) {
      continue;
    }

    const targets = getTargets({ store, ticket, settings });
    if (!targets.length) continue;

    const text = formatAlert(ticket);

    for (const phone of targets) {
      await sendText(`${phone}@s.whatsapp.net`, text);
    }

    store.updateTicket(ticket.id, {
      lastAlertAt: new Date().toISOString()
    });

    await store.save();
    alertedCount += 1;
  }
}

function getTargets({ store, ticket, settings }) {
  const phones = new Set();

  if (ticket.priorityLevel === 'critica') {
    config.ownerPhones.forEach((phone) => phones.add(phone));
  }

  if (settings.areaNotifications?.[ticket.area] !== false) {
    Object.values(store.data.employees)
      .filter((employee) => employee.area === ticket.area && employee.phone)
      .forEach((employee) => phones.add(employee.phone));
  }

  if (ticket.assignedTo) {
    phones.add(ticket.assignedTo);
  }

  return [...phones].filter(Boolean);
}

function formatAlert(ticket) {
  const age = Math.round(minutesSince(ticket.createdAt));

  return [
    `🚨 Alerta CONATEL ${ticketTag(ticket.id)}`,
    `Prioridad: ${ticket.priorityLevel.toUpperCase()} (${ticket.score}/100)`,
    `Área: ${ticket.area}`,
    `Título: ${truncate(ticket.title, 120)}`,
    `Solicitante: ${ticket.requesterName || ticket.requesterPhone}`,
    `Edad: ${age} min`,
    `Estado: ${ticket.status}`,
    '',
    'Responde con el número del ticket para actualizarlo.'
  ].join('\n');
}

module.exports = {
  startAlerts,
  runAlerts
};