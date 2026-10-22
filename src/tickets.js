const config = require('./config');
const { nowISO } = require('./utils');

let pendingNotifications = [];

// ============ ESTADOS DE EMPLEADOS ============
const employeeStates = new Map();

function getEmployeeState(phone) {
  return employeeStates.get(phone) || { state: 'disponible', ticketId: null, since: null };
}

function setEmployeeState(phone, state, ticketId = null) {
  employeeStates.set(phone, {
    state,
    ticketId,
    since: Date.now()
  });
  console.log(`   👤 Estado de ${phone} cambiado a: ${state}${ticketId ? ` (ticket #T-${ticketId})` : ''}`);
}

function isEmployeeAvailable(phone) {
  const state = getEmployeeState(phone);
  return state.state === 'disponible';
}

// ============ MENSAJES NATURALES ============

function getNaturalAssignmentMessage(ticket, assigneeName) {
  const firstName = (ticket.requesterName || 'alguien').split(' ')[0];
  const messages = [
    `Hola ${assigneeName.split(' ')[0]}, hay un problema en ${ticket.area}. ${firstName} reporta que ${ticket.title.toLowerCase()}. ¿Podrías revisarlo?`,
    `${assigneeName.split(' ')[0]}, te asignaron un ticket. ${firstName} dice que ${ticket.title.toLowerCase()}. Es del área de ${ticket.area}.`,
    `Hola ${assigneeName.split(' ')[0]}, ${firstName} necesita ayuda con algo en ${ticket.area}. Dice que ${ticket.title.toLowerCase()}. Échale un ojo cuando puedas.`,
    `${assigneeName.split(' ')[0]}, hay un problema en ${ticket.area}. ${firstName} lo reportó: ${ticket.title.toLowerCase()}. Avísame si necesitas más detalles.`
  ];
  return messages[Math.floor(Math.random() * messages.length)];
}

function getNaturalCloseMessage(ticket, observaciones) {
  const firstName = (ticket.requesterName || 'Usuario').split(' ')[0];
  let message = `Hola ${firstName}, ya resolvimos tu solicitud sobre "${ticket.title}". `;
  
  if (observaciones) {
    message += observaciones;
  } else {
    const endings = [
      'Si necesitas algo más, avísame.',
      'Cualquier cosa, aquí estoy.',
      'Si algo más surge, escríbeme.',
      '¿Necesitas algo más?'
    ];
    message += endings[Math.floor(Math.random() * endings.length)];
  }
  
  return message;
}

function getFollowUpMessage(ticket, assigneeName) {
  const messages = [
    `${assigneeName.split(' ')[0]}, ¿cómo vas con el ticket #T-${ticket.id}? ¿Necesitas ayuda?`,
    `Hola ${assigneeName.split(' ')[0]}, ¿cómo va lo del ticket #T-${ticket.id}? Avísame si necesitas algo.`,
    `${assigneeName.split(' ')[0]}, ¿pudiste revisar el ticket #T-${ticket.id}? Cuéntame cómo vas.`,
    `Hola ${assigneeName.split(' ')[0]}, solo para saber cómo va lo del ticket #T-${ticket.id}. ¿Todo bien?`
  ];
  return messages[Math.floor(Math.random() * messages.length)];
}

// ============ CREAR TICKET ============

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
    location: classification.location || null,
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

// ============ REENUMERAR TICKETS ============

function renumberTickets(store) {
  const tickets = Object.values(store.data.tickets).sort((a, b) => a.id - b.id);
  
  const newTickets = {};
  tickets.forEach((ticket, index) => {
    const newId = index + 1;
    if (newId !== ticket.id) {
      console.log(`   🔄 Ticket #T-${ticket.id} renumerado a #T-${newId}`);
    }
    ticket.id = newId;
    newTickets[String(newId)] = ticket;
  });
  
  store.data.tickets = newTickets;
}

// ============ ACTUALIZAR TICKET ============

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

// ============ ASIGNAR EMPLEADO ============

function autoAssignAndNotify({ store, ticket, sendText, logger, delayMs = 600000 }) {
  const availableEmployees = Object.values(store.data.employees)
    .filter(e => e.area === ticket.area && isEmployeeAvailable(e.phone));

  if (availableEmployees.length === 0) {
    console.log(`   ⚠️  No hay empleados disponibles en área ${ticket.area}`);
    const allEmployees = Object.values(store.data.employees).filter(e => e.area === ticket.area);
    if (allEmployees.length === 0) {
      console.log(`   ⚠️  No hay empleados en área ${ticket.area} para asignar`);
      return null;
    }
    const assignee = allEmployees.sort((a, b) => {
      const stateA = getEmployeeState(a.phone);
      const stateB = getEmployeeState(b.phone);
      return (stateA.since || 0) - (stateB.since || 0);
    })[0];
    
    ticket.assignedTo = assignee.phone;
    console.log(`   👤 Asignado a: ${assignee.name} (está ocupado, pero es el menos ocupado)`);
    return assignee;
  }

  const assignee = availableEmployees.sort((a, b) => {
    const stateA = getEmployeeState(a.phone);
    const stateB = getEmployeeState(b.phone);
    return (stateA.since || 0) - (stateB.since || 0);
  })[0];

  ticket.assignedTo = assignee.phone;
  ticket.status = 'en_progreso';
  
  setEmployeeState(assignee.phone, 'trabajando', ticket.id);

  console.log(`   👤 Asignado a: ${assignee.name} (${assignee.phone})`);

  const notificationTime = Date.now() + delayMs;
  pendingNotifications.push({
    ticketId: ticket.id,
    assigneePhone: assignee.phone,
    assigneeName: assignee.name,
    scheduledAt: notificationTime,
    sent: false,
    isFollowUp: false
  });

  console.log(`   ⏰ Notificación programada para ${new Date(notificationTime).toLocaleString()}`);

  return assignee;
}

// ============ PROCESAR NOTIFICACIONES ============

async function processPendingNotifications({ store, sendText, logger }) {
  const now = Date.now();
  const toSend = pendingNotifications.filter(n => !n.sent && n.scheduledAt <= now);

  for (const notification of toSend) {
    const ticket = store.getTicket(notification.ticketId);
    if (!ticket || ticket.status === 'cerrada') {
      notification.sent = true;
      continue;
    }

    const employeeState = getEmployeeState(notification.assigneePhone);
    
    let message;
    if (employeeState.state === 'trabajando') {
      message = getFollowUpMessage(ticket, notification.assigneeName);
      console.log(`   🔄 Enviando seguimiento a ${notification.assigneeName} (está trabajando)`);
    } else {
      message = getNaturalAssignmentMessage(ticket, notification.assigneeName);
      console.log(`   📤 Enviando asignación natural a ${notification.assigneeName}`);
    }

    try {
      const sent = await sendText(`${notification.assigneePhone}@s.whatsapp.net`, message);
      if (sent) {
        console.log(`   ✅ Mensaje enviado a ${notification.assigneeName} por ticket #T-${ticket.id}`);
        notification.sent = true;
      }
    } catch (error) {
      logger?.error({ err: error.message }, 'Error enviando notificación');
    }
  }

  pendingNotifications = pendingNotifications.filter(n => !n.sent || n.scheduledAt > now - 3600000);
}

// ============ NOTIFICAR CIERRE ============

async function notifyRequesterOnClose({ ticket, sendText, logger, observaciones = null, store }) {
  const settings = store?.getSettings();
  if (settings && settings.notifyRequester === false) {
    console.log(`   ⏸️  Notificación al solicitante desactivada`);
    return;
  }

  if (!ticket.requesterPhone) {
    console.log(`   ⚠️  No se puede notificar cierre: falta el teléfono del solicitante en #T-${ticket.id}`);
    return;
  }

  const message = getNaturalCloseMessage(ticket, observaciones);

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
  notifyRequesterOnClose,
  renumberTickets,
  getEmployeeState,
  setEmployeeState,
  isEmployeeAvailable,
  getNaturalAssignmentMessage,
  getFollowUpMessage
};