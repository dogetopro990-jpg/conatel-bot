const http = require('http');
const fs = require('fs');
const path = require('path');
const Auth = require('./auth');

const config = require('./config');
const { refreshPriority } = require('./priority');
const { nowISO, toPhone } = require('./utils');
const { notifyRequesterOnClose } = require('./tickets');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function json(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1000000) {
        reject(new Error('Cuerpo demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

function setCookie(res, name, value, maxAge = 86400) {
  res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; Max-Age=${maxAge}`);
}

function serveFile(res, pathname) {
  let relative = pathname;
  try {
    relative = decodeURIComponent(pathname);
  } catch {}

  if (relative === '/' || relative === '') relative = '/index.html';

  const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
  const rel = path.relative(PUBLIC_DIR, filePath);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return json(res, 403, { error: 'Acceso denegado' });
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (!path.extname(filePath)) {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        return fs.readFile(indexPath, (err2, data2) => {
          if (err2) {
            return json(res, 404, { error: 'Panel no encontrado' });
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(data2);
        });
      }
      return json(res, 404, { error: 'Archivo no encontrado' });
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function enrichTicket(ticket, store) {
  const employee = store.data.employees?.[ticket.requesterPhone];
  return {
    ...ticket,
    requesterName: employee?.name || ticket.requesterName || 'Desconocido',
    requesterPhone: ticket.requesterPhone
  };
}

function getAllAreas(store) {
  const customAreas = store.data.settings?.customAreas || [];
  return [...config.areas, ...customAreas.filter(a => !config.areas.includes(a))];
}

function startPanel({ store, sendText, logger, port, host }) {
  const serverPort = Number(port || process.env.PANEL_PORT || 3000);
  const serverHost = host || process.env.PANEL_HOST || '0.0.0.0';
  const auth = new Auth(store);

  console.log(`🔧 [PANEL] Preparando servidor en ${serverHost}:${serverPort}...`);

  async function handleApi(req, res, pathname, query) {
    const method = req.method;
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = getCookie(req, 'sessionId');
    const session = auth.validateSession(sessionId);

    // Rutas públicas (sin autenticación)
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const result = await auth.login(body.username, body.password);
      
      if (!result) {
        return json(res, 401, { error: 'Credenciales inválidas' });
      }

      setCookie(res, 'sessionId', result.sessionId);
      return json(res, 200, result);
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      if (sessionId) {
        await auth.logout(sessionId);
        res.setHeader('Set-Cookie', 'sessionId=; Path=/; HttpOnly; Max-Age=0');
      }
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      if (!session) {
        return json(res, 401, { error: 'No autenticado' });
      }
      return json(res, 200, session);
    }

    // Verificar autenticación para el resto de rutas
    if (!session) {
      return json(res, 401, { error: 'No autenticado' });
    }

    // HEALTH
    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, time: nowISO() });
    }

    // USERS (solo admin)
    if (pathname === '/api/users' && method === 'GET') {
      if (session.role !== 'admin') {
        return json(res, 403, { error: 'Sin permisos' });
      }
      const users = await auth.listUsers();
      return json(res, 200, users);
    }

    if (pathname === '/api/users' && method === 'POST') {
      if (session.role !== 'admin') {
        return json(res, 403, { error: 'Sin permisos' });
      }
      const body = await readBody(req);
      try {
        const user = await auth.createUser(body.username, body.password, body.role, body.name);
        return json(res, 200, user);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    if (pathname.startsWith('/api/users/') && method === 'DELETE') {
      if (session.role !== 'admin') {
        return json(res, 403, { error: 'Sin permisos' });
      }
      const username = parts[2];
      try {
        await auth.deleteUser(username);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    // STATS
    if (pathname === '/api/stats' && method === 'GET') {
      const tickets = Object.values(store.data.tickets || {});
      const open = tickets.filter((t) => ['abierta', 'en_progreso'].includes(t.status));
      open.forEach(refreshPriority);

      const areas = getAllAreas(store);
      const byArea = {};
      areas.forEach(a => byArea[a] = 0);

      const byPriority = { baja: 0, media: 0, alta: 0, critica: 0 };
      const byStatus = { abierta: 0, en_progreso: 0, cerrada: 0 };

      tickets.forEach((t) => {
        if (byArea[t.area] !== undefined) byArea[t.area]++;
        if (byPriority[t.priorityLevel] !== undefined) byPriority[t.priorityLevel]++;
        if (byStatus[t.status] !== undefined) byStatus[t.status]++;
      });

      return json(res, 200, {
        total: tickets.length,
        open: open.length,
        closed: tickets.filter((t) => t.status === 'cerrada').length,
        byArea,
        byPriority,
        byStatus,
        employees: Object.keys(store.data.employees || {}).length,
        topTickets: open
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((t) => ({
            id: t.id,
            title: t.title,
            area: t.area,
            priority: t.priorityLevel,
            score: t.score,
            requesterName: enrichTicket(t, store).requesterName
          }))
      });
    }

    // TICKETS
    if (pathname === '/api/tickets' && method === 'GET') {
      let tickets = Object.values(store.data.tickets || {})
        .map(t => enrichTicket(t, store))
        .map(refreshPriority);

      const status = query.get('status');
      const area = query.get('area');
      const priority = query.get('priority');
      const search = query.get('search');

      if (status) tickets = tickets.filter((t) => t.status === status);
      if (area) tickets = tickets.filter((t) => t.area === area);
      if (priority) tickets = tickets.filter((t) => t.priorityLevel === priority);

      if (search) {
        const s = search.toLowerCase();
        tickets = tickets.filter(
          (t) =>
            (t.title || '').toLowerCase().includes(s) ||
            String(t.id).includes(s) ||
            (t.requesterName || '').toLowerCase().includes(s)
        );
      }

      tickets.sort((a, b) => b.score - a.score);
      return json(res, 200, tickets);
    }

    // TICKETS RESUELTOS
    if (pathname === '/api/tickets/resolved' && method === 'GET') {
      let tickets = Object.values(store.data.tickets || {})
        .filter(t => t.status === 'cerrada')
        .map(t => enrichTicket(t, store))
        .map(refreshPriority);

      tickets.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      return json(res, 200, tickets);
    }

    // TICKET BY ID
    if (parts[0] === 'api' && parts[1] === 'tickets' && parts[2]) {
      const id = Number(parts[2]);
      const idStr = String(id);
      const ticket = store.data.tickets[idStr];

      if (!ticket) {
        return json(res, 404, { error: 'Ticket no encontrado' });
      }

      if (method === 'GET' && parts.length === 3) {
        refreshPriority(ticket);
        return json(res, 200, enrichTicket(ticket, store));
      }

      // PATCH (solo admin puede modificar)
      if (method === 'PATCH' && parts.length === 3) {
        if (session.role !== 'admin') {
          return json(res, 403, { error: 'Sin permisos' });
        }

        const body = await readBody(req);
        const patch = {};
        const previousStatus = ticket.status;

        if (body.status && ['abierta', 'en_progreso', 'cerrada'].includes(body.status)) {
          patch.status = body.status;
        }
        if (body.area) patch.area = body.area;
        if (body.urgency && ['baja', 'media', 'alta', 'critica'].includes(body.urgency)) {
          patch.urgency = body.urgency;
        }
        if (body.assignedTo !== undefined) {
          patch.assignedTo = body.assignedTo ? toPhone(body.assignedTo) : null;
        }

        Object.assign(ticket, patch);
        ticket.updatedAt = nowISO();
        
        if (body.observaciones && patch.status === 'cerrada') {
          ticket.messages.push({
            from: 'panel',
            name: 'Panel Admin',
            text: `📝 Observaciones al cerrar:\n${body.observaciones}`,
            kind: 'observacion_cierre',
            at: nowISO()
          });
        }
        
        refreshPriority(ticket);
        await store.save();

        if (patch.status === 'cerrada' && previousStatus !== 'cerrada') {
          notifyRequesterOnClose({ 
            ticket, 
            sendText, 
            logger,
            observaciones: body.observaciones || null
          }).catch(err => {
            console.error(`   ❌ Error notificando cierre: ${err.message}`);
          });
        }

        return json(res, 200, enrichTicket(ticket, store));
      }

      // DELETE (solo admin)
      if (method === 'DELETE' && parts.length === 3) {
        if (session.role !== 'admin') {
          return json(res, 403, { error: 'Sin permisos' });
        }

        console.log(`   🗑️  Eliminando ticket #T-${id}`);
        delete store.data.tickets[idStr];
        await store.save();
        console.log(`   ✅ Ticket #T-${id} eliminado`);
        return json(res, 200, { ok: true, message: `Ticket #T-${id} eliminado` });
      }

      // POST messages (cualquier usuario autenticado puede agregar mensajes)
      if (method === 'POST' && parts[3] === 'messages') {
        const body = await readBody(req);
        if (!body.text) return json(res, 400, { error: 'Texto requerido' });

        ticket.messages.push({
          from: body.from || 'panel',
          name: body.fromName || session.name,
          text: body.text,
          kind: 'nota_panel',
          at: nowISO()
        });

        await store.save();
        return json(res, 200, { ok: true });
      }
    }

    // EMPLOYEES
    if (pathname === '/api/employees' && method === 'GET') {
      return json(res, 200, Object.values(store.data.employees || {}));
    }

    if (pathname === '/api/employees' && method === 'POST') {
      if (session.role !== 'admin') {
        return json(res, 403, { error: 'Sin permisos' });
      }

      const body = await readBody(req);
      const { phone, name, area, role } = body;

      if (!phone || !name || !area || !role) {
        return json(res, 400, { error: 'Faltan datos' });
      }

      const areas = getAllAreas(store);
      if (!areas.includes(area)) {
        return json(res, 400, { error: 'Área inválida' });
      }

      const clean = toPhone(phone);
      const existing = store.data.employees[clean];

      const employee = {
        phone: clean,
        name,
        area,
        role,
        registeredAt: existing?.registeredAt || nowISO()
      };

      store.data.employees[clean] = employee;
      await store.save();
      return json(res, 200, employee);
    }

    if (parts[0] === 'api' && parts[1] === 'employees' && parts[2]) {
      const phone = toPhone(parts[2]);
      const existing = store.data.employees[phone];

      if (method === 'PUT') {
        if (session.role !== 'admin') {
          return json(res, 403, { error: 'Sin permisos' });
        }

        if (!existing) return json(res, 404, { error: 'Empleado no encontrado' });

        const body = await readBody(req);
        const areas = getAllAreas(store);
        if (body.area && !areas.includes(body.area)) {
          return json(res, 400, { error: 'Área inválida' });
        }

        const employee = {
          ...existing,
          name: body.name || existing.name,
          area: body.area || existing.area,
          role: body.role || existing.role
        };

        store.data.employees[phone] = employee;
        await store.save();
        return json(res, 200, employee);
      }

      if (method === 'DELETE') {
        if (session.role !== 'admin') {
          return json(res, 403, { error: 'Sin permisos' });
        }

        if (!existing) return json(res, 404, { error: 'Empleado no encontrado' });

        delete store.data.employees[phone];
        await store.save();
        return json(res, 200, { ok: true });
      }
    }

    // AREAS
    if (pathname === '/api/areas' && method === 'GET') {
      return json(res, 200, getAllAreas(store));
    }

    if (pathname === '/api/areas' && method === 'POST') {
      if (session.role !== 'admin') {
        return json(res, 403, { error: 'Sin permisos' });
      }

      const body = await readBody(req);
      if (!body.area || typeof body.area !== 'string') {
        return json(res, 400, { error: 'Área requerida' });
      }
      
      const settings = store.getSettings();
      const customAreas = settings.customAreas || [];
      
      if (!customAreas.includes(body.area)) {
        customAreas.push(body.area);
        settings.customAreas = customAreas;
        store.data.settings = settings;
        await store.save();
      }
      
      return json(res, 200, { ok: true, areas: getAllAreas(store) });
    }

    if (pathname === '/api/areas' && method === 'DELETE') {
      if (session.role !== 'admin') {
        return json(res, 403, { error: 'Sin permisos' });
      }

      const body = await readBody(req);
      if (!body.area) {
        return json(res, 400, { error: 'Área requerida' });
      }
      
      const settings = store.getSettings();
      const customAreas = settings.customAreas || [];
      settings.customAreas = customAreas.filter(a => a !== body.area);
      store.data.settings = settings;
      await store.save();
      
      return json(res, 200, { ok: true });
    }

    // CONFIG MESSAGES (solo admin)
    if (pathname === '/api/config/messages' && method === 'GET') {
      const settings = store.getSettings();
      return json(res, 200, settings.customMessages || {});
    }

    if (pathname === '/api/config/messages' && method === 'PUT') {
      if (session.role !== 'admin') {
        return json(res, 403, { error: 'Sin permisos' });
      }

      const body = await readBody(req);
      const settings = store.getSettings();
      settings.customMessages = body;
      store.data.settings = settings;
      await store.save();
      
      const { setCustomMessages } = require('./ai');
      setCustomMessages(body);
      
      return json(res, 200, { ok: true });
    }

    // CONFIG GENERAL (solo admin)
    if (pathname === '/api/config/general' && method === 'GET') {
      const settings = store.getSettings();
      return json(res, 200, {
        botName: settings.botName || config.botName,
        minDelayMs: settings.minDelayMs ?? config.minDelayMs,
        maxDelayMs: settings.maxDelayMs ?? config.maxDelayMs,
        priorityThreshold: settings.priorityThreshold ?? config.priorityThreshold,
        autoAlerts: settings.autoAlerts ?? true
      });
    }

    if (pathname === '/api/config/general' && method === 'PUT') {
      if (session.role !== 'admin') {
        return json(res, 403, { error: 'Sin permisos' });
      }

      const body = await readBody(req);
      const settings = store.getSettings();
      
      if (body.botName) settings.botName = body.botName;
      if (typeof body.minDelayMs === 'number') settings.minDelayMs = body.minDelayMs;
      if (typeof body.maxDelayMs === 'number') settings.maxDelayMs = body.maxDelayMs;
      if (typeof body.priorityThreshold === 'number') settings.priorityThreshold = body.priorityThreshold;
      if (typeof body.autoAlerts === 'boolean') settings.autoAlerts = body.autoAlerts;
      
      store.data.settings = settings;
      await store.save();
      
      return json(res, 200, { ok: true });
    }

    // MESSAGES
    if (pathname === '/api/messages/send' && method === 'POST') {
      if (session.role !== 'admin') {
        return json(res, 403, { error: 'Sin permisos' });
      }

      const body = await readBody(req);
      if (!body.to || !body.text) {
        return json(res, 400, { error: 'Faltan datos' });
      }

      const clean = toPhone(body.to);
      try {
        const sent = await sendText(`${clean}@s.whatsapp.net`, body.text);
        return json(res, 200, { ok: sent, phone: clean });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }

    if (pathname === '/api/messages/broadcast' && method === 'POST') {
      if (session.role !== 'admin') {
        return json(res, 403, { error: 'Sin permisos' });
      }

      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'Texto requerido' });

      let targets = Object.values(store.data.employees || {}).map((e) => e.phone);

      if (body.area) {
        targets = Object.values(store.data.employees || {})
          .filter((e) => e.area === body.area)
          .map((e) => e.phone);
      }

      targets = [...new Set(targets.filter(Boolean))];

      let sent = 0;
      for (const phone of targets) {
        try {
          const ok = await sendText(`${phone}@s.whatsapp.net`, `📢 ${body.text}`);
          if (ok) sent++;
        } catch (err) {}
      }

      return json(res, 200, { ok: true, sent, total: targets.length });
    }

    // SETTINGS (legacy)
    if (pathname === '/api/settings' && method === 'GET') {
      return json(res, 200, store.getSettings());
    }

    if (pathname === '/api/settings' && method === 'PUT') {
      if (session.role !== 'admin') {
        return json(res, 403, { error: 'Sin permisos' });
      }

      const body = await readBody(req);
      const current = store.getSettings();
      const next = { ...current, ...body };

      if (typeof body.priorityThreshold === 'number') {
        next.priorityThreshold = Math.max(0, Math.min(100, body.priorityThreshold));
      }

      store.data.settings = next;
      await store.save();

      return json(res, 200, next);
    }

    return json(res, 404, { error: `Ruta no encontrada: ${method} ${pathname}` });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      console.log(`🌐 [PANEL] ${req.method} ${pathname}`);

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname, url.searchParams);
      } else {
        serveFile(res, pathname);
      }
    } catch (error) {
      console.error(`❌ [PANEL] Error: ${error.message}`);
      if (logger) logger.error({ err: error.message }, 'Error en panel');
      json(res, 500, { error: error.message });
    }
  });

  server.on('error', (err) => {
    console.error(`❌ [PANEL] No se pudo iniciar: ${err.code} - ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error(`   El puerto ${serverPort} ya está en uso.`);
    }
  });

  server.listen(serverPort, serverHost, () => {
    console.log('');
    console.log('==========================================');
    console.log('🌐 PANEL WEB INICIADO CORRECTAMENTE');
    console.log(`   Local: http://localhost:${serverPort}`);
    console.log('   Usuario admin: admin / admin123');
    console.log('   Usuario visualizador: visualizador / visual123');
    console.log('==========================================');
    console.log('');
  });

  return server;
}

module.exports = { startPanel };