const config = require('./config');
const { nowISO } = require('./utils');

let pendingNotifications = [];

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
    area: classification.area || 'soporte',
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

    const message = [
      `🔔 Nueva solicitud asignada`,
      ``,
      `Ticket #T-${ticket.id}: ${ticket.title}`,
      `Área: ${ticket.area}`,
      `Urgencia: ${ticket.urgency}`,
      `Solicitante: ${ticket.requesterName} (${ticket.requesterPhone})`,
      ``,
      `Descripción:`,
      ticket.description
    ].join('\n');

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

// ... (todo el código anterior de createTicket, appendUpdate, etc. se mantiene igual)

async function notifyRequesterOnClose({ ticket, sendText, logger }) {
  if (!ticket.requesterPhone) {
    console.log(`   ⚠️  No se puede notificar cierre: falta el teléfono del solicitante en #T-${ticket.id}`);
    return;
  }

  const message = [
    `✅ ¡Hola ${ticket.requesterName}!`,
    ``,
    `Te informamos que tu solicitud ha sido resuelta.`,
    `🎫 Ticket: #T-${ticket.id} - ${ticket.title}`,
    ``,
    `Si el problema persiste, por favor responde a este mensaje para que lo revisemos de nuevo.`,
    `¡Gracias por usar el sistema de soporte de CONATEL!`
  ].join('\n');

  try {
    const sent = await sendText(`${ticket.requesterPhone}@s.whatsapp.net`, message);
    if (sent) {
      console.log(`   📤 Notificación de cierre enviada a ${ticket.requesterName} (#T-${ticket.id})`);
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
  notifyRequesterOnClose // <-- NUEVA EXPORTACIÓN
};