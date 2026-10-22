const config = require('./config');
const { nowISO } = require('./utils');

let pendingNotifications = [];

const CLOSE_NOTIFICATIONS = [
  '¡Hola {nombre}! Ya resolvimos tu solicitud del ticket #{id}. Si necesitas algo más, avísame.',
  'Hola {nombre}, te cuento que ya solucionamos lo del ticket #{id}. Cualquier cosa, aquí estoy.',
  '¡{nombre}! Buenas noticias: tu ticket #{id} ya está resuelto. Si algo más surge, escríbeme.',
  'Hola {nombre}, ya quedó listo lo del ticket #{id}. Si tienes otra duda, no dudes en escribirme.',
  '¡Listo {nombre}! El ticket #{id} ya fue resuelto. Si necesitas ayuda con algo más, avísame.',
  '{nombre}, te aviso que ya solucionamos tu solicitud #{id}. ¿Necesitas algo más?',
  'Hola {nombre}, ya resolvimos el ticket #{id}. Si el problema persiste, respóndeme y lo revisamos.',
  '¡{nombre}! Ya está resuelto lo del ticket #{id}. Si tienes otra consulta, aquí estoy para ayudarte.'
];

const ASSIGNMENT_NOTIFICATIONS = [
  '📋 Nueva solicitud asignada\n\nTicket #{id}: {title}\nÁrea: {area}\nUrgencia: {urgency}\nSolicitante: {requester}\n\nDescripción:\n{description}',
  '🔔 Te asignaron un ticket\n\n#{id} - {title}\nÁrea: {area} | Urgencia: {urgency}\nDe: {requester}\n\n{description}',
  '⚡ Nueva tarea para ti\n\nTicket #{id}: {title}\nÁrea: {area} | Prioridad: {urgency}\nSolicitante: {requester}\n\n{description}'
];

function getRandomCloseNotification(nombre, ticketId, observaciones) {
  let template = CLOSE_NOTIFICATIONS[Math.floor(Math.random() * CLOSE_NOTIFICATIONS.length)];
  let message = template
    .replace('{nombre}', nombre)
    .replace('{id}', ticketId);
  
  if (observaciones) {
    message += `\n\n📝 Observaciones:\n${observaciones}`;
  }
  
  return message;
}

function getRandomAssignmentNotification(ticket) {
  const template = ASSIGNMENT_NOTIFICATIONS[Math.floor(Math.random() * ASSIGNMENT_NOTIFICATIONS.length)];
  return template
    .replace('{id}', ticket.id)
    .replace('{title}', ticket.title)
    .replace('{area}', ticket.area)
    .replace('{urgency}', ticket.urgency)
    .replace('{requester}', `${ticket.requesterName} (${ticket.requesterPhone})`)
    .replace('{description}', ticket.description);
}

function createTicket({ store, chatId, senderPhone, senderName, classification, originalText }) {
  const tickets = Object.values(store.data.tickets);
  const id = tickets.length ? Math.max(...tickets.map(t => t.id)) + 1 : 1;

  const ticket = {
    id,
    chatId,
    requesterPhone: senderPhone,
    requesterName: senderName,
    title: classification.titulo || originalText.slice(0, 120),
    description: classification.descripcion || originalText,
    area: classification.area || config.areas[0] || 'DISET',
    urgency: classification.urgencia || 'media',
    status: 'abierta',
    assignedTo: null,
    priorityLevel: 'media',
    score: 0,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    messages: [{
      from: senderPhone,
      name: senderName,
      text: originalText,
      kind: 'mensaje',
      at: nowISO()
    }]
  };

  store.data.tickets[String(id)] = ticket;
  store.setActiveTicket(`${chatId}:${senderPhone}`, id, new Date(Date.now() + config.activeTicketTtlMs).toISOString());

  return ticket;
}

function appendUpdate({ store, ticket, fromPhone, fromName, text, changes = {} }) {
  Object.assign(ticket, changes);
  ticket.updatedAt = nowISO();

  ticket.messages.push({
    from: fromPhone,
    name: fromName,
    text,
    kind: changes.kind || 'nota',
    at: nowISO()
  });

  return ticket;
}

function autoAssignAndNotify({ store, ticket, sendText, logger, delayMs = 600000 }) {
  const employees = Object.values(store.data.employees).filter(e => e.area === ticket.area);

  if (employees.length === 0) {
    console.log(`   ⚠️  No hay empleados en área ${ticket.area} para asignar`);
    return null;
  }

  const assignee = employees[0];
  ticket.assignedTo = assignee.phone;
  ticket.status = 'en_progreso';

  console.log(`   👤 Asignado a: ${assignee.name} (${assignee.phone})`);

  const notificationTime = Date.now() + delayMs;
  pendingNotifications.push({
    ticketId: ticket.id,
    assigneePhone: assignee.phone,
    assigneeName: assignee.name,
    scheduledAt: notificationTime,
    sent: false
  });

  console.log(`   ⏰ Notificación programada para ${new Date(notificationTime).toLocaleString()}`);

  return assignee;
}

async function processPendingNotifications({ store, sendText, logger }) {
  const now = Date.now();
  const toSend = pendingNotifications.filter(n => !n.sent && n.scheduledAt <= now);

  for (const notification of toSend) {
    const ticket = store.getTicket(notification.ticketId);
    if (!ticket || ticket.status === 'cerrada') {
      notification.sent = true;
      continue;
    }

    const message = getRandomAssignmentNotification(ticket);

    try {
      const sent = await sendText(`${notification.assigneePhone}@s.whatsapp.net`, message);
      if (sent) {
        console.log(`   📤 Notificación enviada a ${notification.assigneeName} por ticket #T-${ticket.id}`);
        notification.sent = true;
      }
    } catch (error) {
      logger?.error({ err: error.message }, 'Error enviando notificación');
    }
  }

  pendingNotifications = pendingNotifications.filter(n => !n.sent || n.scheduledAt > now - 3600000);
}

async function notifyRequesterOnClose({ ticket, sendText, logger, observaciones = null }) {
  if (!ticket.requesterPhone) {
    console.log(`   ⚠️  No se puede notificar cierre: falta el teléfono del solicitante en #T-${ticket.id}`);
    return;
  }

  const firstName = (ticket.requesterName || 'Usuario').split(' ')[0];
  const message = getRandomCloseNotification(firstName, ticket.id, observaciones);

  try {
    const sent = await sendText(`${ticket.requesterPhone}@s.whatsapp.net`, message);
    if (sent) {
      console.log(`   📤 Notificación de cierre enviada a ${firstName} (#T-${ticket.id})`);
    }
  } catch (error) {
    logger?.error({ err: error.message }, 'Error enviando notificación de cierre');
  }
}

module.exports = {
  createTicket,
  appendUpdate,
  autoAssignAndNotify,
  processPendingNotifications,
  notifyRequesterOnClose
};