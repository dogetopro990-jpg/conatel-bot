class SafeQueue {
  constructor({ sendText, sendPresence, logger, safety, minDelay = 300, maxDelay = 800 }) {
    this.sendText = sendText;
    this.sendPresence = sendPresence;
    this.logger = logger;
    this.safety = safety;
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;

    // ===== COLA GLOBAL ESTRICTA =====
    this.globalQueue = [];
    this.isProcessing = false;
    this.lastSendTime = 0;
    this.extraDelay = 2000; // 2 segundos entre envíos

    // ===== COLAS POR CHAT =====
    this.chatQueues = new Map();
    this.processingChats = new Set();

    // ===== ESTADÍSTICAS =====
    this.stats = { totalSent: 0, totalBlocked: 0, lastSentAt: null };

    console.log('📬 SafeQueue inicializada (delay global: 2s entre envíos)');
  }

  // ============================================================
  // COLA GLOBAL: envío físico con reintentos
  // ============================================================

  async enqueueSend(jid, text, options = {}, retries = 2) {
    return new Promise((resolve) => {
      this.globalQueue.push({ jid, text, options, resolve, retries, enqueuedAt: Date.now() });
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
      // 1. Verificaciones de seguridad
      if (job.options.proactive && this.safety) {
        const check = this.safety.canSend(phone, job.text);
        if (!check.allowed) {
          console.log(`   🛡️ ⛔ Bloqueado a ${phone}: ${check.reason}`);
          this.stats.totalBlocked++;
          job.resolve({ sent: false, reason: check.reason });
          this.isProcessing = false;
          this.processGlobalQueue();
          return;
        }
      }

      // 2. Delay global estricto
      const now = Date.now();
      const timeSinceLastSend = now - this.lastSendTime;
      if (this.lastSendTime > 0 && timeSinceLastSend < this.extraDelay) {
        const waitTime = this.extraDelay - timeSinceLastSend;
        await new Promise(r => setTimeout(r, waitTime));
      }

      // 3. Personalización
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
        // REINTENTO SI FALLA EL ENVÍO
        if (job.retries > 0) {
          console.log(`   ⚠️ Fallo al enviar. Reintentando (${job.retries} restantes)...`);
          job.retries--;
          this.globalQueue.unshift(job); // Volver a poner al principio
        } else {
          if (this.safety) this.safety.recordError(phone);
          this.stats.totalBlocked++;
          console.log(`   ❌ Error de envío definitivo`);
          job.resolve({ sent: false, reason: 'Error de envío' });
        }
      }
    } catch (error) {
      if (job.retries > 0) {
        console.log(`   ⚠️ Error en cola global. Reintentando...`);
        job.retries--;
        this.globalQueue.unshift(job);
      } else {
        if (this.safety) this.safety.recordError(phone);
        this.stats.totalBlocked++;
        this.logger?.error({ err: error.message }, 'Error definitivo en cola global');
        job.resolve({ sent: false, reason: error.message });
      }
    } finally {
      this.isProcessing = false;
      if (this.globalQueue.length > 0) {
        setTimeout(() => this.processGlobalQueue(), 50);
      }
    }
  }

  // ============================================================
  // COLA POR CHAT: con manejo de errores y fallback
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
        console.log(`   PROCESANDO CHAT → ${chatClean}`);

        // Delay humano
        const delay = this.randomDelay();
        await new Promise(r => setTimeout(r, delay));

        // Activar typing
        if (this.sendPresence) {
          await this.sendPresence(chatId, 'composing').catch(() => {});
        }

        // Ejecutar el job (IA + lógica)
        const response = await job();

        // Desactivar typing
        if (this.sendPresence) {
          await this.sendPresence(chatId, 'paused').catch(() => {});
        }

        // Validar y enviar
        if (typeof response === 'string' && response.trim().length > 0) {
          await this.safeSend(chatId, response);
        } else {
          console.log(`   ⚠️ El job no devolvió una respuesta válida para ${chatClean}`);
        }

      } catch (error) {
        // ✅ CORRECCIÓN CRÍTICA: Si la IA o la DB fallan, avisamos al usuario en lugar de dejarlo colgado
        this.logger?.error({ err: error.message, chatId }, 'Error procesando respuesta del bot');
        
        const fallbackMsg = 'Disculpa, tuve un pequeño problema técnico procesando tu mensaje. ¿Podrías repetirlo?';
        try {
          await this.safeSend(chatId, fallbackMsg);
        } catch (e) {
          this.logger?.error({ err: e.message }, 'Fallo crítico enviando mensaje de error al usuario');
        }
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

  async safeSend(jid, text, options = {}) {
    return this.enqueueSend(jid, text, options);
  }

  async sendProactive(jid, text, options = {}) {
    return this.enqueueSend(jid, text, { ...options, proactive: true });
  }

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

  getStats() {
    return { ...this.stats, queueLength: this.globalQueue.length, isProcessing: this.isProcessing };
  }

  clearQueue() {
    const cleared = this.globalQueue.length;
    this.globalQueue = [];
    console.log(`   🗑️ Cola global limpiada: ${cleared} mensajes descartados`);
    return cleared;
  }
}

module.exports = SafeQueue;