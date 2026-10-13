const config = require('./config');
const { toPhone, parseTicketTag, ticketTag, truncate, nowISO } = require('./utils');
const { detectIntent, generateResponse, extractRegistration } = require('./ai');
const { createTicket, appendUpdate } = require('./tickets');
const { refreshPriority } = require('./priority');

class Handler {
  constructor({ store, responseQueue, logger }) {
    this.store = store;
    this.responseQueue = responseQueue;
    this.logger = logger;
    this.history = {};
  }

  extractText(raw) {
    const message = raw.message || {};
    return (
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      message.documentMessage?.caption ||
      ''
    );
  }

  getHistory(key, limit = 10) {
    if (!this.history[key]) this.history[key] = [];
    return this.history[key].slice(-limit);
  }

  addToHistory(key, from, text) {
    if (!this.history[key]) this.history[key] = [];
    this.history[key].push({ from, text, at: nowISO() });
    if (this.history[key].length > 20) {
      this.history[key] = this.history[key].slice(-20);
    }
  }

  async handleMessage(raw, botPhoneNumber) {
    if (!raw?.key) return;

    const chatId = raw.key.remoteJid;
    if (!chatId || chatId === 'status@broadcast') return;

    const isGroup = chatId.endsWith('@g.us');
    const sender = isGroup ? raw.key.participant : chatId;
    let senderPhone = toPhone(sender);
    if (!senderPhone) return;

    const rawText = this.extractText(raw).trim();
    if (!rawText) return;

    const isFromBot = raw.key.fromMe || senderPhone === botPhoneNumber;

    if (isFromBot && botPhoneNumber && senderPhone !== botPhoneNumber) {
      senderPhone = botPhoneNumber;
    }

    if (isFromBot && !config.selfTest) return;

    const isSelfTest =
      config.selfTest &&
      isFromBot &&
      config.isOwner(senderPhone);

    if (isFromBot && !isSelfTest) return;

    const text = rawText;
    const senderName =
      raw.pushName ||
      this.store.getEmployee(senderPhone)?.name ||
      senderPhone;

    // Si es comando, procesar por ruta de comandos
    if (text.startsWith('/')) {
      await this.handleCommand({ chatId, isGroup, senderPhone, senderName, text });
      return;
    }

    // Si es grupo y no hay ticket activo ni tag, ignorar
    if (isGroup) {
      const activeTicketId = this.store.getActiveTicket(`${chatId}:${senderPhone}`);
      if (!parseTicketTag(text) && !activeTicketId) return;
    }

    // Encolar respuesta natural con IA
    this.responseQueue.enqueue(chatId, async () => {
      try {
        return await this.processAndRespond({
          chatId,
          senderPhone,
          senderName,
          text,
          isGroup
        });
      } catch (error) {
        this.logger.error({ err: error.message }, 'Error procesando mensaje');
        return 'Hubo un problema procesando tu mensaje. Intenta de nuevo en un momento.';
      }
    });
  }

  // ============ RUTA DE COMANDOS ============

  async handleCommand({ chatId, senderPhone, senderName, text }) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ').trim();
    const isOwner = config.isOwner(senderPhone);

    // Encolar comandos de usuario para mantener typing consistente
    const runCommand = async () => {
      try {
        return await this.executeCommand({ chatId, senderPhone, senderName, cmd, args, isOwner });
      } catch (error) {
        this.logger.error({ err: error.message }, 'Error ejecutando comando');
        return 'Hubo un error ejecutando el comando.';
      }
    };

    // Comandos owner rápidos sin typing
    const fastOwnerCommands = ['/owner'];
    if (fastOwnerCommands.includes(cmd) && isOwner) {
      const response = await runCommand();
      if (response) await this.responseQueue.sendText(chatId, response);
      return;
    }

