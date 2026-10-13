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

      try {
        await this.sendPresence(task.chatId, 'composing');
        await this.sleep(delay);

        const response = await task.buildResponse();

        await this.sendPresence(task.chatId, 'paused');

        if (response && typeof response === 'string' && response.trim()) {
          await this.sendText(task.chatId, response);
        }

        task.resolve(response);
      } catch (error) {
        this.logger.error?.({ err: error.message }, 'Error en cola de respuestas');
        await this.sendPresence(task.chatId, 'paused').catch(() => {});
        task.reject(error);
      }

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