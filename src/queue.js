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

  // Mantiene el typing activo enviando "composing" cada segundo
  startTypingLoop(chatId) {
    let stopped = false;

    const loop = async () => {
      while (!stopped) {
        try {
          await this.sendPresence(chatId, 'composing');
        } catch (error) {
          // Ignorar errores de presence
        }
        await this.sleep(1000); // Enviar cada 1 segundo
      }
    };

    loop();

    return () => {
      stopped = true;
    };
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
        // 1. Iniciar loop de typing (envía composing cada segundo)
        console.log(`   📝 TYPING activado (loop cada 1s)`);
        const stopTyping = this.startTypingLoop(task.chatId);

        // 2. Esperar el delay mientras el typing sigue activo
        await this.sleep(delay);

        // 3. Generar respuesta
        console.log(`   🧠 Generando respuesta...`);
        const response = await task.buildResponse();

        // 4. Detener typing
        stopTyping();
        try {
          await this.sendPresence(task.chatId, 'paused');
        } catch (error) {
          // Ignorar
        }
        console.log(`   ⏸️  TYPING desactivado`);

        // 5. Enviar respuesta
        if (response && typeof response === 'string' && response.trim()) {
          await this.sendText(task.chatId, response);
        }

        task.resolve(response);
      } catch (error) {
        this.logger.error?.({ err: error.message }, 'Error en cola de respuestas');
        task.reject(error);
      }

      // 6. Pequeña pausa entre mensajes
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