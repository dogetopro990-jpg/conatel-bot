const config = require('./config');
const { nowISO } = require('./utils');
const { refreshPriority } = require('./priority');

function createTicket({ store, chatId, senderPhone, senderName, classification, originalText }) {
  const area = config.areas.includes(classification.area)
    ? classification.area
    : 'soporte';

  const urgency = ['baja', 'media', 'alta', 'critica'].includes(classification.urgencia)
    ? classification.urgencia
    : 'media';

  const title = (classification.titulo || originalText || 'Solicitud').slice(0, 120);
  const description = classification.descripcion || originalText || '';

  const ticket = store.createTicket({
    chatId,
    requesterPhone: senderPhone,
    requesterName: senderName || senderPhone,
    area,
    urgency,
    title,
    description,
    source: chatId.endsWith('@g.us') ? 'grupo' : 'privado',
    assignedTo: null,
    messages: [
      {
        from: senderPhone,
        name: senderName || senderPhone,
        text: originalText || '',
        at: nowISO(),
        kind: 'creacion'
      }
    ]
  });

  refreshPriority(ticket);

  store.setActiveTicket(
    `${chatId}:${senderPhone}`,
    ticket.id,
    new Date(Date.now() + config.activeTicketTtlMs).toISOString()
  );

  return ticket;
}

function appendUpdate({ store, ticket, fromPhone, fromName, text, changes = {} }) {
  store.addTicketMessage(ticket.id, {
    from: fromPhone,
    name: fromName || fromPhone,
    text,
    kind: changes.kind || 'actualizacion'
  });

  const patch = {};

  if (changes.area && config.areas.includes(changes.area)) {
    patch.area = changes.area;
  }

  if (changes.urgency && ['baja', 'media', 'alta', 'critica'].includes(changes.urgencia)) {
    patch.urgency = changes.urgency;
  }

  if (changes.status) {
    patch.status = changes.status;
  }

  if (changes.assignedTo !== undefined) {
    patch.assignedTo = changes.assignedTo;
  }

  store.updateTicket(ticket.id, patch);

  const updated = store.getTicket(ticket.id);
  refreshPriority(updated);

  return updated;
}

module.exports = {
  createTicket,
  appendUpdate
};