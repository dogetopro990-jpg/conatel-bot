class SafeQueue {
  constructor({ sendText, sendPresence, logger, safety, minDelay = 300, maxDelay = 800 }) {
    this.sendText = sendText;        // Función RAW (toca Baileys directamente)
    this.sendPresence = sendPresence;
    this.logger = logger;
    this.safety = safety;
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;

    // ===== COLA GLOBAL ESTRICTA (un mensaje a la vez en TODO el sistema) =====
    this.globalQueue = [];
    this.isProcessing = false;
    this.lastSendTime = 0;
    this.extraDelay = 2000; // 2 segundos extra entre CUALQUIER envío

    // ===== COLAS POR CHAT (typing + delay humano para respuestas del bot) =====
    this.chatQueues = new Map();
    this.processingChats = new Set();

    // ===== ESTADÍSTICAS =====
    this.stats = {
      totalSent: 0,
      totalBlocked: 0,
      lastSentAt: null
    };

    console.log('📬 SafeQueue inicializada (delay global: 2s entre envíos)');
  }

  // ============================================================
  // COLA GLOBAL: envío físico de mensajes (uno a la vez + 2s)
  // ============================================================

  async enqueueSend(jid, text, options = {}) {
    return new Promise((resolve) => {
      this.globalQueue.push({
        jid,
        text,
        options,
        resolve,
        enqueuedAt: Date.now()
      });
      console.log(`   📬 En cola global (posición ${this.globalQueue.length}): ${jid.split('@')[0]}`);
      this.processGlobalQueue();
    });
  }

  async processGlobalQueue() {
    if (this.isProcessing || this.globalQueue.length === 0) return;

    this.isProcessing = true;
    const job = this.globalQueue.shift();
    const phone = job.jid.split('@')[0];

    try {
      // 1. Verificaciones de seguridad SOLO para mensajes proactivos
      //    (broadcasts y notificaciones masivas, NO respuestas conversacionales)
      if (job.options.proactive && this.safety) {
        const check = this.safety.canSend(phone, job.text);
        if (!check.allowed) {
          console.log(`   🛡️  ⛔ Bloqueado a ${phone}: ${check.reason}`);
          this.stats.totalBlocked++;
          job.resolve({ sent: false, reason: check.reason });
          this.isProcessing = false;
          this.processGlobalQueue();
          return;
        }
      }

      // 2. Delay global estricto de 2 segundos entre envíos
      const now = Date.now();
      const timeSinceLastSend = now - this.lastSendTime;
      if (this.lastSendTime > 0 && timeSinceLastSend < this.extraDelay) {
        const waitTime = this.extraDelay - timeSinceLastSend;
        console.log(`   ⏳ Delay de seguridad: ${waitTime}ms`);
        await new Promise(r => setTimeout(r, waitTime));
      }

      // 3. Personalización (broadcasts)
      let finalText = job.text;
      if (job.options.personalizable && job.options.employee && job.text.startsWith('📢') && this.safety) {
        finalText = this.safety.personalizeMessage(job.text, job.options.employee);
      }

      // 4. Envío físico
      console.log(`\n📤 [${new Date().toISOString()}]`);
      console.log(`   ENVIANDO → ${phone}`);
      const preview = finalText.length > 50 ? finalText.substring(0, 50) + '...' : finalText;
      console.log(`   Texto: "${preview}"`);

      const result = await this.sendText(job.jid, finalText);

      if (result) {
        if (this.safety) this.safety.recordSend(phone, finalText);
        this.stats.totalSent++;
        this.stats.lastSentAt = new Date().toISOString();
        this.lastSendTime = Date.now();
        console.log(`   ✅ Enviado correctamente (total: ${this.stats.totalSent})`);
        job.resolve({ sent: true });
      } else {
        if (this.safety) this.safety.recordError(phone);
        this.stats.totalBlocked++;
        console.log(`   ❌ Error de envío`);
        job.resolve({ sent: false, reason: 'Error de envío' });
      }
    } catch (error) {
      if (this.safety) this.safety.recordError(phone);
      this.stats.totalBlocked++;
      this.logger?.error({ err: error.message }, 'Error en cola global');
      job.resolve({ sent: false, reason: error.message });
    } finally {
      this.isProcessing = false;
      if (this.globalQueue.length > 0) {
        setTimeout(() => this.processGlobalQueue(), 50);
      }
    }
  }

  // ============================================================
  // COLA POR CHAT: respuestas del bot (typing + delay humano)
  // ============================================================

  enqueue(chatId, job) {
    if (!this.chatQueues.has(chatId)) {
      this.chatQueues.set(chatId, []);
    }
    this.chatQueues.get(chatId).push(job);
    this.processChat(chatId);
  }

  async processChat(chatId) {
    if (this.processingChats.has(chatId)) return;
    this.processingChats.add(chatId);

    const jobs = this.chatQueues.get(chatId) || [];

    while (jobs.length > 0) {
      const job = jobs.shift();
      try {
        const chatClean = chatId.split('@')[0];
        console.log(`\n📋 [${new Date().toISOString()}]`);
        console.log(`   ENCOLADO → ${chatClean}`);
        console.log(`   Posición en cola: ${jobs.length + 1}`);

        // Delay humano antes de responder
        const delay = this.randomDelay();
        console.log(`\n⏳ [${new Date().toISOString()}]`);
        console.log(`   Procesando → ${chatClean}`);
        console.log(`   Delay: ${(delay / 1000).toFixed(1)}s`);

        // Activar typing
        if (this.sendPresence) {
          await this.sendPresence(chatId, 'composing');
          console.log(`   📝 TYPING activado + 🧠 IA procesando...`);
        }

        await new Promise(r => setTimeout(r, delay));

        // Ejecutar el job (procesa la IA y devuelve la respuesta)
        const response = await job();

        // Desactivar typing
        if (this.sendPresence) {
          await this.sendPresence(chatId, 'paused');
          console.log(`   ⏸️  TYPING desactivado`);
        }

        // Enviar la respuesta por la cola global (con delay de 2s)
        if (response) {
          await this.safeSend(chatId, response);
        }
      } catch (error) {
        this.logger?.error({ err: error.message }, 'Error en cola de chat');
      }
    }

    this.processingChats.delete(chatId);
    this.chatQueues.delete(chatId);
  }

  randomDelay() {
    const min = this.minDelay || 300;
    const max = this.maxDelay || 800;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // ============================================================
  // API PÚBLICA
  // ============================================================

  // Envío conversacional (respuestas del bot) — sin bloqueos de seguridad
  async safeSend(jid, text, options = {}) {
    return this.enqueueSend(jid, text, options);
  }

  // Envío proactivo (notificaciones) — con verificaciones de seguridad
  async sendProactive(jid, text, options = {}) {
    return this.enqueueSend(jid, text, { ...options, proactive: true });
  }

  // Broadcast seguro a múltiples destinatarios (siempre proactivo)
  async safeBroadcast(targets, text, employees = []) {
    const results = [];
    const employeeMap = new Map(employees.map(e => [e.phone, e]));

    for (const phone of targets) {
      const employee = employeeMap.get(phone);
      const result = await this.enqueueSend(`${phone}@s.whatsapp.net`, text, {
        proactive: true,
        personalizable: true,
        employee
      });
      results.push({ phone, ...result });
    }

    return results;
  }

  // ============================================================
  // ESTADÍSTICAS Y MANTENIMIENTO
  // ============================================================

  getStats() {
    return {
      ...this.stats,
      queueLength: this.globalQueue.length,
      isProcessing: this.isProcessing
    };
  }

  clearQueue() {
    const cleared = this.globalQueue.length;
    this.globalQueue = [];
    console.log(`   🗑️  Cola global limpiada: ${cleared} mensajes descartados`);
    return cleared;
  }
}

module.exports = SafeQueue;