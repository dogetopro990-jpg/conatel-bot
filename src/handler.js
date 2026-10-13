const config = require('./config');
const { toPhone, parseTicketTag, ticketTag, truncate, nowISO } = require('./utils');
const { classifyMessage, extractRegistration } = require('./ai');
const { createTicket, appendUpdate } = require('./tickets');
const { refreshPriority } = require('./priority');

class Handler {
  constructor({ store, sendText, logger }) {
    this.store = store;
    this.sendText = sendText;
    this.logger = logger;
  }

  extractText(raw) {
    const message = raw.message || {};

    return (
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      message.documentMessage?.caption ||
      message.buttonsResponseMessage?.selectedButtonId ||
      message.listResponseMessage?.title ||
      ''
    );
  }

     async handleMessage(raw, botPhoneNumber) {
    if (!raw?.key) return;

    const chatId = raw.key.remoteJid;
    if (!chatId || chatId === 'status@broadcast') return;

    const isGroup = chatId.endsWith('@g.us');
    const sender = isGroup ? raw.key.participant : chatId;
    const senderPhone = toPhone(sender);

    if (!senderPhone) return;

    const rawText = this.extractText(raw).trim();
    if (!rawText) return;

    const isFromBot = raw.key.fromMe || senderPhone === botPhoneNumber;

    if (isFromBot && !config.selfTest) return;

    const startsTicketTag = /^#t[-\s]?\d+/i.test(rawText);

    const isSelfTest =
      config.selfTest &&
      isFromBot &&
      config.isOwner(senderPhone) &&
      (
        rawText.startsWith('/') ||
        rawText.startsWith(config.selfTestPrefix) ||
        startsTicketTag
      );

    if (isFromBot && !isSelfTest) return;

    const text =
      isSelfTest && rawText.startsWith(config.selfTestPrefix)
        ? rawText.slice(config.selfTestPrefix.length).trim()
        : rawText;

    if (!text) return;

    const senderName =
      raw.pushName ||
      this.store.getEmployee(senderPhone)?.name ||
      senderPhone;

    const sessionKey = `reg:${senderPhone}`;
    const session = this.store.getSession(sessionKey);

    if (session?.step === 'datos' && !text.startsWith('/')) {
      await this.finishRegistration({
        chatId,
        senderPhone,
        senderName,
        text,
        session
      });
      return;
    }

    if (text.startsWith('/')) {
      await this.handleCommand({
        chatId,
        isGroup,
        senderPhone,
        senderName,
        text
      });
      return;
    }

    const activeTicketId = this.store.getActiveTicket(`${chatId}:${senderPhone}`);

    if (isGroup && !isSelfTest && !parseTicketTag(text) && !activeTicketId) {
      return;
    }

    await this.processNaturalMessage({
      chatId,
      isGroup,
      senderPhone,
      senderName,
      text
    });
  }

  async startRegistration({ chatId, senderPhone, pendingRequest = null, reason = '' }) {
    const sessionKey = `reg:${senderPhone}`;

    this.store.setSession(sessionKey, {
      step: 'datos',
      pendingRequest,
      startedAt: nowISO()
    });

    await this.store.save();

    await this.sendText(
      chatId,
      [
        `👋 ${reason ? reason + ' ' : ''}Para usar el bot de CONATEL registra tus datos.`,
        '',
        `Envía en un solo mensaje: nombre completo, área (${config.areas.join(', ')}) y cargo.`,
        '',
        'Ejemplo: Juan Pérez, soporte, analista.',
        '',
        'Escribe /cancelar para salir.'
      ].join('\n')
    );
  }

  async finishRegistration({ chatId, senderPhone, senderName, text, session }) {
    const sessionKey = `reg:${senderPhone}`;

    const extracted = await extractRegistration(text);
    const existing = this.store.getEmployee(senderPhone) || {};
    const partial = session.partial || {};

    const merged = {
      name: extracted.nombre || partial.name || existing.name || '',
      area: extracted.area || partial.area || existing.area || '',
      role: extracted.cargo || partial.role || existing.role || ''
    };

    const missing = [];

    if (!merged.name) missing.push('nombre');
    if (!merged.area) missing.push('área');
    if (!merged.role) missing.push('cargo');

    if (missing.length > 0) {
      this.store.setSession(sessionKey, {
        ...session,
        partial: merged
      });

      await this.store.save();

      await this.sendText(
        chatId,
        `Faltan datos: ${missing.join(', ')}.\nEnvía un mensaje con esos datos o escribe /cancelar.`
      );

      return;
    }

    this.store.upsertEmployee(senderPhone, {
      name: merged.name,
      area: merged.area,
      role: merged.role,
      registeredAt: existing.registeredAt || nowISO()
    });

    this.store.setSession(sessionKey, null);
    await this.store.save();

    await this.sendText(
      chatId,
      `✅ Registro completado:\nNombre: ${merged.name}\nÁrea: ${merged.area}\nCargo: ${merged.role}`
    );

    if (session.pendingRequest) {
      await this.processNaturalMessage({
        chatId,
        isGroup: chatId.endsWith('@g.us'),
        senderPhone,
        senderName,
        text: session.pendingRequest
      });
    }
  }

