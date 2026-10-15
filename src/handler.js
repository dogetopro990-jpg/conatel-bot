const config = require('./config');
const { toPhone, parseTicketTag, ticketTag, truncate, nowISO } = require('./utils');
const { detectIntent, generateResponse, extractRegistrationData, getRandomResponse } = require('./ai');
const { createTicket, appendUpdate, autoAssignAndNotify } = require('./tickets');
const { refreshPriority } = require('./priority');

class Handler {
  constructor({ store, responseQueue, logger, sendText, sendPresence }) {
    this.store = store;
    this.responseQueue = responseQueue;
    this.logger = logger;
    this.sendText = sendText;
    this.sendPresence = sendPresence;
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

    const timestamp = new Date().toISOString();
    const preview = text.length > 50 ? text.substring(0, 50) + '...' : text;
    const chatIdClean = chatId.split('@')[0];
    
    console.log(`\n📥 [${timestamp}]`);
    console.log(`   RECIBIDO ← ${senderPhone} (${senderName})`);
    console.log(`   Chat: ${chatIdClean}`);
    console.log(`   Tipo: ${isGroup ? 'GRUPO' : 'PRIVADO'}`);
    console.log(`   Texto: "${preview}"`);
    console.log(`   FromMe: ${raw.key.fromMe}`);
    console.log(`   Self-test: ${isSelfTest ? 'SÍ' : 'NO'}`);

    if (text.startsWith('/')) {
      console.log(`   📋 Ruta: COMANDO`);
      await this.handleCommand({ chatId, isGroup, senderPhone, senderName, text });
      return;
    }

    if (isGroup) {
      const activeTicketId = this.store.getActiveTicket(`${chatId}:${senderPhone}`);
      if (!parseTicketTag(text) && !activeTicketId) {
        console.log(`   ⏭️  Ignorado: grupo sin ticket activo`);
        return;
      }
    }

    console.log(`   🤖 Ruta: IA CONVERSACIONAL`);

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

  async handleCommand({ chatId, senderPhone, senderName, text }) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ').trim();
    const isOwner = config.isOwner(senderPhone);

    console.log(`   Comando: ${cmd}`);
    console.log(`   Args: ${args || '(ninguno)'}`);
    console.log(`   Owner: ${isOwner ? 'SÍ' : 'NO'}`);

    const runCommand = async () => {
      try {
        return await this.executeCommand({ chatId, senderPhone, senderName, cmd, args, isOwner });
      } catch (error) {
        this.logger.error({ err: error.message }, 'Error ejecutando comando');
        return 'Hubo un error ejecutando el comando.';
      }
    };

    const fastOwnerCommands = ['/owner'];
    if (fastOwnerCommands.includes(cmd) && isOwner) {
      const response = await runCommand();
      if (response) await this.sendText(chatId, response);
      return;
    }

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
      return 'Primero necesito algunos datos. ¿Cómo te llamas?';
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
        await this.sendText(`${phone}@s.whatsapp.net`, `📢 Aviso CONATEL:\n${value}`);
      }
      return `Aviso enviado a ${targets.size} destinatarios.`;
    }

    return 'Comando owner no reconocido.';
  }

  async processAndRespond({ chatId, senderPhone, senderName, text, isGroup }) {
    const historyKey = `${chatId}:${senderPhone}`;
    const history = this.getHistory(historyKey);

    const employee = this.store.getEmployee(senderPhone);
    const activeTicketId = this.store.getActiveTicket(historyKey);
    const activeTicket = activeTicketId ? this.store.getTicket(activeTicketId) : null;

    const sessionKey = `reg:${senderPhone}`;
    const session = this.store.getSession(sessionKey);
    
    if (session && session.step) {
      const response = await this.handleRegistrationFlow({
        chatId,
        senderPhone,
        senderName,
        text,
        session,
        history
      });
      return response;
    }

    console.log(`   🧠 Detectando intención con IA...`);
    const intent = await detectIntent(text, {
      employee,
      activeTicket,
      history
    });

    console.log(`   Intención: ${intent.intencion}`);
    console.log(`   Confianza: ${intent.confianza}%`);
    if (intent.area) console.log(`   Área: ${intent.area}`);
    if (intent.urgencia) console.log(`   Urgencia: ${intent.urgencia}`);

    this.addToHistory(historyKey, 'user', text);

    const { ticket, response } = await this.executeIntent({
      intent,
      chatId,
      senderPhone,
      senderName,
      text,
      employee,
      activeTicket
    });

    if (response) {
      this.addToHistory(historyKey, 'bot', response);
      return response;
    }

    console.log(`   💬 Generando respuesta natural...`);
    const naturalResponse = await generateResponse({
      intent,
      employee: this.store.getEmployee(senderPhone),
      activeTicket: ticket || activeTicket,
      userMessage: text,
      context: {},
      history
    });

    console.log(`   Respuesta: "${naturalResponse.substring(0, 50)}..."`);

    this.addToHistory(historyKey, 'bot', naturalResponse);
    return naturalResponse;
  }

  async handleRegistrationFlow({ chatId, senderPhone, senderName, text, session, history }) {
    const sessionKey = `reg:${senderPhone}`;
    const data = session.data || {};

    console.log(`   📝 Flujo de registro - Paso: ${session.step}`);

    switch (session.step) {
      case 'pedir_nombre': {
        const extracted = await extractRegistrationData(text);
        
        console.log(`   🧠 Datos extraídos:`, extracted);
        
        if (!extracted.nombre || extracted.nombre.length < 2) {
          return 'No entendí el nombre. ¿Cómo te llamas?';
        }

        data.nombre = extracted.nombre;
        
        if (extracted.area && extracted.cargo) {
          data.area = extracted.area;
          data.cargo = extracted.cargo;
          
          this.store.upsertEmployee(senderPhone, {
            name: data.nombre,
            area: data.area,
            role: data.cargo,
            registeredAt: nowISO()
          });

          this.store.setSession(sessionKey, null);
          await this.store.save();

          console.log(`   ✅ Empleado registrado: ${data.nombre}, ${data.area}, ${data.cargo}, Tel: ${senderPhone}`);

          const transicion = getRandomResponse('transicion_a_solicitud', { nombre: data.nombre.split(' ')[0] });
          return transicion;
        }

        if (extracted.area) {
          data.area = extracted.area;
          this.store.setSession(sessionKey, { step: 'pedir_cargo', data });
          await this.store.save();
          return getRandomResponse('pedir_cargo');
        }

        this.store.setSession(sessionKey, { step: 'pedir_area', data });
        await this.store.save();

        return getRandomResponse('pedir_area');
      }

      case 'pedir_area': {
        const area = this.extractArea(text);
        
        if (!area) {
          return 'No entendí el área. ¿Trabajas en soporte, infraestructura o desarrollo?';
        }

        data.area = area;
        this.store.setSession(sessionKey, { step: 'pedir_cargo', data });
        await this.store.save();

        return getRandomResponse('pedir_cargo');
      }

      case 'pedir_cargo': {
        const cargo = text.trim();
        
        if (cargo.length < 2) {
          return 'No entendí el cargo. ¿Cuál es tu cargo o puesto?';
        }

        data.cargo = cargo;

        this.store.upsertEmployee(senderPhone, {
          name: data.nombre,
          area: data.area,
          role: data.cargo,
          registeredAt: nowISO()
        });

        this.store.setSession(sessionKey, null);
        await this.store.save();

        console.log(`   ✅ Empleado registrado: ${data.nombre}, ${data.area}, ${data.cargo}, Tel: ${senderPhone}`);

        const transicion = getRandomResponse('transicion_a_solicitud', { nombre: data.nombre.split(' ')[0] });
        return transicion;
      }

      default:
        this.store.setSession(sessionKey, null);
        await this.store.save();
        return 'Algo salió mal. Empecemos de nuevo. ¿Cómo te llamas?';
    }
  }

  extractArea(text) {
    const t = text.toLowerCase();
    if (t.includes('soporte')) return 'soporte';
    if (t.includes('infra')) return 'infraestructura';
    if (t.includes('desarr')) return 'desarrollo';
    return null;
  }

  async executeIntent({ intent, chatId, senderPhone, senderName, text, employee, activeTicket }) {
    let ticket = null;
    let response = null;

    switch (intent.intencion) {
      case 'saludo': {
        if (!employee) {
          const sessionKey = `reg:${senderPhone}`;
          this.store.setSession(sessionKey, { step: 'pedir_nombre', data: {} });
          await this.store.save();
          
          response = getRandomResponse('saludo');
        } else {
          // Usar solo el primer nombre, o a veces omitirlo
          if (Math.random() > 0.5 && employee.name) {
            const firstName = employee.name.split(' ')[0];
            response = getRandomResponse('transicion_a_solicitud', { nombre: firstName });
          } else {
            response = getRandomResponse('transicion_a_solicitud', { nombre: '' }).replace(/^Bien\s+|Perfecto\s+|Listo\s+|Ok\s+/, '').trim();
            // Si quedó vacío, usar una respuesta sin nombre
            if (!response) {
              response = '¿En qué te puedo ayudar?';
            }
          }
        }
        break;
      }

      case 'crear_ticket': {
        if (!employee) {
          const sessionKey = `reg:${senderPhone}`;
          this.store.setSession(sessionKey, { 
            step: 'pedir_nombre', 
            data: {},
            pendingRequest: text
          });
          await this.store.save();
          
          response = getRandomResponse('saludo');
          break;
        }

        const area = intent.area || 'soporte';
        const urgencia = intent.urgencia || 'media';

        ticket = createTicket({
          store: this.store,
          chatId,
          senderPhone,
          senderName,
          classification: {
            area,
            urgencia,
            titulo: intent.titulo || text.slice(0, 120),
            descripcion: intent.descripcion || text
          },
          originalText: text
        });

        // Asignación automática y notificación con delay de 10 min
        const assignee = autoAssignAndNotify({
          store: this.store,
          ticket,
          sendText: this.sendText,
          logger: this.logger,
          delayMs: 10 * 60 * 1000
        });

        await this.store.save();
        console.log(`   🎫 Ticket creado: #T-${ticket.id}`);

        // Respuestas variadas y naturales
        const responses = [
          'Entendido, lo voy a revisar y te aviso.',
          'Ok, ya lo tengo registrado. Te aviso cuando tenga novedades.',
          'Perfecto, lo estamos viendo. Te mantengo informado.',
          'Listo, ya lo anoté. Te aviso apenas tenga respuesta.',
          'Entendido, lo revisamos y te contamos.',
          'Ok, ya está registrado. Te aviso cuando haya avances.',
          'Perfecto, lo tenemos en seguimiento.',
          'Listo, ya lo estamos viendo. Te aviso pronto.'
        ];

        // 50% de probabilidad de usar el primer nombre, 50% sin nombre
        if (Math.random() > 0.5 && employee.name) {
          const firstName = employee.name.split(' ')[0];
          const baseResponse = responses[Math.floor(Math.random() * responses.length)];
          response = `${firstName}, ${baseResponse.charAt(0).toLowerCase()}${baseResponse.slice(1)}`;
        } else {
          response = responses[Math.floor(Math.random() * responses.length)];
        }
        break;
      }

      case 'actualizar_ticket':
      case 'aclaracion': {
        const targetId = intent.ticket_id || (activeTicket ? activeTicket.id : null);
        if (!targetId) {
          response = 'No encontré el ticket. ¿Puedes indicarme el número del ticket?';
          break;
        }

        ticket = this.store.getTicket(targetId);
        if (!ticket) {
          response = `No encontré el ticket #T-${targetId}.`;
          break;
        }

        if (ticket.status === 'cerrada') {
          response = `El ticket #T-${ticket.id} está cerrado. Para otro tema, describe el problema.`;
          break;
        }

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
        console.log(`   📝 Ticket actualizado: #T-${ticket.id}`);
        
        const updateResponses = [
          'Listo, tomé nota y lo agrego al ticket.',
          'Ok, lo anoto en el ticket.',
          'Perfecto, actualicé el ticket con lo que me dices.',
          'Entendido, lo agrego al ticket.',
          'Anotado, lo agrego al ticket.'
        ];
        response = updateResponses[Math.floor(Math.random() * updateResponses.length)];
        break;
      }

      default:
        break;
    }

    return { ticket, response };
  }

  formatTicketLine(ticket) {
    return `${ticketTag(ticket.id)} [${ticket.priorityLevel || 'media'} ${ticket.score ?? 0}/100] ${ticket.area} - ${truncate(ticket.title, 70)}`;
  }

  helpText() {
    return [
      `🤖 ${config.botName}`,
      '',
      '📝 Comandos:',
      '/estado - Ver tus tickets abiertos',
      '/cerrar #T-123 - Cerrar ticket',
      '/help - Ver esta ayuda',
      '',
      '💬 También puedes escribirme naturalmente:',
      '• "Hola" → te saludo y pido tus datos',
      '• "No puedo acceder al correo" → crea ticket automáticamente',
      '• "#T-101 sigue fallando" → actualiza ticket',
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