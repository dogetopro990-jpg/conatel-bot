const fs = require('fs/promises');
const path = require('path');
const { nowISO } = require('./utils');

function defaultData() {
  return {
    employees: {},
    tickets: {},
    sessions: {},
    activeTickets: {},
    settings: {
      autoAlerts: true,
      priorityThreshold: 70,
      areaNotifications: {
        soporte: true,
        infraestructura: true,
        desarrollo: true
      }
    },
    counters: {
      ticket: 100
    }
  };
}

class Store {
  constructor(file) {
    this.file = path.resolve(file);
    this.data = defaultData();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const base = defaultData();

      this.data = {
        ...base,
        ...parsed,
        settings: {
          ...base.settings,
          ...(parsed.settings || {}),
          areaNotifications: {
            ...base.settings.areaNotifications,
            ...(parsed.settings?.areaNotifications || {})
          }
        },
        counters: {
          ...base.counters,
          ...(parsed.counters || {})
        }
      };
    } catch {
      await this.save();
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  upsertEmployee(phone, employee) {
    this.data.employees[phone] = {
      ...this.data.employees[phone],
      ...employee,
      phone,
      updatedAt: nowISO()
    };

    return this.data.employees[phone];
  }

  getEmployee(phone) {
    return this.data.employees[phone] || null;
  }

  setSession(key, value) {
    if (value === null || value === undefined) {
      delete this.data.sessions[key];
    } else {
      this.data.sessions[key] = value;
    }

    return value;
  }

  getSession(key) {
    return this.data.sessions[key] || null;
  }

  setActiveTicket(key, ticketId, expiresAt) {
    if (!ticketId) {
      delete this.data.activeTickets[key];
    } else {
      this.data.activeTickets[key] = {
        ticketId,
        expiresAt
      };
    }

    return this.data.activeTickets[key];
  }

  getActiveTicket(key) {
    const item = this.data.activeTickets[key];
    if (!item) return null;

    if (new Date(item.expiresAt).getTime() < Date.now()) {
      delete this.data.activeTickets[key];
      return null;
    }

    return item.ticketId;
  }

  createTicket(payload) {
    this.data.counters.ticket += 1;
    const id = this.data.counters.ticket;

    const ticket = {
      id,
      status: 'abierta',
      messages: [],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      lastAlertAt: null,
      score: 0,
      priorityLevel: 'media',
      ...payload
    };

    this.data.tickets[String(id)] = ticket;
    return ticket;
  }

  getTicket(id) {
    return this.data.tickets[String(id)] || null;
  }

  updateTicket(id, patch) {
    const ticket = this.getTicket(id);
    if (!ticket) return null;

    Object.assign(ticket, patch, {
      updatedAt: nowISO()
    });

    return ticket;
  }

  addTicketMessage(id, message) {
    const ticket = this.getTicket(id);
    if (!ticket) return null;

    ticket.messages.push({
      ...message,
      at: nowISO()
    });

    ticket.updatedAt = nowISO();
    return ticket;
  }

  listOpenTickets() {
    return Object.values(this.data.tickets).filter((ticket) =>
      ['abierta', 'en_progreso'].includes(ticket.status)
    );
  }

  setSetting(key, value) {
    this.data.settings[key] = value;
    return this.data.settings;
  }

  getSettings() {
    return this.data.settings;
  }
}

module.exports = Store;