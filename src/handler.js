const config = require('./config');
const { toPhone, parseTicketTag, ticketTag, truncate, nowISO } = require('./utils');
const { detectIntent, generateResponse, extractRegistrationData, getRandomResponse, detectLocation, safeArea, isValidLocation } = require('./ai');
const { createTicket, appendUpdate, autoAssignAndNotify, setEmployeeState, notifyRequesterOnClose } = require('./tickets');
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

  findEmployeeFlexibly(phone) {
    if (!phone) return { employee: null, resolvedPhone: null };
    const cleanTarget = String(phone).replace(/\D/g, '');
    if (!cleanTarget) return { employee: null, resolvedPhone: null };

    let employee = this.store.getEmployee(cleanTarget);
    if (employee) return { employee, resolvedPhone: cleanTarget };

    const allEmployees = this.store.data.employees || {};
    for (const [dbPhone, empData] of Object.entries(allEmployees)) {
      const cleanDbPhone = String(dbPhone).replace(/\D/g, '');
      if (cleanDbPhone === cleanTarget || cleanDbPhone === cleanTarget.slice(-8) || cleanTarget === cleanDbPhone.slice(-8)) {
        console.log(`   ✅ Empleado encontrado con coincidencia flexible. BD: '${dbPhone}' -> Limpio: '${cleanDbPhone}'`);
        return { employee: empData, resolvedPhone: dbPhone };
      }
    }

    return { employee: null, resolvedPhone: cleanTarget };
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
    if (isFromBot && botPhoneNumber && senderPhone !== botPhoneNumber) senderPhone = botPhoneNumber;
    if (isFromBot && !config.selfTest) return;

    const isSelfTest = config.selfTest && isFromBot && config.isOwner(senderPhone);
    if (isFromBot && !isSelfTest) return;

    const text = rawText;
    const { employee, resolvedPhone } = this.findEmployeeFlexibly(senderPhone);
    const senderName = raw.pushName || employee?.name || resolvedPhone || 'Desconocido';

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
      await this.handleCommand({ chatId, isGroup, senderPhone: resolvedPhone, senderName, text });
      return;
    }

    if (isGroup) {
      const activeTicketId = this.store.getActiveTicket(`${chatId}:${resolvedPhone}`);
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
          senderPhone: resolvedPhone,
          senderName,
          text,
          isGroup,
          employee
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
      this.store.setSession(`loc:${senderPhone}`, null);
      await this.store.save();
      return 'Operación cancelada.';
    }

    if (['/help', '/ayuda', '/comandos'].includes(cmd)) return this.helpText();
    if (['/estado', '/miestado'].includes(cmd)) return this.cmdStatus({ senderPhone, isOwner });
    if (['/ticket', '/nuevo'].includes(cmd)) return await this.cmdCreateTicket({ chatId, senderPhone, senderName, args });

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
    const tickets = this.store.listOpenTickets()
      .filter((t) => t.requesterPhone === senderPhone || isOwner)
      .map((t) => refreshPriority(t))
      .sort((a, b) => b.score - a.score);

    if (!tickets.length) return 'No tienes tickets abiertos.';
    const lines = tickets.map((t) => this.formatTicketLine(t));
    return `Tickets abiertos:\n${lines.join('\n')}`;
  }

  async cmdCreateTicket({ chatId, senderPhone, senderName, args }) {
    const { employee } = this.findEmployeeFlexibly(senderPhone);
    if (!employee) return 'Primero necesito algunos datos. ¿Cómo te llamas?';
    if (!args) return 'Envía /ticket descripción del problema o solicitud.';

    const intent = await detectIntent(args, { employee, activeTicket: null });
    const location = detectLocation(args);

    if (!location) return 'Necesito saber la ubicación. ¿Dónde exactamente es el problema?';

    const ticket = createTicket({
      store: this.store,
      chatId,
      senderPhone,
      senderName,
      classification: {
        area: intent.area || 'soporte',
        urgencia: intent.urgencia || 'media',
        titulo: intent.titulo || args.slice(0, 120),
        descripcion: intent.descripcion || args,
        location
      },
      originalText: args
    });

    await this.store.save();

    return [
      `🎫 ${ticket.ticketId} creado.`,
      this.formatTicketLine(ticket),
      '',
      `Puedes enviar aclaraciones o seguir escribiendo durante ${Math.round(config.activeTicketTtlMs / 60000)} minutos.`
    ].join('\n');
  }

  cmdList() {
    const tickets = this.store.listOpenTickets().map((t) => refreshPriority(t)).sort((a, b) => b.score - a.score);
    if (!tickets.length) return 'No hay tickets abiertos.';
    const lines = tickets.map((t) => this.formatTicketLine(t));
    return `Tickets abiertos:\n${lines.join('\n')}`;
  }

  async cmdAssign({ args, senderPhone, senderName }) {
    const ticketId = parseTicketTag(args) || Number((args.match(/\d+/) || [])[0] || 0);
    const phoneMatch = args.replace(/#?t?-?\s?\d+/i, '').trim();
    const assignedPhone = toPhone(phoneMatch);

    if (!ticketId || assignedPhone.length < 8) return 'Uso: /asignar #T-123 59170000000';

    const ticket = this.store.getTicket(ticketId);
    if (!ticket) return `No encontré el ticket ${ticket.ticketId || `T-${ticketId}`}.`;
    if (ticket.status === 'cerrada') return `${ticket.ticketId || `T-${ticket.id}`} está cerrado.`;

    appendUpdate({
      store: this.store,
      ticket,
      fromPhone: senderPhone,
      fromName: senderName,
      text: `Asignado a ${assignedPhone} por ${senderName}`,
      changes: { assignedTo: assignedPhone, status: 'en_progreso', kind: 'sistema' }
    });

    await this.store.save();
    return `✅ ${ticket.ticketId || `T-${ticket.id}`} asignado a ${assignedPhone}.\nEstado: en_progreso.`;
  }

  async cmdClose({ args, senderPhone, senderName }) {
    const ticketId = parseTicketTag(args) || Number((args.match(/\d+/) || [])[0] || 0);
    if (!ticketId) return 'Uso: /cerrar #T-123';

    const ticket = this.store.getTicket(ticketId);
    if (!ticket) return `No encontré el ticket ${ticket.ticketId || `T-${ticketId}`}.`;

    const canClose = config.isOwner(senderPhone) || ticket.requesterPhone === senderPhone || ticket.assignedTo === senderPhone;
    if (!canClose) return 'No tienes permiso para cerrar este ticket.';
    if (ticket.status === 'cerrada') return `${ticket.ticketId || `T-${ticket.id}`} ya está cerrado.`;

    appendUpdate({
      store: this.store,
      ticket,
      fromPhone: senderPhone,
      fromName: senderName,
      text: `Cerrado por ${senderName}`,
      changes: { status: 'cerrada', kind: 'sistema' }
    });

    await this.store.save();
    return `✅ ${ticket.ticketId || `T-${ticket.id}`} cerrado.`;
  }

  async cmdOwner({ args }) {
    const [sub, ...rest] = args.split(/\s+/);
    const value = rest.join(' ').trim();

    if (!sub) {
      return ['Comandos owner:', '/owner alerts on|off', '/owner threshold 70', '/owner area soporte on|off', '/owner config', '/owner broadcast mensaje'].join('\n');
    }

    if (sub === 'alerts') {
      const enabled = value.toLowerCase() === 'on';
      this.store.setSetting('autoAlerts', enabled);
      await this.store.save();
      return `Alertas automáticas: ${enabled ? 'ON' : 'OFF'}`;
    }

    if (sub === 'threshold') {
      const threshold = Number(value);
      if (Number.isNaN(threshold) || threshold < 0 || threshold > 100) return 'Threshold inválido. Usa un número entre 0 y 100.';
      this.store.setSetting('priorityThreshold', threshold);
      await this.store.save();
      return `Threshold de prioridad configurado a ${threshold}.`;
    }

    if (sub === 'area') {
      const [area, state] = value.split(/\s+/);
      if (!config.areas.includes(area) || !['on', 'off'].includes(state)) return 'Uso: /owner area soporte on|off';
      const settings = this.store.getSettings();
      const areaNotifications = { ...(settings.areaNotifications || {}), [area]: state === 'on' };
      this.store.setSetting('areaNotifications', areaNotifications);
      await this.store.save();
      return `Notificaciones para ${area}: ${state.toUpperCase()}`;
    }

    if (sub === 'config') {
      return JSON.stringify(this.store.getSettings(), null, 2);
    }

    if (sub === 'broadcast') {
      if (!value) return 'Uso: /owner broadcast mensaje';
      const targets = new Set([...config.ownerPhones, ...Object.values(this.store.data.employees).map((e) => e.phone).filter(Boolean)]);
      for (const phone of targets) {
        await this.sendText(`${phone}@s.whatsapp.net`, `📢 Aviso CONATEL:\n${value}`);
      }
      return `Aviso enviado a ${targets.size} destinatarios.`;
    }

    return 'Comando owner no reconocido.';
  }

  async processAndRespond({ chatId, senderPhone, senderName, text, isGroup, employee }) {
    const historyKey = `${chatId}:${senderPhone}`;
    const history = this.getHistory(historyKey);

    const activeTicketId = this.store.getActiveTicket(historyKey);
    const activeTicket = activeTicketId ? this.store.getTicket(activeTicketId) : null;

    const regSessionKey = `reg:${senderPhone}`;
    const regSession = this.store.getSession(regSessionKey);
    if (regSession && regSession.step) {
      return await this.handleRegistrationFlow({ chatId, senderPhone, senderName, text, session: regSession, history });
    }

    const locSessionKey = `loc:${senderPhone}`;
    const locSession = this.store.getSession(locSessionKey);
    if (locSession && locSession.step === 'pedir_ubicacion') {
      // ✅ VALIDACIÓN: Si el mensaje NO es una ubicación válida, cancelar la sesión
      if (!isValidLocation(text)) {
        console.log(`   ⚠️ Mensaje "${text}" no es una ubicación válida. Cancelando sesión de ubicación.`);
        this.store.setSession(locSessionKey, null);
        await this.store.save();
        // Procesar el mensaje como nuevo
        return await this.processAndRespond({ chatId, senderPhone, senderName, text, isGroup, employee });
      }
      return await this.handleLocationFlow({ chatId, senderPhone, senderName, text, session: locSession });
    }

    console.log(`   🧠 Detectando intención con IA...`);

    const intent = await detectIntent(text, {
      employee,
      activeTickets: activeTicket ? [activeTicket] : [],
      activeTicket,
      history,
      employeePhone: senderPhone
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

    if (ticket && ticket.status !== 'cerrada') {
      console.log(`   💾 Guardando mensaje en ticket ${ticket.ticketId || `T-${ticket.id}`}...`);
      
      if (intent.intencion !== 'crear_ticket' && intent.intencion !== 'describir_problema') {
        appendUpdate({
          store: this.store,
          ticket,
          fromPhone: senderPhone,
          fromName: senderName,
          text,
          changes: { kind: intent.intencion === 'aclaracion_automatica' ? 'aclaracion' : 'mensaje' }
        });
      }
      
      this.store.setActiveTicket(historyKey, ticket.id, new Date(Date.now() + config.activeTicketTtlMs).toISOString());
      this.store.save().catch(err => console.error(`   ❌ Error guardando: ${err.message}`));
    }

    if (response) {
      this.addToHistory(historyKey, 'bot', response);
      return response;
    }

    console.log(`   💬 Generando respuesta natural...`);
    const naturalResponse = await generateResponse({
      intent,
      employee: employee || this.store.getEmployee(senderPhone),
      activeTickets: activeTicket ? [activeTicket] : [],
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
        
        if (!extracted.nombre || extracted.nombre.length < 2) return 'No entendí el nombre. ¿Cómo te llamas?';

        data.nombre = extracted.nombre;
        
        if (extracted.area && extracted.cargo) {
          data.area = extracted.area;
          data.cargo = extracted.cargo;
          this.store.upsertEmployee(senderPhone, { name: data.nombre, area: data.area, role: data.cargo, registeredAt: nowISO() });
          this.store.setSession(sessionKey, null);
          await this.store.save();
          console.log(`   ✅ Empleado registrado: ${data.nombre}, ${data.area}, ${data.cargo}, Tel: ${senderPhone}`);
          return getRandomResponse('transicion_a_solicitud', { nombre: data.nombre.split(' ')[0] });
        }

        if (extracted.area) {
          data.area = extracted.area;
          this.store.setSession(sessionKey, { step: 'pedir_cargo', data });
          await this.store.save();
          return getRandomResponse('pedir_cargo');
        }

        this.store.setSession(sessionKey, { step: 'pedir_area', data });
        await this.store.save();
        return getRandomResponse('pedir_area', { nombre: data.nombre.split(' ')[0] });
      }

      case 'pedir_area': {
        const area = this.extractArea(text);
        if (!area) return `No entendí el área. Las áreas disponibles son: ${config.areas.join(', ')}. ¿En cuál trabajas?`;

        data.area = area;
        this.store.setSession(sessionKey, { step: 'pedir_cargo', data });
        await this.store.save();
        return getRandomResponse('pedir_cargo');
      }

      case 'pedir_cargo': {
        const cargo = text.trim();
        if (cargo.length < 2) return 'No entendí el cargo. ¿Cuál es tu cargo o puesto?';

        data.cargo = cargo;
        this.store.upsertEmployee(senderPhone, { name: data.nombre, area: data.area, role: data.cargo, registeredAt: nowISO() });
        this.store.setSession(sessionKey, null);
        await this.store.save();
        console.log(`   ✅ Empleado registrado: ${data.nombre}, ${data.area}, ${data.cargo}, Tel: ${senderPhone}`);
        return getRandomResponse('transicion_a_solicitud', { nombre: data.nombre.split(' ')[0] });
      }

      default:
        this.store.setSession(sessionKey, null);
        await this.store.save();
        return 'Algo salió mal. Empecemos de nuevo. ¿Cómo te llamas?';
    }
  }

  async handleLocationFlow({ chatId, senderPhone, senderName, text, session }) {
    const sessionKey = `loc:${senderPhone}`;
    const data = session.data || {};

    console.log(`   📍 Flujo de ubicación`);
    const location = text.trim();
    if (location.length < 2) return 'No entendí la ubicación. ¿Puedes ser más específico?';

    const ticket = createTicket({
      store: this.store,
      chatId,
      senderPhone,
      senderName,
      classification: {
        area: data.area,
        urgencia: data.urgencia,
        titulo: data.titulo,
        descripcion: data.descripcion,
        location
      },
      originalText: data.descripcion
    });

    autoAssignAndNotify({ store: this.store, ticket, sendText: this.sendText, logger: this.logger, delayMs: 10 * 60 * 1000 });

    this.store.setSession(sessionKey, null);
    await this.store.save();
    console.log(`   🎫 Ticket creado: ${ticket.ticketId} en ${location}`);

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
    return responses[Math.floor(Math.random() * responses.length)];
  }

  extractArea(text) {
    return safeArea(text);
  }

  async executeIntent({ intent, chatId, senderPhone, senderName, text, employee, activeTicket }) {
    let ticket = null;
    let response = null;

    switch (intent.intencion) {
      case 'saludo': {
        if (!employee) {
          this.store.setSession(`reg:${senderPhone}`, { step: 'pedir_nombre', data: {} });
          await this.store.save();
          response = getRandomResponse('saludo');
        } else {
          response = getRandomResponse('saludo_registrado', { nombre: employee.name.split(' ')[0] });
        }
        break;
      }

      case 'agradecimiento':
        response = getRandomResponse('agradecimiento');
        break;

      case 'despedida':
        response = getRandomResponse('despedida');
        break;

      case 'describir_problema': {
        response = getRandomResponse('describir_problema');
        break;
      }

      case 'resolver_ticket': {
        const targetId = intent.ticket_id;
        ticket = this.store.getTicket(targetId);
        if (!ticket) { response = 'No encontré el ticket.'; break; }
        if (ticket.assignedTo !== senderPhone) { response = 'Solo el empleado asignado puede resolver este ticket.'; break; }

        appendUpdate({ store: this.store, ticket, fromPhone: senderPhone, fromName: senderName, text: `✅ Ticket resuelto: ${text}`, changes: { status: 'cerrada', kind: 'resolucion' } });
        setEmployeeState(senderPhone, 'disponible');
        notifyRequesterOnClose({ ticket, sendText: this.sendText, logger: this.logger, store: this.store }).catch(err => console.error(err));
        await this.store.save();
        console.log(`   ✅ Ticket ${ticket.ticketId || `T-${ticket.id}`} resuelto por ${senderName}`);
        
        const responses = ['Perfecto, marco el ticket como resuelto. ¡Buen trabajo!', 'Listo, cerré el ticket. Gracias por avisar.', 'Ok, ticket resuelto. Si necesitas algo más, avísame.', 'Entendido, el ticket queda cerrado. ¡Gracias!'];
        response = responses[Math.floor(Math.random() * responses.length)];
        break;
      }

      case 'cambiar_estado_empleado': {
        setEmployeeState(senderPhone, intent.estado, intent.ticket_id);
        const responses = {
          'trabajando': ['Ok, quedo atento. Avísame si necesitas ayuda.', 'Perfecto, tómate tu tiempo. Aquí estoy.', 'Entendido, cuéntame cuando termines.'],
          'ocupado': ['Ok, no te asigno más por ahora. Avísame cuando estés libre.', 'Entendido, te dejo trabajar. Avísame cuando puedas.', 'Perfecto, aquí estoy cuando necesites.'],
          'disponible': ['Ok, te asigno tickets cuando haya.', 'Perfecto, estás disponible de nuevo.', 'Listo, te tengo en cuenta para nuevos tickets.']
        };
        response = (responses[intent.estado] || ['Ok, anotado.'])[Math.floor(Math.random() * (responses[intent.estado] || ['Ok, anotado.']).length)];
        break;
      }

      case 'aclaracion_automatica': {
        const targetId = intent.ticket_id;
        ticket = this.store.getTicket(targetId);
        if (!ticket) { response = 'No encontré el ticket.'; break; }

        const location = detectLocation(text);
        if (location && !ticket.location) {
          ticket.location = location;
          console.log(`   📍 Ubicación guardada: ${location}`);
        }

        const lastMessage = ticket.messages[ticket.messages.length - 1];
        if (lastMessage && lastMessage.kind === 'mensaje_pendiente') lastMessage.kind = 'aclaracion';

        await this.store.save();
        console.log(`   📝 Aclaración agregada al ticket ${ticket.ticketId || `T-${ticket.id}`}`);
        
        const responses = ['Anotado, lo agrego al ticket.', 'Ok, tomé nota.', 'Perfecto, actualicé el ticket.', 'Listo, agregado al ticket.', 'Entendido, lo tengo registrado.'];
        response = responses[Math.floor(Math.random() * responses.length)];
        break;
      }

      case 'crear_ticket': {
        if (activeTicket && activeTicket.status !== 'cerrada') {
          const ticketTitle = (activeTicket.title || '').toLowerCase();
          const ticketDesc = (activeTicket.description || '').toLowerCase();
          const ticketContext = `${ticketTitle} ${ticketDesc}`;
          
          const ticketKeywords = ticketContext.match(/\b[a-záéíóúñ]{5,}\b/g) || [];
          const messageLower = text.toLowerCase();
          const messageMatchesTicket = ticketKeywords.some(keyword => messageLower.includes(keyword));
          
          const isExplicitNewIssue = /(otro\s+problema|nuevo\s+problema|otra\s+cosa|diferente|cambio\s+de\s+tema|aparte|por\s+otro\s+lado|tengo\s+otra\s+consulta)/i.test(text);
          
          if (messageMatchesTicket && !isExplicitNewIssue) {
            console.log(`   📝 Detectado como aclaración del ticket activo ${activeTicket.ticketId} (tema coincide)`);
            ticket = activeTicket;
            
            const location = detectLocation(text);
            if (location && !ticket.location) {
              ticket.location = location;
              console.log(`   📍 Ubicación guardada en ticket activo: ${location}`);
            }

            appendUpdate({ store: this.store, ticket, fromPhone: senderPhone, fromName: senderName, text, changes: { kind: 'aclaracion' } });
            this.store.setActiveTicket(`${chatId}:${senderPhone}`, ticket.id, new Date(Date.now() + config.activeTicketTtlMs).toISOString());
            await this.store.save();
            console.log(`   📝 Información agregada al ticket activo: ${ticket.ticketId || `T-${ticket.id}`}`);
            
            const responses = [
              '✅ Perfecto, agregué esta información a tu ticket activo.',
              'Ok, tomé nota y lo agrego a tu ticket en curso.',
              'Entendido, lo anoto en el ticket que tienes abierto.',
              'Listo, actualicé tu ticket con esta información.'
            ];
            response = responses[Math.floor(Math.random() * responses.length)];
            break;
          }
          
          if (isExplicitNewIssue) {
            console.log(`   🆕 Cambio de tema explícito, creando nuevo ticket`);
          }
        }

        if (!employee) {
          this.store.setSession(`reg:${senderPhone}`, { step: 'pedir_nombre', data: {}, pendingRequest: text });
          await this.store.save();
          response = getRandomResponse('saludo');
          break;
        }

        const area = intent.area || safeArea(text) || 'soporte';
        const urgencia = intent.urgencia || 'media';
        const location = detectLocation(text);

        if (!location) {
          this.store.setSession(`loc:${senderPhone}`, { 
            step: 'pedir_ubicacion', 
            data: { 
              area, 
              urgencia, 
              titulo: intent.titulo || text.slice(0, 120), 
              descripcion: intent.descripcion || text 
            } 
          });
          await this.store.save();
          const locationQuestions = [
            '¿En qué lugar específico es el problema? (Ej: piso 2, área de cajas)',
            '¿Me puedes decir la ubicación exacta? (Ej: oficina de contabilidad, piso 3)',
            '¿Dónde exactamente ocurre el problema?',
            '¿En qué área o piso es el problema?'
          ];
          response = locationQuestions[Math.floor(Math.random() * locationQuestions.length)];
          break;
        }

        ticket = createTicket({
          store: this.store,
          chatId,
          senderPhone,
          senderName,
          classification: { 
            area, 
            urgencia, 
            titulo: intent.titulo || text.slice(0, 120), 
            descripcion: intent.descripcion || text, 
            location 
          },
          originalText: text
        });

        autoAssignAndNotify({ 
          store: this.store, 
          ticket, 
          sendText: this.sendText, 
          logger: this.logger, 
          delayMs: 0 
        });
        await this.store.save();
        console.log(`   🎫 Ticket creado: ${ticket.ticketId}`);

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
        if (!targetId) { response = 'No encontré un ticket activo. ¿Puedes indicarme el número del ticket o describir el problema?'; break; }

        ticket = this.store.getTicket(targetId);
        if (!ticket) { response = `No encontré el ticket ${targetId}. ¿Puedes verificar el número?`; break; }
        if (ticket.status === 'cerrada') { response = `El ticket ${ticket.ticketId || `T-${ticket.id}`} está cerrado. Si necesitas ayuda con otro tema, descríbeme el problema.`; break; }

        const genericMessages = /^(actualizar|agregar|añadir|informar|comentar|el\s+ticket|mi\s+ticket|ticket\s+(anterior|activo|actual|este))$/i;
        if (genericMessages.test(text.trim()) || text.length < 20) {
          response = `Perfecto, veo que tienes el ticket ${ticket.ticketId || `T-${ticket.id}`} sobre "${ticket.title}". ¿Qué información quieres agregar o qué problema tienes?`;
          break;
        }

        const location = detectLocation(text);
        if (location && !ticket.location) {
          ticket.location = location;
          console.log(`   📍 Ubicación guardada: ${location}`);
        }

        appendUpdate({ store: this.store, ticket, fromPhone: senderPhone, fromName: senderName, text, changes: { kind: intent.intencion === 'aclaracion' ? 'aclaracion' : 'nota' } });
        this.store.setActiveTicket(`${chatId}:${senderPhone}`, ticket.id, new Date(Date.now() + config.activeTicketTtlMs).toISOString());
        await this.store.save();
        console.log(`   📝 Ticket actualizado: ${ticket.ticketId || `T-${ticket.id}`}`);
        
        const updateResponses = ['Listo, tomé nota y lo agrego al ticket.', 'Ok, lo anoto en el ticket.', 'Perfecto, actualicé el ticket con lo que me dices.', 'Entendido, lo agrego al ticket.', 'Anotado, lo agrego al ticket.'];
        response = updateResponses[Math.floor(Math.random() * updateResponses.length)];
        break;
      }

      default:
        break;
    }

    return { ticket, response };
  }

  formatTicketLine(ticket) {
    const ticketId = ticket.ticketId || `T-${ticket.id}`;
    return `${ticketId} [${ticket.priorityLevel || 'media'} ${ticket.score ?? 0}/100] ${ticket.area} - ${truncate(ticket.title, 70)}`;
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
      '• "Ya arreglamos el problema" → cierra el ticket automáticamente',
      '• "Estoy trabajando en eso" → cambia tu estado a trabajando',
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