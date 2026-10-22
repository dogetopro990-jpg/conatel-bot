const { nowISO } = require('./utils');

class SafetyManager {
  constructor(store) {
    this.store = store;
    this.sendHistory = new Map(); // phone -> [{timestamp, text}]
    this.hourlyCounter = new Map(); // hour -> count
    this.dailyCounter = new Map(); // date -> count
    this.errorCount = new Map(); // phone -> count
    this.paused = false;
    this.pauseUntil = null;
    
    // Cargar configuración
    this.config = this.loadConfig();
    
    // Limpiar contadores cada hora
    setInterval(() => this.cleanupCounters(), 3600000);
    
    console.log('🛡️  Safety Manager inicializado');
  }

  loadConfig() {
    const settings = this.store.getSettings();
    return {
      // Límites
      maxMessagesPerHour: settings.maxMessagesPerHour || 10,
      maxMessagesPerDay: settings.maxMessagesPerDay || 50,
      maxMessagesPerRecipientPerDay: settings.maxMessagesPerRecipientPerDay || 3,
      
      // Delays (en milisegundos)
      minDelayBetweenMessages: settings.minDelayBetweenMessages || 15000, // 15s
      maxDelayBetweenMessages: settings.maxDelayBetweenMessages || 45000, // 45s
      minDelayBetweenSameRecipient: settings.minDelayBetweenSameRecipient || 300000, // 5 min
      
      // Horario laboral
      businessHoursEnabled: settings.businessHoursEnabled !== false,
      businessHourStart: settings.businessHourStart || 8, // 8 AM
      businessHourEnd: settings.businessHourEnd || 19, // 7 PM
      
      // Seguridad
      pauseOnErrorThreshold: settings.pauseOnErrorThreshold || 3,
      pauseDuration: settings.pauseDuration || 1800000, // 30 min
      broadcastEnabled: settings.broadcastEnabled || false,
      
      // Personalización
      personalizeMessages: settings.personalizeMessages !== false
    };
  }

  saveConfig() {
    const settings = this.store.getSettings();
    Object.assign(settings, this.config);
    this.store.data.settings = settings;
    this.store.save();
  }

  // ============ VERIFICACIONES ============

  canSend(phone, text) {
    // 1. ¿Está pausado el sistema?
    if (this.paused) {
      if (this.pauseUntil && Date.now() > this.pauseUntil) {
        this.paused = false;
        this.pauseUntil = null;
        console.log('🛡️  Pausa automática finalizada');
      } else {
        return {
          allowed: false,
          reason: `Sistema pausado hasta ${new Date(this.pauseUntil).toLocaleString()}`
        };
      }
    }

    // 2. ¿Broadcast habilitado?
    if (text.startsWith('📢') && !this.config.broadcastEnabled) {
      return {
        allowed: false,
        reason: 'Broadcast deshabilitado. Actívalo en Configuración.'
      };
    }

    // 3. ¿Horario laboral?
    if (this.config.businessHoursEnabled) {
      const now = new Date();
      const hour = now.getHours();
      if (hour < this.config.businessHourStart || hour >= this.config.businessHourEnd) {
        return {
          allowed: false,
          reason: `Fuera de horario laboral (${this.config.businessHourStart}:00 - ${this.config.businessHourEnd}:00)`
        };
      }
    }

    // 4. ¿Límite por hora excedido?
    const currentHour = new Date().toISOString().slice(0, 13);
    const hourlyCount = this.hourlyCounter.get(currentHour) || 0;
    if (hourlyCount >= this.config.maxMessagesPerHour) {
      return {
        allowed: false,
        reason: `Límite por hora excedido (${this.config.maxMessagesPerHour}/hora)`
      };
    }

    // 5. ¿Límite diario excedido?
    const currentDay = new Date().toISOString().slice(0, 10);
    const dailyCount = this.dailyCounter.get(currentDay) || 0;
    if (dailyCount >= this.config.maxMessagesPerDay) {
      return {
        allowed: false,
        reason: `Límite diario excedido (${this.config.maxMessagesPerDay}/día)`
      };
    }

    // 6. ¿Límite por destinatario excedido?
    const recipientHistory = this.sendHistory.get(phone) || [];
    const todayMessages = recipientHistory.filter(m => {
      const msgDate = new Date(m.timestamp).toISOString().slice(0, 10);
      return msgDate === currentDay;
    });
    if (todayMessages.length >= this.config.maxMessagesPerRecipientPerDay) {
      return {
        allowed: false,
        reason: `Límite para ${phone} excedido (${this.config.maxMessagesPerRecipientPerDay}/día)`
      };
    }

    // 7. ¿Demasiados errores con este destinatario?
    const errors = this.errorCount.get(phone) || 0;
    if (errors >= this.config.pauseOnErrorThreshold) {
      return {
        allowed: false,
        reason: `Demasiados errores con ${phone}. Pausado.`
      };
    }

    // 8. ¿Mensaje duplicado reciente?
    const recentDuplicate = recipientHistory.find(m => {
      const timeDiff = Date.now() - new Date(m.timestamp).getTime();
      return timeDiff < this.config.minDelayBetweenSameRecipient && m.text === text;
    });
    if (recentDuplicate) {
      return {
        allowed: false,
        reason: 'Mensaje duplicado reciente'
      };
    }

    return { allowed: true };
  }

