class MessageQueue {
  constructor({ minDelay = 3500, maxDelay = 8000, logger = console } = {}) {
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.logger = logger;
    this.tasks = [];
    this.running = false;
  }

  add(fn) {
    return new Promise((resolve, reject) => {
      this.tasks.push({ fn, resolve, reject });
      this.run();
    });
  }

  async run() {
    if (this.running) return;
    this.running = true;

    while (this.tasks.length > 0) {
      const task = this.tasks.shift();

      try {
        const result = await task.fn();
        task.resolve(result);
      } catch (error) {
        this.logger.error?.(error);
        task.reject(error);
      }

      const delay = this.nextDelay();
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.running = false;
  }

  nextDelay() {
    const min = Math.min(this.minDelay, this.maxDelay);
    const max = Math.max(this.minDelay, this.maxDelay);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}

module.exports = MessageQueue;