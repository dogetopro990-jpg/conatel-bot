const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { refreshPriority } = require('./priority');
const { ticketTag, nowISO, toPhone } = require('./utils');

function createAPI({ store, sendText, logger }) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ============ STATS ============
  app.get('/api/stats', (req, res) => {
    const tickets = Object.values(store.data.tickets);
    const open = tickets.filter((t) => ['abierta', 'en_progreso'].includes(t.status));
    const closed = tickets.filter((t) => t.status === 'cerrada');

    open.forEach(refreshPriority);

    const byArea = { soporte: 0, infraestructura: 0, desarrollo: 0 };
    const byPriority = { baja: 0, media: 0, alta: 0, critica: 0 };
    const byStatus = { abierta: 0, en_progreso: 0, cerrada: 0 };

    tickets.forEach((t) => {
      if (byArea[t.area] !== undefined) byArea[t.area]++;
      if (byPriority[t.priorityLevel] !== undefined) byPriority[t.priorityLevel]++;
      if (byStatus[t.status] !== undefined) byStatus[t.status]++;
    });

    res.json({
      total: tickets.length,
      open: open.length,
      closed: closed.length,
      byArea,
      byPriority,
      byStatus,
      employees: Object.keys(store.data.employees).length,
      topTickets: open
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((t) => ({
          id: t.id,
          title: t.title,
          area: t.area,
          priority: t.priorityLevel,
          score: t.score
        }))
    });
  });

  // ============ TICKETS ============
  app.get('/api/tickets', (req, res) => {
    const { status, area, priority, search } = req.query;
    let tickets = Object.values(store.data.tickets).map(refreshPriority);

    if (status) tickets = tickets.filter((t) => t.status === status);
    if (area) tickets = tickets.filter((t) => t.area === area);
    if (priority) tickets = tickets.filter((t) => t.priorityLevel === priority);
    if (search) {
      const s = search.toLowerCase();
      tickets = tickets.filter(
        (t) =>
          t.title.toLowerCase().includes(s) ||
          String(t.id).includes(s) ||
          (t.requesterName || '').toLowerCase().includes(s)
      );
    }

    tickets.sort((a, b) => b.score - a.score);
    res.json(tickets);
  });

  app.get('/api/tickets/:id', (req, res) => {
    const ticket = store.getTicket(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    refreshPriority(ticket);
    res.json(ticket);
  });

  app.patch('/api/tickets/:id', async (req, res) => {
    const ticket = store.getTicket(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });

    const allowed = ['status', 'assignedTo', 'area', 'urgency'];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }

    store.updateTicket(ticket.id, patch);
    refreshPriority(ticket);
    await store.save();

    res.json(ticket);
  });

  app.post('/api/tickets/:id/messages', async (req, res) => {
    const ticket = store.getTicket(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });

    const { text, from = 'panel', fromName = 'Panel Admin' } = req.body;
    if (!text) return res.status(400).json({ error: 'Texto requerido' });

    store.addTicketMessage(ticket.id, {
      from,
      name: fromName,
      text,
      kind: 'nota_panel'
    });

    await store.save();
    res.json({ ok: true });
  });

  // ============ EMPLOYEES ============
  app.get('/api/employees', (req, res) => {
    const employees = Object.values(store.data.employees);
    res.json(employees);
  });

  app.post('/api/employees', async (req, res) => {
    const { phone, name, area, role } = req.body;
    if (!phone || !name || !area || !role) {
      return res.status(400).json({ error: 'Faltan datos' });
    }
    if (!config.areas.includes(area)) {
      return res.status(400).json({ error: 'Área inválida' });
    }

    const clean = toPhone(phone);
    const employee = store.upsertEmployee(clean, {
      name,
      area,
      role,
      registeredAt: nowISO()
    });

    await store.save();
    res.json(employee);
  });

  app.put('/api/employees/:phone', async (req, res) => {
    const phone = toPhone(req.params.phone);
    const existing = store.getEmployee(phone);
    if (!existing) return res.status(404).json({ error: 'Empleado no encontrado' });

    const { name, area, role } = req.body;
    store.upsertEmployee(phone, {
      name: name || existing.name,
      area: area || existing.area,
      role: role || existing.role
    });

    await store.save();
    res.json(store.getEmployee(phone));
  });

  app.delete('/api/employees/:phone', async (req, res) => {
    const phone = toPhone(req.params.phone);
    if (!store.data.employees[phone]) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }
    delete store.data.employees[phone];
    await store.save();
    res.json({ ok: true });
  });

  // ============ MENSAJES ============
  app.post('/api/messages/send', async (req, res) => {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'Faltan datos' });

    const clean = toPhone(to);
    try {
      const sent = await sendText(`${clean}@s.whatsapp.net`, text);
      res.json({ ok: sent, phone: clean });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/messages/broadcast', async (req, res) => {
    const { area, text } = req.body;
    if (!text) return res.status(400).json({ error: 'Texto requerido' });

    let targets = [];
    if (area && config.areas.includes(area)) {
      targets = Object.values(store.data.employees)
        .filter((e) => e.area === area)
        .map((e) => e.phone);
    } else {
      targets = Object.values(store.data.employees).map((e) => e.phone);
    }

    let sent = 0;
    for (const phone of targets) {
      const ok = await sendText(`${phone}@s.whatsapp.net`, `📢 ${text}`);
      if (ok) sent++;
    }

    res.json({ ok: true, sent, total: targets.length });
  });

  // ============ SETTINGS ============
  app.get('/api/settings', (req, res) => {
    res.json(store.getSettings());
  });

  app.put('/api/settings', async (req, res) => {
    const current = store.getSettings();
    const next = { ...current, ...req.body };
    store.data.settings = next;
    await store.save();
    res.json(next);
  });

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}

module.exports = createAPI;