  async handleCommand({ chatId, senderPhone, senderName, text }) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ').trim();
    const isOwner = config.isOwner(senderPhone);

    if (cmd === '/cancelar') {
      this.store.setSession(`reg:${senderPhone}`, null);
      await this.store.save();
      await this.sendText(chatId, 'Operación cancelada.');
      return;
    }

    if (['/help', '/ayuda', '/comandos'].includes(cmd)) {
      await this.sendText(chatId, this.helpText());
      return;
    }

    if (['/registrarme', '/registro'].includes(cmd)) {
      await this.startRegistration({
        chatId,
        senderPhone,
        pendingRequest: args || null
      });
      return;
    }

    if (['/estado', '/miestado'].includes(cmd)) {
      const tickets = this.store
        .listOpenTickets()
        .filter((ticket) => ticket.requesterPhone === senderPhone || isOwner)
        .map((ticket) => refreshPriority(ticket))
        .sort((a, b) => b.score - a.score);

      if (!tickets.length) {
        await this.sendText(chatId, 'No tienes tickets abiertos.');
        return;
      }

      const lines = tickets.map((ticket) => this.formatTicketLine(ticket));
      await this.store.save();

      await this.sendText(chatId, `Tickets abiertos:\n${lines.join('\n')}`);
      return;
    }

    if (['/ticket', '/nuevo'].includes(cmd)) {
      const employee = this.store.getEmployee(senderPhone);

      if (!employee) {
        await this.startRegistration({
          chatId,
          senderPhone,
          pendingRequest: args,
          reason: 'Para crear tickets primero regístrate.'
        });
        return;
      }

      if (!args) {
        await this.sendText(chatId, 'Envía /ticket descripción del problema o solicitud.');
        return;
      }

      const classification = await classifyMessage(args, {
        activeTicketId: null
      });

      const ticket = createTicket({
        store: this.store,
        chatId,
        senderPhone,
        senderName,
        classification: {
          ...classification,
          accion: 'crear_ticket'
        },
        originalText: args
      });

      await this.store.save();

      await this.sendText(
        chatId,
        [
          `🎫 ${ticketTag(ticket.id)} creado.`,
          this.formatTicketLine(ticket),
          '',
          `Envía aclaraciones con ${ticketTag(ticket.id)} o sigue escribiendo durante ${Math.round(config.activeTicketTtlMs / 60000)} minutos.`
        ].join('\n')
      );

      return;
    }

    if (cmd === '/list') {
      if (!isOwner) {
        await this.sendText(chatId, 'Solo el owner puede usar /list.');
        return;
      }

      const tickets = this.store
        .listOpenTickets()
        .map((ticket) => refreshPriority(ticket))
        .sort((a, b) => b.score - a.score);

      if (!tickets.length) {
        await this.sendText(chatId, 'No hay tickets abiertos.');
        return;
      }

      const lines = tickets.map((ticket) => this.formatTicketLine(ticket));
      await this.store.save();

      await this.sendText(chatId, `Tickets abiertos:\n${lines.join('\n')}`);
      return;
    }

