const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { nowISO } = require('./utils');

class SQLStore {
  constructor(dbPath = './data/conatel.db') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initSchema();
    console.log(`📦 Base de datos SQLite: ${dbPath}`);
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'visualizador')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS employees (
        phone TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        area TEXT NOT NULL,
        role TEXT NOT NULL,
        notifications_enabled INTEGER NOT NULL DEFAULT 1,
        registered_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS areas (
        name TEXT PRIMARY KEY,
        is_custom INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        requester_phone TEXT NOT NULL,
        requester_name TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        area TEXT NOT NULL,
        urgency TEXT NOT NULL CHECK(urgency IN ('baja', 'media', 'alta', 'critica')),
        location TEXT,
        status TEXT NOT NULL CHECK(status IN ('abierta', 'en_progreso', 'cerrada')),
        assigned_to TEXT,
        priority_level TEXT NOT NULL DEFAULT 'media',
        score INTEGER NOT NULL DEFAULT 0,
        manual_priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (assigned_to) REFERENCES employees(phone) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS ticket_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        from_phone TEXT NOT NULL,
        from_name TEXT NOT NULL,
        text TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'mensaje',
        created_at TEXT NOT NULL,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS active_tickets (
        chat_key TEXT PRIMARY KEY,
        ticket_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        step TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_area ON tickets(area);
      CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets(requester_phone);
      CREATE INDEX IF NOT EXISTS idx_tickets_score ON tickets(score DESC);
      CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_employees_area ON employees(area);
    `);
  }

  // USERS
  getUsers() {
    return this.db.prepare('SELECT * FROM users').all();
  }

  getUser(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  upsertUser(user) {
    this.db.prepare(`
      INSERT INTO users (username, password, name, role, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        password = excluded.password,
        name = excluded.name,
        role = excluded.role
    `).run(user.username, user.password, user.name, user.role, user.createdAt);
  }

  deleteUser(username) {
    this.db.prepare('DELETE FROM users WHERE username = ?').run(username);
  }

  // EMPLOYEES
  getEmployees() {
    return this.db.prepare('SELECT * FROM employees').all().map(e => ({
      ...e,
      notificationsEnabled: e.notifications_enabled === 1
    }));
  }

  getEmployee(phone) {
    const e = this.db.prepare('SELECT * FROM employees WHERE phone = ?').get(phone);
    if (!e) return null;
    return { ...e, notificationsEnabled: e.notifications_enabled === 1 };
  }

  upsertEmployee(phone, data) {
    this.db.prepare(`
      INSERT INTO employees (phone, name, area, role, notifications_enabled, registered_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        name = excluded.name,
        area = excluded.area,
        role = excluded.role,
        notifications_enabled = excluded.notifications_enabled
    `).run(
      phone, data.name, data.area, data.role,
      data.notificationsEnabled === false ? 0 : 1,
      data.registeredAt || nowISO()
    );
  }

  deleteEmployee(phone) {
    this.db.prepare('DELETE FROM employees WHERE phone = ?').run(phone);
  }

  // TICKETS
  getTicket(id) {
    const ticket = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!ticket) return null;
    ticket.messages = this.getTicketMessages(id);
    return ticket;
  }

  getAllTickets() {
    const tickets = this.db.prepare('SELECT * FROM tickets').all();
    return tickets.map(t => {
      t.messages = this.getTicketMessages(t.id);
      return t;
    });
  }

  createTicket(ticket) {
    const result = this.db.prepare(`
      INSERT INTO tickets (
        ticket_id, chat_id, requester_phone, requester_name,
        title, description, area, urgency, location,
        status, assigned_to, priority_level, score, manual_priority,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ticket.ticketId, ticket.chatId,
      ticket.requesterPhone, ticket.requesterName,
      ticket.title, ticket.description,
      ticket.area, ticket.urgency, ticket.location || null,
      ticket.status || 'abierta', ticket.assignedTo || null,
      ticket.priorityLevel || 'media', ticket.score || 0,
      ticket.manualPriority ? 1 : 0,
      ticket.createdAt, ticket.updatedAt
    );

    const newId = result.lastInsertRowid;

    if (ticket.messages && ticket.messages.length > 0) {
      const insertMsg = this.db.prepare(`
        INSERT INTO ticket_messages (ticket_id, from_phone, from_name, text, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const msg of ticket.messages) {
        insertMsg.run(newId, msg.from, msg.name, msg.text, msg.kind, msg.at);
      }
    }

    return this.getTicket(newId);
  }

  updateTicket(id, changes) {
    const fields = [];
    const values = [];
    const fieldMap = {
      ticketId: 'ticket_id', chatId: 'chat_id',
      requesterPhone: 'requester_phone', requesterName: 'requester_name',
      title: 'title', description: 'description',
      area: 'area', urgency: 'urgency', location: 'location',
      status: 'status', assignedTo: 'assigned_to',
      priorityLevel: 'priority_level', score: 'score',
      manualPriority: 'manual_priority', updatedAt: 'updated_at'
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      if (key in changes) {
        fields.push(`${column} = ?`);
        values.push(key === 'manualPriority' ? (changes[key] ? 1 : 0) : changes[key]);
      }
    }

    if (fields.length === 0) return this.getTicket(id);

    values.push(id);
    this.db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getTicket(id);
  }

  // ✅ DELETE TICKET
  deleteTicket(id) {
    const deleteTransaction = this.db.transaction(() => {
      // 1. Desactivar temporalmente las restricciones de clave foránea 
      // para evitar conflictos con schemas antiguos o tablas huérfanas
      this.db.pragma('foreign_keys = OFF');
      
      // 2. Borrar registros dependientes conocidos (por si el CASCADE no está activo)
      this.db.prepare('DELETE FROM ticket_messages WHERE ticket_id = ?').run(id);
      this.db.prepare('DELETE FROM active_tickets WHERE ticket_id = ?').run(id);
      
      // 3. Borrar cualquier otra referencia residual que pueda existir en schemas antiguos
      try { this.db.prepare('DELETE FROM ticket_updates WHERE ticket_id = ?').run(id); } catch {}
      
      // 4. Borrar el ticket principal
      this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
      
      // 5. Reactivar las restricciones de clave foránea
      this.db.pragma('foreign_keys = ON');
    });

    try {
      deleteTransaction();
    } catch (error) {
      // Asegurar que las foreign keys se reactiven incluso si algo falla
      this.db.pragma('foreign_keys = ON');
      throw error;
    }
  }

  renumberTickets() {
    const tickets = this.db.prepare('SELECT id, area FROM tickets ORDER BY id ASC').all();
    const update = this.db.prepare('UPDATE tickets SET id = ?, ticket_id = ? WHERE id = ?');

    const renameTransaction = this.db.transaction(() => {
      tickets.forEach(t => update.run(-t.id, `TEMP-${t.id}`, t.id));
      tickets.forEach((t, idx) => {
        const newId = idx + 1;
        const areaPrefix = (t.area || 'GEN').substring(0, 3).toUpperCase();
        update.run(newId, `${areaPrefix}-${newId}`, -t.id);
      });
    });

    renameTransaction();
  }

  // TICKET MESSAGES
  getTicketMessages(ticketId) {
    return this.db.prepare(
      'SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC'
    ).all(ticketId).map(m => ({
      from: m.from_phone, name: m.from_name,
      text: m.text, kind: m.kind, at: m.created_at
    }));
  }

  addTicketMessage(ticketId, message) {
    this.db.prepare(`
      INSERT INTO ticket_messages (ticket_id, from_phone, from_name, text, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      ticketId, message.from, message.name,
      message.text, message.kind || 'mensaje', message.at || nowISO()
    );
  }

  // ACTIVE TICKETS
  getActiveTicket(chatKey) {
    const row = this.db.prepare(
      'SELECT ticket_id FROM active_tickets WHERE chat_key = ? AND expires_at > ?'
    ).get(chatKey, nowISO());
    return row ? row.ticket_id : null;
  }

  setActiveTicket(chatKey, ticketId, expiresAt) {
    this.db.prepare(`
      INSERT INTO active_tickets (chat_key, ticket_id, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_key) DO UPDATE SET
        ticket_id = excluded.ticket_id,
        expires_at = excluded.expires_at
    `).run(chatKey, ticketId, expiresAt);
  }

  // SESSIONS
  getSession(key) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_key = ?').get(key);
    if (!row) return null;
    return { step: row.step, data: JSON.parse(row.data) };
  }

  setSession(key, session) {
    if (!session) {
      this.db.prepare('DELETE FROM sessions WHERE session_key = ?').run(key);
      return;
    }
    this.db.prepare(`
      INSERT INTO sessions (session_key, step, data, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        step = excluded.step, data = excluded.data, created_at = excluded.created_at
    `).run(key, session.step, JSON.stringify(session.data), nowISO());
  }

  // SETTINGS
  getSettings() {
    const rows = this.db.prepare('SELECT * FROM settings').all();
    const settings = {};
    for (const row of rows) {
      try { settings[row.key] = JSON.parse(row.value); }
      catch { settings[row.key] = row.value; }
    }
    return settings;
  }

  getSetting(key, defaultValue = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return defaultValue;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value));
  }

  // AREAS
  getCustomAreas() {
    return this.db.prepare('SELECT name FROM areas WHERE is_custom = 1 ORDER BY name')
      .all().map(r => r.name);
  }

  addCustomArea(name) {
    this.db.prepare(`
      INSERT INTO areas (name, is_custom, created_at)
      VALUES (?, 1, ?)
      ON CONFLICT(name) DO UPDATE SET is_custom = 1
    `).run(name, nowISO());
  }

  removeCustomArea(name) {
    this.db.prepare('DELETE FROM areas WHERE name = ? AND is_custom = 1').run(name);
  }

  // Sembrar áreas por defecto en la BD
  seedDefaultAreas(defaultAreas) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO areas (name, is_custom, created_at)
      VALUES (?, 0, ?)
    `);
    const now = nowISO();
    for (const area of defaultAreas) {
      stmt.run(area, now);
    }
  }

  // EXPLORADOR SQL
  executeQuery(sql, params = []) {
    const trimmed = sql.trim().toLowerCase();
    
    if (trimmed.startsWith('select') || trimmed.startsWith('pragma')) {
      return { type: 'select', rows: this.db.prepare(sql).all(...params) };
    }
    
    if (trimmed.startsWith('insert') || trimmed.startsWith('update') || 
        trimmed.startsWith('delete') || trimmed.startsWith('create') || 
        trimmed.startsWith('drop') || trimmed.startsWith('alter')) {
      const result = this.db.prepare(sql).run(...params);
      return { type: 'write', changes: result.changes };
    }
    
    throw new Error('Tipo de query no soportado');
  }

  getSchema() {
    const tables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all();
    
    return tables.map(t => ({
      name: t.name,
      columns: this.db.prepare(`PRAGMA table_info(${t.name})`).all(),
      rowCount: this.db.prepare(`SELECT COUNT(*) as count FROM ${t.name}`).get().count
    }));
  }

  close() {
    this.db.close();
  }
}

module.exports = SQLStore;