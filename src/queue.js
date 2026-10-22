class SafeQueue {
  constructor({ sendText, sendPresence, logger, safety }) {
    this.sendText = sendText;
    this.sendPresence = sendPresence;
    this.logger = logger;
    this.safety = safety;
    this.queue = new Map(); // chatId -> [jobs]
    this.processing = new Set();
  }

  enqueue(chatId, job) {
    if (!this.queue.has(chatId)) {
      this.queue.set(chatId, []);
    }
    this.queue.get(chatId).push(job);
    this.process(chatId);
  }

  async process(chatId) {
    if (this.processing.has(chatId)) return;
    this.processing.add(chatId);

    const jobs = this.queue.get(chatId) || [];
    while (jobs.length > 0) {
      const job = jobs.shift();
      try {
        await job();
      } catch (error) {
        this.logger.error({ err: error.message }, 'Error en cola');
      }
    }

    this.processing.delete(chatId);
    this.queue.delete(chatId);
  }

  // Enviar con todas las verificaciones de seguridad
  async safeSend(jid, text, { personalizable = true, employee = null } = {}) {
    const phone = jid.split('@')[0];
    
    // 1. Verificar si podemos enviar
    const check = this.safety.canSend(phone, text);
    if (!check.allowed) {
      console.log(`🛡️  ⛔ Envío bloqueado a ${phone}: ${check.reason}`);
      return { sent: false, reason: check.reason };
    }

    // 2. Delay aleatorio de seguridad
    await this.safety.randomDelay();

    // 3. Personalizar mensaje si es broadcast
    let finalText = text;
    if (personalizable && employee && text.startsWith('📢')) {
      finalText = this.safety.personalizeMessage(text, employee);
    }

    // 4. Enviar
    try {
      const result = await this.sendText(jid, finalText);
      if (result) {
        this.safety.recordSend(phone, finalText);
        console.log(`🛡️  ✅ Mensaje enviado a ${phone}`);
        return { sent: true };
      } else {
        this.safety.recordError(phone);
        return { sent: false, reason: 'Error de envío' };
      }
    } catch (error) {
      this.safety.recordError(phone);
      this.logger.error({ err: error.message }, 'Error enviando mensaje seguro');
      return { sent: false, reason: error.message };
    }
  }

  // Broadcast seguro a múltiples destinatarios
  async safeBroadcast(targets, text, employees = []) {
    const results = [];
    const employeeMap = new Map(employees.map(e => [e.phone, e]));

    for (const phone of targets) {
      const employee = employeeMap.get(phone);
      const result = await this.safeSend(`${phone}@s.whatsapp.net`, text, {
        personalizable: true,
        employee
      });
      results.push({ phone, ...result });
    }

    return results;
  }
}

module.exports = SafeQueue;