    if (cmd === '/asignar') {
      if (!isOwner) {
        await this.sendText(chatId, 'Solo el owner puede usar /asignar.');
        return;
      }

      const ticketId =
        parseTicketTag(args) || Number((args.match(/\d+/) || [])[0] || 0);

      const phoneMatch = args.replace(/#?t?-?\s?\d+/i, '').trim();
      const assignedPhone = toPhone(phoneMatch);

      if (!ticketId || assignedPhone.length < 8) {
        await this.sendText(chatId, 'Uso: /asignar #T-123 59170000000');
        return;
      }

      const ticket = this.store.getTicket(ticketId);

      if (!ticket) {
        await this.sendText(chatId, `No encontré el ticket ${ticketTag(ticketId)}.`);
        return;
      }

      if (ticket.status === 'cerrada') {
        await this.sendText(chatId, `${ticketTag(ticket.id)} está cerrado.`);
        return;
      }

      appendUpdate({
        store: this.store,
        ticket,
        fromPhone: senderPhone,
        fromName: senderName,
        text: `Asignado a ${assignedPhone} por ${senderName}`,
        changes: {
          assignedTo: assignedPhone,
          status: 'en_progreso',
          kind: 'sistema'
        }
      });

      await this.store.save();

      await this.sendText(
        chatId,
        `✅ ${ticketTag(ticket.id)} asignado a ${assignedPhone}.\nEstado: en_progreso.`
      );

      return;
    }

    if (['/cerrar', '/resolver'].includes(cmd)) {
      const ticketId =
        parseTicketTag(args) || Number((args.match(/\d+/) || [])[0] || 0);

      if (!ticketId) {
        await this.sendText(chatId, 'Uso: /cerrar #T-123');
        return;
      }

      const ticket = this.store.getTicket(ticketId);

      if (!ticket) {
        await this.sendText(chatId, `No encontré el ticket ${ticketTag(ticketId)}.`);
        return;
      }

      const canClose =
        config.isOwner(senderPhone) ||
        ticket.requesterPhone === senderPhone ||
        ticket.assignedTo === senderPhone;

      if (!canClose) {
        await this.sendText(chatId, 'No tienes permiso para cerrar este ticket.');
        return;
      }

      if (ticket.status === 'cerrada') {
        await this.sendText(chatId, `${ticketTag(ticket.id)} ya está cerrado.`);
        return;
      }

      appendUpdate({
        store: this.store,
        ticket,
        fromPhone: senderPhone,
        fromName: senderName,
        text: `Cerrado por ${senderName}`,
        changes: {
          status: 'cerrada',
          kind: 'sistema'
        }
      });

      await this.store.save();

      await this.sendText(chatId, `✅ ${ticketTag(ticket.id)} cerrado.`);
      return;
    }

    if (cmd === '/owner') {
      if (!isOwner) {
        await this.sendText(chatId, 'Solo el owner puede usar comandos owner.');
        return;
      }

      await this.handleOwnerCommand({ chatId, args });
      return;
    }

    await this.sendText(chatId, 'Comando no reconocido. Usa /help.');
  }

  async handleOwnerCommand({ chatId, args }) {
    const [sub, ...rest] = args.split(/\s+/);
    const value = rest.join(' ').trim();

    if (!sub) {
      await this.sendText(
        chatId,
        [
          'Comandos owner:',
          '/owner alerts on|off',
          '/owner threshold 70',
          '/owner area soporte on|off',
          '/owner config',
          '/owner broadcast mensaje'
        ].join('\n')
      );
      return;
    }

    if (sub === 'alerts') {
      const enabled = value.toLowerCase() === 'on';
      this.store.setSetting('autoAlerts', enabled);
      await this.store.save();

      await this.sendText(chatId, `Alertas automáticas: ${enabled ? 'ON' : 'OFF'}`);
      return;
    }

    if (sub === 'threshold') {
      const threshold = Number(value);

      if (Number.isNaN(threshold) || threshold < 0 || threshold > 100) {
        await this.sendText(chatId, 'Threshold inválido. Usa un número entre 0 y 100.');
        return;
      }

      this.store.setSetting('priorityThreshold', threshold);
      await this.store.save();

      await this.sendText(chatId, `Threshold de prioridad configurado a ${threshold}.`);
      return;
    }

    if (sub === 'area') {
      const [area, state] = value.split(/\s+/);

      if (!config.areas.includes(area) || !['on', 'off'].includes(state)) {
        await this.sendText(chatId, 'Uso: /owner area soporte on|off');
        return;
      }

      const settings = this.store.getSettings();
      const areaNotifications = {
        ...(settings.areaNotifications || {}),
        [area]: state === 'on'
      };

      this.store.setSetting('areaNotifications', areaNotifications);
      await this.store.save();

      await this.sendText(chatId, `Notificaciones para ${area}: ${state.toUpperCase()}`);
      return;
    }

    if (sub === 'config') {
      const settings = this.store.getSettings();
      await this.sendText(chatId, JSON.stringify(settings, null, 2));
      return;
    }

    if (sub === 'broadcast') {
      if (!value) {
        await this.sendText(chatId, 'Uso: /owner broadcast mensaje');
        return;
      }

      const targets = new Set([
        ...config.ownerPhones,
        ...Object.values(this.store.data.employees)
          .map((employee) => employee.phone)
          .filter(Boolean)
      ]);

      for (const phone of targets) {
        await this.sendText(`${phone}@s.whatsapp.net`, `📢 Aviso CONATEL:\n${value}`);
      }

      await this.sendText(chatId, `Aviso enviado a ${targets.size} destinatarios.`);
      return;
    }

    await this.sendText(chatId, 'Comando owner no reconocido.');
  }

