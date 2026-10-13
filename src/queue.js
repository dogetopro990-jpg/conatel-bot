class ResponseQueue {
  constructor({ sendText, sendPresence, logger, minDelay = 5000, maxDelay = 10000 }) {
    this.sendText = sendText;
    this.sendPresence = sendPresence;
    this.logger = logger;
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.queue = [];
    this.processing = false;
  }

  enqueue(chatId, buildResponse) {
    const timestamp = new Date().toISOString();
    const chatIdClean = chatId.split('@')[0];
    
    console.log(`\n📋 [${timestamp}]`);
    console.log(`   ENCOLADO → ${chatIdClean}`);
    console.log(`   Posición en cola: ${this.queue.length + 1}`);
    
    return new Promise((resolve, reject) => {
      this.queue.push({ chatId, buildResponse, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      const delay = this.randomDelay();
      const chatIdClean = task.chatId.split('@')[0];

      console.log(`\n⏳ [${new Date().toISOString()}]`);
      console.log(`   Procesando → ${chatIdClean}`);
      console.log(`   Delay: ${(delay / 1000).toFixed(1)}s`);

      try {
        // 1. Activar typing
        await this.sendPresence(task.chatId, 'composing');
        await this.sleep(delay);

        // 2. Generar respuesta
        console.log(`   🧠 Generando respuesta...`);
        const response = await task.buildResponse();

        // 3. Desactivar typing
        await this.sendPresence(task.chatId, 'paused');

        // 4. Enviar respuesta
        if (response && typeof response === 'string' && response.trim()) {
          await this.sendText(task.chatId, response);
        }

        task.resolve(response);
      } catch (error) {
        this.logger.error?.({ err: error.message }, 'Error en cola de respuestas');
        await this.sendPresence(task.chatId, 'paused').catch(() => {});
        task.reject(error);
      }

      // 5. Pequeña pausa entre mensajes
      await this.sleep(500);
    }

    this.processing = false;
  }

  randomDelay() {
    return Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  pending() {
    return this.queue.length;
  }
}

module.exports = ResponseQueue;