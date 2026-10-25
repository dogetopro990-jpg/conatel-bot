const config = require('./config');
const { nowISO } = require('./utils');

let pendingNotifications = [];

// ============ ESTADOS DE EMPLEADOS ============
const employeeStates = new Map();

function getEmployeeState(phone) {
  return employeeStates.get(phone) || { state: 'disponible', ticketId: null, since: null };
}

function setEmployeeState(phone, state, ticketId = null) {
  employeeStates.set(phone, { state, ticketId, since: Date.now() });
  console.log(`   👤 Estado de ${phone} cambiado a: ${state}${ticketId ? ` (ticket #T-${ticketId})` : ''}`);
}

function isEmployeeAvailable(phone) {
  const state = getEmployeeState(phone);
  return state.state === 'disponible';
}

// ============ MENSAJES NATURALES ============

function getNaturalAssignmentMessage(ticket, assigneeName) {
  const requesterFirstName = (ticket.requesterName || 'alguien').split(' ')[0];
  const assigneeFirstName = assigneeName.split(' ')[0];
  const location = ticket.location || ticket.area;

  const messages = [
    `Hola ${assigneeFirstName}, ${requesterFirstName} reportó que ${ticket.title.toLowerCase()} en ${location}. ¿Podrías revisarlo?`,
    `${assigneeFirstName}, hay un problema en ${ticket.area}. ${requesterFirstName} dice que ${ticket.title.toLowerCase()}. Está en ${location}.`,
    `Hola ${assigneeFirstName}, te asignaron el ticket ${ticket.ticketId || `T-${ticket.id}`}. ${requesterFirstName} necesita ayuda con ${ticket.title.toLowerCase()} en ${location}.`,
    `${assigneeFirstName}, ${requesterFirstName} tiene un problema: ${ticket.title.toLowerCase()}. Es en ${location}. ¿Puedes echarle un ojo?`
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
    `${assigneeName.split(' ')[0]}, ¿cómo vas con el ticket ${ticket.ticketId || `T-${ticket.id}`}? ¿Necesitas ayuda?`,
    `Hola ${assigneeName.split(' ')[0]}, ¿cómo va lo del ticket ${ticket.ticketId || `T-${ticket.id}`}? Avísame si necesitas algo.`,
    `${assigneeName.split(' ')[0]}, ¿pudiste revisar el ticket ${ticket.ticketId || `T-${ticket.id}`}? Cuéntame cómo vas.`,
    `Hola ${assigneeName.split(' ')[0]}, solo para saber cómo va lo del ticket ${ticket.ticketId || `T-${ticket.id}`}. ¿Todo bien?`
  ];
  return messages[Math.floor(Math.random() * messages.length)];
}

// ============ CREAR TICKET ============

function createTicket({ store, chatId, senderPhone, senderName, classification, originalText }) {
  const tickets = Object.values(store.data.tickets);
  const id = tickets.length ? Math.max(...tickets.map(t => t.id)) + 1 : 1;

  const areaPrefix = (classification.area || 'GEN').substring(0, 3).toUpperCase();
  const ticketId = `${areaPrefix}-${id}`;

  const ticket = {
    id,
    ticketId,
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

  const created = store.createTicket(ticket);
  store.setActiveTicket(`${chatId}:${senderPhone}`, created.id, new Date(Date.now() + config.activeTicketTtlMs).toISOString());

  return created;
}

// ============ REENUMERAR TICKETS ============

function renumberTickets(store) {
  store.renumberTickets();
}

// ============ ACTUALIZAR TICKET ============

function appendUpdate({ store, ticket, fromPhone, fromName, text, changes = {} }) {
  const employee = store.getEmployee(fromPhone);
  const displayName = employee?.name || fromName || 'Usuario';

  // Si es una aclaración, agregarla a la descripción
  if (changes.kind === 'aclaracion' || changes.kind === 'mensaje_pendiente') {
    const timestamp = new Date().toLocaleString('es');
    ticket.description += `\n\n[Actualización ${timestamp}] ${text}`;
  }

  ticket.messages.push({
    from: fromPhone,
    name: displayName,
    text,
    kind: changes.kind || 'nota',
    at: nowISO()
  });

  // Guardar cambios en SQLite
  store.updateTicket(ticket.id, {
    ...changes,
    description: ticket.description,
    updatedAt: nowISO()
  });

  return ticket;
}

// ============ ASIGNAR EMPLEADO ============

function autoAssignAndNotify({ store, ticket, sendText, logger, delayMs = 0 }) {
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

    store.updateTicket(ticket.id, { assignedTo: assignee.phone });
    console.log(`   👤 Asignado a: ${assignee.name} (está ocupado, pero es el menos ocupado)`);
    return assignee;
  }

  const assignee = availableEmployees.sort((a, b) => {
    const stateA = getEmployeeState(a.phone);
    const stateB = getEmployeeState(b.phone);
    return (stateA.since || 0) - (stateB.since || 0);
  })[0];

  store.updateTicket(ticket.id, {
    assignedTo: assignee.phone,
    status: 'en_progreso'
  });

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

  console.log(`   ⏰ Notificación programada para envío inmediato`);

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
        console.log(`   ✅ Mensaje enviado a ${notification.assigneeName} por ticket ${ticket.ticketId || `T-${ticket.id}`}`);
        notification.sent = true;
      }
    } catch (error) {
      logger?.error({ err: error.message }, 'Error enviando notificación');
    }
  }

  pendingNotifications = pendingNotifications.filter(n => !n.sent || n.scheduledAt > now - 3600000);
}

// ============ NOTIFICAR CIERRE (MEJORADO) ============

async function notifyRequesterOnClose({ ticket, sendText, logger, observaciones = null, store }) {
  const settings = store?.getSettings();
  if (settings && settings.notifyRequester === false) {
    return; // Notificaciones desactivadas, salir en silencio
  }

  // 1. Intentar obtener el teléfono del campo principal
  let phone = ticket.requesterPhone;
  
  // 2. FALLBACK: Si no existe, buscarlo en el historial de mensajes del ticket
  if (!phone && ticket.messages && ticket.messages.length > 0) {
    const firstUserMsg = ticket.messages.find(m => 
      m.from && m.from !== 'panel' && m.from !== 'bot' && m.from.length >= 8
    );
    if (firstUserMsg) {
      phone = firstUserMsg.from;
      console.log(`   🔄 Teléfono recuperado del historial para ${ticket.ticketId || `T-${ticket.id}`}`);
    }
  }

  // 3. Si aún no hay teléfono, omitir en silencio (no es un error crítico)
  if (!phone) {
    console.log(`   ℹ️  Sin teléfono para notificar cierre en ${ticket.ticketId || `T-${ticket.id}`}`);
    return;
  }

  const message = getNaturalCloseMessage(ticket, observaciones);

  try {
    const sent = await sendText(`${phone}@s.whatsapp.net`, message);
    if (sent) {
      console.log(`   📤 Notificación de cierre enviada a ${ticket.requesterName || phone} (${ticket.ticketId || `T-${ticket.id}`})`);
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