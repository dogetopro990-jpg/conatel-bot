const SQLStore = require('./database');
const { nowISO } = require('./utils');
const config = require('./config'); // ✅ Agregado para acceder a las áreas por defecto

class Store {
  constructor(dbPath) {
    this.sql = new SQLStore(dbPath);
    
    // ✅ SEMBRAR ÁREAS POR DEFECTO EN LA BASE DE DATOS AL INICIAR
    this.sql.seedDefaultAreas(config.areas);
    
    // Cache en memoria para acceso rápido (se sincroniza con SQLite)
    this._cache = {
      users: null,
      employees: null,
      tickets: null,
      settings: null,
      activeTickets: null,
      sessions: null
    };
    
    this._loadCache();
    console.log('📦 Store inicializado (SQLite + cache en memoria)');
  }

  _loadCache() {
    // Cargar todo en memoria al inicio
    const users = this.sql.getUsers();
    this._cache.users = {};
    for (const u of users) {
      this._cache.users[u.username] = {
        username: u.username,
        password: u.password,
        name: u.name,
        role: u.role,
        createdAt: u.created_at
      };
    }

    const employees = this.sql.getEmployees();
    this._cache.employees = {};
    for (const e of employees) {
      this._cache.employees[e.phone] = {
        phone: e.phone,
        name: e.name,
        area: e.area,
        role: e.role,
        notificationsEnabled: e.notificationsEnabled,
        registeredAt: e.registered_at
      };
    }

    const tickets = this.sql.getAllTickets();
    this._cache.tickets = {};
    for (const t of tickets) {
      this._cache.tickets[String(t.id)] = {
        id: t.id,
        ticketId: t.ticket_id,
        chatId: t.chat_id,
        requesterPhone: t.requester_phone,
        requesterName: t.requester_name,
        title: t.title,
        description: t.description,
        area: t.area,
        urgency: t.urgency,
        location: t.location,
        status: t.status,
        assignedTo: t.assigned_to,
        priorityLevel: t.priority_level,
        score: t.score,
        manualPriority: t.manual_priority === 1,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        messages: t.messages || []
      };
    }

    this._cache.settings = this.sql.getSettings();
    
    // Active tickets y sessions se cargan bajo demanda
    this._cache.activeTickets = {};
    this._cache.sessions = {};
  }

  // Propiedad `data` para compatibilidad con código existente
  get data() {
    return {
      users: this._cache.users,
      employees: this._cache.employees,
      tickets: this._cache.tickets,
      settings: this._cache.settings,
      activeTickets: this._cache.activeTickets,
      sessions: this._cache.sessions
    };
  }

  // ============================================================
  // USERS
  // ============================================================

  upsertUser(user) {
    this.sql.upsertUser(user);
    this._cache.users[user.username] = {
      username: user.username,
      password: user.password,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt
    };
  }

  deleteUser(username) {
    this.sql.deleteUser(username);
    delete this._cache.users[username];
  }

  // ============================================================
  // EMPLOYEES
  // ============================================================

  getEmployee(phone) {
    return this._cache.employees[phone] || null;
  }

  upsertEmployee(phone, data) {
    this.sql.upsertEmployee(phone, data);
    this._cache.employees[phone] = {
      phone,
      name: data.name,
      area: data.area,
      role: data.role,
      notificationsEnabled: data.notificationsEnabled !== false,
      registeredAt: data.registeredAt || nowISO()
    };
  }

  deleteEmployee(phone) {
    this.sql.deleteEmployee(phone);
    delete this._cache.employees[phone];
  }

  // ============================================================
  // TICKETS
  // ============================================================

  getTicket(id) {
    return this._cache.tickets[String(id)] || null;
  }

  createTicket(ticket) {
    const created = this.sql.createTicket(ticket);
    this._cache.tickets[String(created.id)] = {
      ...created,
      manualPriority: created.manual_priority === 1
    };
    return this._cache.tickets[String(created.id)];
  }

  updateTicket(id, changes) {
    const updated = this.sql.updateTicket(id, changes);
    if (updated) {
      this._cache.tickets[String(id)] = {
        ...updated,
        manualPriority: updated.manual_priority === 1
      };
    }
    return this._cache.tickets[String(id)];
  }

  deleteTicket(id) {
    this.sql.deleteTicket(id);
    delete this._cache.tickets[String(id)];
  }

  listOpenTickets() {
    return Object.values(this._cache.tickets).filter(
      t => t.status === 'abierta' || t.status === 'en_progreso'
    );
  }

  renumberTickets() {
    this.sql.renumberTickets();
    // Recargar cache de tickets
    const tickets = this.sql.getAllTickets();
    this._cache.tickets = {};
    for (const t of tickets) {
      this._cache.tickets[String(t.id)] = {
        id: t.id,
        ticketId: t.ticket_id,
        chatId: t.chat_id,
        requesterPhone: t.requester_phone,
        requesterName: t.requester_name,
        title: t.title,
        description: t.description,
        area: t.area,
        urgency: t.urgency,
        location: t.location,
        status: t.status,
        assignedTo: t.assigned_to,
        priorityLevel: t.priority_level,
        score: t.score,
        manualPriority: t.manual_priority === 1,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        messages: t.messages || []
      };
    }
  }

  // ============================================================
  // ACTIVE TICKETS
  // ============================================================

  getActiveTicket(chatKey) {
    const ticketId = this.sql.getActiveTicket(chatKey);
    return ticketId;
  }

  setActiveTicket(chatKey, ticketId, expiresAt) {
    this.sql.setActiveTicket(chatKey, ticketId, expiresAt);
    this._cache.activeTickets[chatKey] = { ticketId, expiresAt };
  }

  // ============================================================
  // SESSIONS
  // ============================================================

  getSession(key) {
    return this.sql.getSession(key);
  }

  setSession(key, session) {
    this.sql.setSession(key, session);
    if (session) {
      this._cache.sessions[key] = session;
    } else {
      delete this._cache.sessions[key];
    }
  }

  // ============================================================
  // SETTINGS
  // ============================================================

  getSettings() {
    return this._cache.settings;
  }

  getSetting(key, defaultValue = null) {
    return this._cache.settings[key] ?? defaultValue;
  }

  setSetting(key, value) {
    this.sql.setSetting(key, value);
    this._cache.settings[key] = value;
  }

  // ============================================================
  // AREAS
  // ============================================================

  getCustomAreas() {
    return this.sql.getCustomAreas();
  }

  addCustomArea(name) {
    this.sql.addCustomArea(name);
  }

  removeCustomArea(name) {
    this.sql.removeCustomArea(name);
  }

  // ============================================================
  // UTILIDADES
  // ============================================================

  async save() {
    // No-op: SQLite guarda automáticamente
    return Promise.resolve();
  }

  async load() {
    // No-op: ya cargado en constructor
    return Promise.resolve();
  }

  close() {
    this.sql.close();
  }

  // Método para el explorador SQL del panel
  executeQuery(sql, params = []) {
    return this.sql.executeQuery(sql, params);
  }

  getSchema() {
    return this.sql.getSchema();
  }
}

module.exports = Store;