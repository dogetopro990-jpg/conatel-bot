const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { refreshPriority } = require('./priority');
const { nowISO, toPhone } = require('./utils');

console.log('📦 [API] Cargando módulo api.js...');

function createAPI({ store, sendText, logger }) {
  console.log('🚀 [API] Creando aplicación Express...');
  const app = express();
  
  app.use(cors());
  app.use(express.json());
  
  const publicPath = path.join(__dirname, '..', 'public');
  console.log(`📂 [API] Sirviendo archivos estáticos desde: ${publicPath}`);
  app.use(express.static(publicPath));

  // ============ API: STATS ============
  app.get('/api/stats', (req, res) => {
    console.log('📊 [API] Solicitud a /api/stats');
    const tickets = Object.values(store.data.tickets);
    const open = tickets.filter((t) => ['abierta', 'en_progreso'].includes(t.status));
    
    res.json({
      total: tickets.length,
      open: open.length,
      closed: tickets.filter((t) => t.status === 'cerrada').length,
      employees: Object.keys(store.data.employees).length
    });
  });

  // ============ API: TICKETS ============
  app.get('/api/tickets', (req, res) => {
    let tickets = Object.values(store.data.tickets).map(refreshPriority);
    tickets.sort((a, b) => b.score - a.score);
    res.json(tickets);
  });

  app.get('/api/tickets/:id', (req, res) => {
    const ticket = store.getTicket(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'No encontrado' });
    res.json(ticket);
  });

  app.patch('/api/tickets/:id', async (req, res) => {
    const ticket = store.getTicket(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'No encontrado' });
    
    const allowed = ['status', 'assignedTo', 'area', 'urgency'];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    
    store.updateTicket(ticket.id, patch);
    await store.save();
    res.json(store.getTicket(ticket.id));
  });

  // ============ API: EMPLOYEES ============
  app.get('/api/employees', (req, res) => {
    res.json(Object.values(store.data.employees));
  });

  app.post('/api/employees', async (req, res) => {
    const { phone, name, area, role } = req.body;
    if (!phone || !name || !area || !role) return res.status(400).json({ error: 'Faltan datos' });
    
    const clean = toPhone(phone);
    store.upsertEmployee(clean, { name, area, role, registeredAt: nowISO() });
    await store.save();
    res.json(store.getEmployee(clean));
  });

  app.delete('/api/employees/:phone', async (req, res) => {
    const phone = toPhone(req.params.phone);
    if (store.data.employees[phone]) {
      delete store.data.employees[phone];
      await store.save();
    }
    res.json({ ok: true });
  });

  // ============ API: MENSAJES ============
  app.post('/api/messages/send', async (req, res) => {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'Faltan datos' });
    
    try {
      const sent = await sendText(`${toPhone(to)}@s.whatsapp.net`, text);
      res.json({ ok: sent });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============ API: SETTINGS ============
  app.get('/api/settings', (req, res) => {
    res.json(store.getSettings());
  });

  app.put('/api/settings', async (req, res) => {
    store.data.settings = { ...store.getSettings(), ...req.body };
    await store.save();
    res.json(store.getSettings());
  });

  // ============ FALLBACK PARA REACT/SPA ============
  // Usamos una ruta comodín segura para Express v4/v5
  app.get('/*', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });

  console.log('✅ [API] Configuración de rutas completada.');
  return app;
}

module.exports = createAPI;