  async processNaturalMessage({ chatId, senderPhone, senderName, text }) {
    const employee = this.store.getEmployee(senderPhone);

    if (!employee) {
      await this.startRegistration({
        chatId,
        senderPhone,
        pendingRequest: text,
        reason: 'Para crear tickets primero regístrate.'
      });
      return;
    }

    const activeKey = `${chatId}:${senderPhone}`;
    const activeTicketId = this.store.getActiveTicket(activeKey);
    const tagId = parseTicketTag(text);

    const classification = await classifyMessage(text, {
      activeTicketId: tagId || activeTicketId || null
    });

    const targetId = tagId || classification.ticket_id || activeTicketId;

    if (targetId) {
      const ticket = this.store.getTicket(targetId);

      if (!ticket) {
        await this.sendText(chatId, `No encontré el ticket ${ticketTag(targetId)}.`);
        return;
      }

      if (!this.canInteractWithTicket(ticket, senderPhone)) {
        await this.sendText(chatId, 'No tienes permiso para interactuar con este ticket.');
        return;
      }

      if (ticket.status === 'cerrada') {
        await this.sendText(
          chatId,
          `${ticketTag(ticket.id)} está cerrado. Para otro tema usa /ticket.`
        );
        return;
      }

      const updated = appendUpdate({
        store: this.store,
        ticket,
        fromPhone: senderPhone,
        fromName: senderName,
        text,
        changes: {
          kind: tagId ? 'nota' : 'aclaracion'
        }
      });

      this.store.setActiveTicket(
        activeKey,
        updated.id,
        new Date(Date.now() + config.activeTicketTtlMs).toISOString()
      );

      await this.store.save();

      await this.sendText(
        chatId,
        `📝 ${ticketTag(updated.id)} actualizado.\nPrioridad actual: ${updated.priorityLevel} (${updated.score}/100).`
      );

      return;
    }

    const shouldCreate =
      classification.accion === 'crear_ticket' ||
      (!activeTicketId && classification.confianza >= 60 && String(text).trim().length >= 15);

    if (shouldCreate) {
      const ticket = createTicket({
        store: this.store,
        chatId,
        senderPhone,
        senderName,
        classification,
        originalText: text
      });

      await this.store.save();

      await this.sendText(
        chatId,
        [
          `🎫 ${ticketTag(ticket.id)} creado.`,
          this.formatTicketLine(ticket),
          '',
          `Envía aclaraciones con ${ticketTag(ticket.id)} o sigue escribiendo durante ${Math.round(config.activeTicketTtlMs / 60000)} minutos.`
        ].join('\n')
      );

      return;
    }

    await this.sendText(
      chatId,
      'No detecté una solicitud clara. Usa /ticket descripción o /help.'
    );
  }

  canInteractWithTicket(ticket, phone) {
    if (config.isOwner(phone)) return true;
    if (ticket.requesterPhone === phone) return true;
    if (ticket.assignedTo === phone) return true;

    const employee = this.store.getEmployee(phone);
    return Boolean(employee && employee.area === ticket.area);
  }

  formatTicketLine(ticket) {
    return `${ticketTag(ticket.id)} [${ticket.priorityLevel || 'media'} ${ticket.score ?? 0}/100] ${ticket.area} - ${truncate(ticket.title, 70)}`;
  }

  helpText() {
    return [
      `🤖 ${config.botName}`,
      '',
      'Comandos:',
      '/registrarme - Registra tus datos',
      '/ticket descripción - Crea un ticket',
      '/estado - Ver tus tickets abiertos',
      '/cerrar #T-123 - Cerrar ticket',
      '/help - Ver ayuda',
      '',
      'Ejemplos:',
      '/ticket No puedo acceder al correo',
      '#T-101 Sigue fallando después del reinicio',
      '',
      'En grupos, el bot procesa comandos, tickets activos o mensajes con #T-xxx.'
    ].join('\n');
  }
}

module.exports = Handler;