  // ============ REGISTRO ============

  recordSend(phone, text) {
    // Historial por destinatario
    if (!this.sendHistory.has(phone)) {
      this.sendHistory.set(phone, []);
    }
    this.sendHistory.get(phone).push({
      timestamp: nowISO(),
      text
    });

    // Limpiar historial antiguo (> 24h)
    const cutoff = Date.now() - 86400000;
    const history = this.sendHistory.get(phone);
    this.sendHistory.set(phone, history.filter(m => new Date(m.timestamp).getTime() > cutoff));

    // Contadores
    const currentHour = new Date().toISOString().slice(0, 13);
    this.hourlyCounter.set(currentHour, (this.hourlyCounter.get(currentHour) || 0) + 1);

    const currentDay = new Date().toISOString().slice(0, 10);
    this.dailyCounter.set(currentDay, (this.dailyCounter.get(currentDay) || 0) + 1);

    // Limpiar errores previos si hubo éxito
    this.errorCount.set(phone, 0);
  }

  recordError(phone) {
    const current = this.errorCount.get(phone) || 0;
    this.errorCount.set(phone, current + 1);

    // Si hay muchos errores, pausar todo el sistema
    if (current + 1 >= this.config.pauseOnErrorThreshold) {
      this.paused = true;
      this.pauseUntil = Date.now() + this.config.pauseDuration;
      console.log(`🛡️  ⚠️  Sistema pausado por ${this.config.pauseDuration / 60000} minutos debido a errores`);
    }
  }

  // ============ DELAY ALEATORIO ============

  async randomDelay() {
    const min = this.config.minDelayBetweenMessages;
    const max = this.config.maxDelayBetweenMessages;
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    console.log(`🛡️  Delay de seguridad: ${delay / 1000}s`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  // ============ PERSONALIZACIÓN ============

  personalizeMessage(baseText, employee) {
    if (!this.config.personalizeMessages) return baseText;
    
    const firstName = employee.name.split(' ')[0];
    const timestamp = new Date().toLocaleTimeString('es', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    // Agregar variaciones sutiles para que no sea idéntico
    const variations = [
      `\n\n(Hora: ${timestamp})`,
      `\n—\nSaludos, ${firstName}.`,
      `\n[${timestamp}]`,
    ];
    
    const variation = variations[Math.floor(Math.random() * variations.length)];
    return baseText + variation;
  }

  // ============ ESTADÍSTICAS ============

  getStats() {
    const currentHour = new Date().toISOString().slice(0, 13);
    const currentDay = new Date().toISOString().slice(0, 10);

    return {
      paused: this.paused,
      pauseUntil: this.pauseUntil,
      messagesThisHour: this.hourlyCounter.get(currentHour) || 0,
      messagesToday: this.dailyCounter.get(currentDay) || 0,
      limits: {
        perHour: this.config.maxMessagesPerHour,
        perDay: this.config.maxMessagesPerDay,
        perRecipient: this.config.maxMessagesPerRecipientPerDay
      },
      broadcastEnabled: this.config.broadcastEnabled,
      businessHours: this.config.businessHoursEnabled ? 
        `${this.config.businessHourStart}:00 - ${this.config.businessHourEnd}:00` : 'Deshabilitado'
    };
  }

  // ============ MANTENIMIENTO ============

  cleanupCounters() {
    const currentHour = new Date().toISOString().slice(0, 13);
    const currentDay = new Date().toISOString().slice(0, 10);

    // Limpiar horas antiguas
    for (const [hour] of this.hourlyCounter) {
      if (hour < currentHour) {
        this.hourlyCounter.delete(hour);
      }
    }

    // Limpiar días antiguos
    for (const [day] of this.dailyCounter) {
      if (day < currentDay) {
        this.dailyCounter.delete(day);
      }
    }

    console.log(`🛡️  Contadores limpiados. Hora: ${this.hourlyCounter.size}, Día: ${this.dailyCounter.size}`);
  }

  // ============ RESET MANUAL ============

  reset() {
    this.sendHistory.clear();
    this.hourlyCounter.clear();
    this.dailyCounter.clear();
    this.errorCount.clear();
    this.paused = false;
    this.pauseUntil = null;
    console.log('🛡️  Safety Manager reseteado');
  }
}

module.exports = SafetyManager;