    // Otros comandos con typing
    this.responseQueue.enqueue(chatId, runCommand);
  }

  async executeCommand({ chatId, senderPhone, senderName, cmd, args, isOwner }) {
    if (cmd === '/cancelar') {
      this.store.setSession(`reg:${senderPhone}`, null);
      await this.store.save();
      return 'Operación cancelada.';
    }

    if (['/help', '/ayuda', '/comandos'].includes(cmd)) {
      return this.helpText();
    }

    if (['/registrarme', '/registro'].includes(cmd)) {
      return await this.cmdRegister({ chatId, senderPhone, args });
    }

    if (['/estado', '/miestado'].includes(cmd)) {
      return this.cmdStatus({ senderPhone, isOwner });
    }

    if (['/ticket', '/nuevo'].includes(cmd)) {
      return await this.cmdCreateTicket({ chatId, senderPhone, senderName, args });
    }

    if (cmd === '/list') {
      if (!isOwner) return 'Solo el owner puede usar /list.';
      return this.cmdList();
    }

    if (cmd === '/asignar') {
      if (!isOwner) return 'Solo el owner puede usar /asignar.';
      return await this.cmdAssign({ args, senderPhone, senderName });
    }

    if (['/cerrar', '/resolver'].includes(cmd)) {
      return await this.cmdClose({ args, senderPhone, senderName });
    }

    if (cmd === '/owner') {
      if (!isOwner) return 'Solo el owner puede usar comandos owner.';
      return await this.cmdOwner({ args });
    }

    return 'Comando no reconocido. Usa /help.';
  }

  async cmdRegister({ chatId, senderPhone, args }) {
    const sessionKey = `reg:${senderPhone}`;
    this.store.setSession(sessionKey, {
      step: 'datos',
      pendingRequest: args || null,
      startedAt: nowISO()
    });
    await this.store.save();

    return [
      '👋 Para registrarte necesito algunos datos.',
      '',
      `Envíame en un mensaje: nombre completo, área (${config.areas.join(', ')}) y cargo.`,
      '',
      'Ejemplo: Juan Pérez, soporte, analista.',
      '',
      'Escribe /cancelar para salir.'
    ].join('\n');
  }

  cmdStatus({ senderPhone, isOwner }) {
    const tickets = this.store
      .listOpenTickets()
      .filter((t) => t.requesterPhone === senderPhone || isOwner)
      .map((t) => refreshPriority(t))
      .sort((a, b) => b.score - a.score);

    if (!tickets.length) return 'No tienes tickets abiertos.';

    const lines = tickets.map((t) => this.formatTicketLine(t));
    return `Tickets abiertos:\n${lines.join('\n')}`;
  }

  async cmdCreateTicket({ chatId, senderPhone, senderName, args }) {
    const employee = this.store.getEmployee(senderPhone);

    if (!employee) {
      const sessionKey = `reg:${senderPhone}`;
      this.store.setSession(sessionKey, {
        step: 'datos',
        pendingRequest: args,
        startedAt: nowISO()
      });
      await this.store.save();
      return 'Para crear tickets primero regístrate.\nEnvíame: nombre, área y cargo.';
    }

    if (!args) return 'Envía /ticket descripción del problema o solicitud.';

    const intent = await detectIntent(args, { employee, activeTicket: null });

    const ticket = createTicket({
      store: this.store,
      chatId,
      senderPhone,
      senderName,
      classification: {
        area: intent.area || 'soporte',
        urgencia: intent.urgencia || 'media',
        titulo: intent.titulo || args.slice(0, 120),
        descripcion: intent.descripcion || args
      },
      originalText: args
    });

    await this.store.save();

    return [
      `🎫 ${ticketTag(ticket.id)} creado.`,
      this.formatTicketLine(ticket),
      '',
      `Puedes enviar aclaraciones con ${ticketTag(ticket.id)} o seguir escribiendo durante ${Math.round(config.activeTicketTtlMs / 60000)} minutos.`
    ].join('\n');
  }

  cmdList() {
    const tickets = this.store
      .listOpenTickets()
      .map((t) => refreshPriority(t))
      .sort((a, b) => b.score - a.score);

    if (!tickets.length) return 'No hay tickets abiertos.';

    const lines = tickets.map((t) => this.formatTicketLine(t));
    return `Tickets abiertos:\n${lines.join('\n')}`;
  }

  async cmdAssign({ args, senderPhone, senderName }) {
    const ticketId =
      parseTicketTag(args) || Number((args.match(/\d+/) || [])[0] || 0);

    const phoneMatch = args.replace(/#?t?-?\s?\d+/i, '').trim();
    const assignedPhone = toPhone(phoneMatch);

    if (!ticketId || assignedPhone.length < 8) {
      return 'Uso: /asignar #T-123 59170000000';
    }

    const ticket = this.store.getTicket(ticketId);
    if (!ticket) return `No encontré el ticket ${ticketTag(ticketId)}.`;
    if (ticket.status === 'cerrada') return `${ticketTag(ticket.id)} está cerrado.`;

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
    return `✅ ${ticketTag(ticket.id)} asignado a ${assignedPhone}.\nEstado: en_progreso.`;
  }

  async cmdClose({ args, senderPhone, senderName }) {
    const ticketId =
      parseTicketTag(args) || Number((args.match(/\d+/) || [])[0] || 0);

    if (!ticketId) return 'Uso: /cerrar #T-123';

    const ticket = this.store.getTicket(ticketId);
    if (!ticket) return `No encontré el ticket ${ticketTag(ticketId)}.`;

    const canClose =
      config.isOwner(senderPhone) ||
      ticket.requesterPhone === senderPhone ||
      ticket.assignedTo === senderPhone;

    if (!canClose) return 'No tienes permiso para cerrar este ticket.';
    if (ticket.status === 'cerrada') return `${ticketTag(ticket.id)} ya está cerrado.`;

    appendUpdate({
      store: this.store,
      ticket,
      fromPhone: senderPhone,
      fromName: senderName,
      text: `Cerrado por ${senderName}`,
      changes: { status: 'cerrada', kind: 'sistema' }
    });

    await this.store.save();
    return `✅ ${ticketTag(ticket.id)} cerrado.`;
  }

  async cmdOwner({ args }) {
    const [sub, ...rest] = args.split(/\s+/);
    const value = rest.join(' ').trim();

    if (!sub) {
      return [
        'Comandos owner:',
        '/owner alerts on|off',
        '/owner threshold 70',
        '/owner area soporte on|off',
        '/owner config',
        '/owner broadcast mensaje'
      ].join('\n');
    }

    if (sub === 'alerts') {
      const enabled = value.toLowerCase() === 'on';
      this.store.setSetting('autoAlerts', enabled);
      await this.store.save();
      return `Alertas automáticas: ${enabled ? 'ON' : 'OFF'}`;
    }

    if (sub === 'threshold') {
      const threshold = Number(value);
      if (Number.isNaN(threshold) || threshold < 0 || threshold > 100) {
        return 'Threshold inválido. Usa un número entre 0 y 100.';
      }
      this.store.setSetting('priorityThreshold', threshold);
      await this.store.save();
      return `Threshold de prioridad configurado a ${threshold}.`;
    }

    if (sub === 'area') {
      const [area, state] = value.split(/\s+/);
      if (!config.areas.includes(area) || !['on', 'off'].includes(state)) {
        return 'Uso: /owner area soporte on|off';
      }
      const settings = this.store.getSettings();
      const areaNotifications = {
        ...(settings.areaNotifications || {}),
        [area]: state === 'on'
      };
      this.store.setSetting('areaNotifications', areaNotifications);
      await this.store.save();
      return `Notificaciones para ${area}: ${state.toUpperCase()}`;
    }

    if (sub === 'config') {
      const settings = this.store.getSettings();
      return JSON.stringify(settings, null, 2);
    }

    if (sub === 'broadcast') {
      if (!value) return 'Uso: /owner broadcast mensaje';
      const targets = new Set([
        ...config.ownerPhones,
        ...Object.values(this.store.data.employees)
          .map((e) => e.phone)
          .filter(Boolean)
      ]);
      for (const phone of targets) {
        await this.responseQueue.sendText(
          `${phone}@s.whatsapp.net`,
          `📢 Aviso CONATEL:\n${value}`
        );
      }
      return `Aviso enviado a ${targets.size} destinatarios.`;
    }

    return 'Comando owner no reconocido.';
  }

  // ============ RUTA CONVERSACIONAL (IA) ============

  async processAndRespond({ chatId, senderPhone, senderName, text, isGroup }) {
    const historyKey = `${chatId}:${senderPhone}`;
    const history = this.getHistory(historyKey);

    const employee = this.store.getEmployee(senderPhone);
    const activeTicketId = this.store.getActiveTicket(historyKey);
    const activeTicket = activeTicketId ? this.store.getTicket(activeTicketId) : null;

    // Si el usuario está en sesión de registro, procesar registro
    const sessionKey = `reg:${senderPhone}`;
    const session = this.store.getSession(sessionKey);
    if (session?.step === 'datos') {
      const response = await this.finishRegistration({
        chatId,
        senderPhone,
        senderName,
        text,
        session
      });
      return response;
    }

    // Detectar intención con IA
    const intent = await detectIntent(text, {
      employee,
      activeTicket,
      history
    });

    this.addToHistory(historyKey, 'user', text);

    // Ejecutar lógica de negocio
    const { ticket } = await this.executeIntent({
      intent,
      chatId,
      senderPhone,
      senderName,
      text,
      employee,
      activeTicket
    });

    // Generar respuesta natural con IA
    const naturalResponse = await generateResponse({
      intent,
      employee: this.store.getEmployee(senderPhone),
      activeTicket: ticket || activeTicket,
      userMessage: text,
      context: {}
    });

    this.addToHistory(historyKey, 'bot', naturalResponse);
    return naturalResponse;
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
    if (!merged.area) missing.push('área (soporte, infraestructura o desarrollo)');
    if (!merged.role) missing.push('cargo');

    if (missing.length > 0) {
      this.store.setSession(sessionKey, { ...session, partial: merged });
      await this.store.save();
      return `Faltan datos: ${missing.join(', ')}.\nEnvíame esos datos o escribe /cancelar.`;
    }

    this.store.upsertEmployee(senderPhone, {
      name: merged.name,
      area: merged.area,
      role: merged.role,
      registeredAt: existing.registeredAt || nowISO()
    });

    this.store.setSession(sessionKey, null);
    await this.store.save();

    let response = `✅ Registro completado:\nNombre: ${merged.name}\nÁrea: ${merged.area}\nCargo: ${merged.role}`;

    if (session.pendingRequest) {
      const natural = await this.processAndRespond({
        chatId,
        senderPhone,
        senderName,
        text: session.pendingRequest,
        isGroup: chatId.endsWith('@g.us')
      });
      response += `\n\n${natural}`;
    }

    return response;
  }

  async executeIntent({ intent, chatId, senderPhone, senderName, text, employee, activeTicket }) {
    let ticket = null;

    switch (intent.intencion) {
      case 'crear_ticket': {
        if (!employee) break;
        if (intent.confianza < 50 || !intent.descripcion) break;

        ticket = createTicket({
          store: this.store,
          chatId,
          senderPhone,
          senderName,
          classification: {
            area: intent.area || 'soporte',
            urgencia: intent.urgencia || 'media',
            titulo: intent.titulo || text.slice(0, 120),
            descripcion: intent.descripcion || text
          },
          originalText: text
        });

        await this.store.save();
        break;
      }

      case 'actualizar_ticket':
      case 'aclaracion': {
        const targetId = intent.ticket_id || (activeTicket ? activeTicket.id : null);
        if (!targetId) break;

        ticket = this.store.getTicket(targetId);
        if (!ticket || ticket.status === 'cerrada') break;

        appendUpdate({
          store: this.store,
          ticket,
          fromPhone: senderPhone,
          fromName: senderName,
          text,
          changes: { kind: intent.intencion === 'aclaracion' ? 'aclaracion' : 'nota' }
        });

        this.store.setActiveTicket(
          `${chatId}:${senderPhone}`,
          ticket.id,
          new Date(Date.now() + config.activeTicketTtlMs).toISOString()
        );

        await this.store.save();
        break;
      }

      default:
        break;
    }

    return { ticket };
  }

  // ============ UTILIDADES ============

  formatTicketLine(ticket) {
    return `${ticketTag(ticket.id)} [${ticket.priorityLevel || 'media'} ${ticket.score ?? 0}/100] ${ticket.area} - ${truncate(ticket.title, 70)}`;
  }

  helpText() {
    return [
      `🤖 ${config.botName}`,
      '',
      '📝 Comandos:',
      '/registrarme - Registra tus datos',
      '/ticket descripción - Crea un ticket',
      '/estado - Ver tus tickets abiertos',
      '/cerrar #T-123 - Cerrar ticket',
      '/help - Ver esta ayuda',
      '',
      '💬 También puedes escribirme naturalmente:',
      '• "No puedo acceder al correo" → crea ticket',
      '• "#T-101 sigue fallando" → actualiza ticket',
      '• "Soy Juan, soporte, analista" → te registra',
      '',
      '🔐 Owner:',
      '/list - Ver todos los tickets',
      '/asignar #T-123 59170000000',
      '/owner alerts on|off',
      '/owner threshold 70',
      '/owner area soporte on|off',
      '/owner broadcast mensaje'
    ].join('\n');
  }
}

module.exports = Handler;