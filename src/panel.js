const http = require('http');
const fs = require('fs');
const path = require('path');
const Auth = require('./auth');

const config = require('./config');
const { refreshPriority } = require('./priority');
const { nowISO, toPhone } = require('./utils');
// ✅ Importamos las funciones de notificación y estado
const { notifyRequesterOnClose, renumberTickets, setEmployeeState, getNaturalAssignmentMessage } = require('./tickets');

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

function serveFile(req, res, pathname) {
  let relative = pathname;
  try { relative = decodeURIComponent(pathname); } catch {}

  const host = req.headers.host || '';
  const isLocalTunnel = host.includes('loca.lt');

  if (isLocalTunnel && (relative === '/' || relative === '')) {
    const welcomePath = path.join(PUBLIC_DIR, 'tunnel-welcome.html');
    fs.readFile(welcomePath, (err, data) => {
      if (err) {
        const loginPath = path.join(PUBLIC_DIR, 'login.html');
        fs.readFile(loginPath, (err2, data2) => {
          if (err2) return json(res, 404, { error: 'Panel no encontrado' });
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(data2);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(data);
    });
    return;
  }

  if (relative === '/' || relative === '') relative = '/login.html';

  const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
  const rel = path.relative(PUBLIC_DIR, filePath);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return json(res, 403, { error: 'Acceso denegado' });
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (!path.extname(filePath)) {
        const indexPath = path.join(PUBLIC_DIR, 'login.html');
        return fs.readFile(indexPath, (err2, data2) => {
          if (err2) return json(res, 404, { error: 'Panel no encontrado' });
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

// ✅ CORRECCIÓN CLAVE: Limpia el teléfono para asegurar que coincida con el registro del empleado
function enrichTicket(ticket, store) {
  if (!ticket) return null;
  const cleanPhone = ticket.requesterPhone ? String(ticket.requesterPhone).replace(/\D/g, '') : null;
  const employee = cleanPhone ? store.getEmployee(cleanPhone) : null;
  
  const finalName = (employee && employee.name) ? employee.name : (ticket.requesterName || 'Solicitante');
  const finalPhone = cleanPhone || ticket.requesterPhone || 'Sin teléfono';

  return {
    ...ticket,
    requesterName: finalName,
    requesterPhone: finalPhone
  };
}

function getAllAreas(store) {
  const configAreas = config.areas || [];
  const customAreas = store.getCustomAreas() || [];
  return [...new Set([...configAreas, ...customAreas])];
}

function startPanel({ store, sendText, logger, port, host, safety, safeQueue, connection }) {
  const serverPort = Number(port || process.env.PANEL_PORT || 3000);
  const serverHost = host || process.env.PANEL_HOST || '0.0.0.0';
  const auth = new Auth(store);

  console.log(`🔧 [PANEL] Preparando servidor en ${serverHost}:${serverPort}...`);

  async function handleApi(req, res, pathname, query) {
    const method = req.method;
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = getCookie(req, 'sessionId');
    const session = auth.validateSession(sessionId);

    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const result = await auth.login(body.username, body.password);
      if (!result) return json(res, 401, { error: 'Credenciales inválidas' });
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

    if (pathname === '/api/auth/register' && method === 'POST') {
      const body = await readBody(req);
      try {
        const result = await auth.registerPublic(body.username, body.password, body.name);
        return json(res, 200, result);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      if (!session) return json(res, 401, { error: 'No autenticado' });
      return json(res, 200, session);
    }

    if (pathname === '/api/health') return json(res, 200, { ok: true, time: nowISO() });
    if (!session) return json(res, 401, { error: 'No autenticado' });

    // ================= USUARIOS =================
    if (pathname === '/api/users' && method === 'GET') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      return json(res, 200, await auth.listUsers());
    }
    if (pathname === '/api/users' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      try {
        const user = await auth.createUser(body.username, body.password, body.role, body.name);
        return json(res, 200, user);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (pathname.startsWith('/api/users/') && method === 'DELETE') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      try {
        await auth.deleteUser(parts[2]);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    // ================= STATS =================
    if (pathname === '/api/stats' && method === 'GET') {
      const tickets = Object.values(store.data.tickets || {});
      const open = tickets.filter(t => ['abierta', 'en_progreso'].includes(t.status));
      open.forEach(refreshPriority);

      const areas = getAllAreas(store);
      const byArea = {}, byPriority = { baja: 0, media: 0, alta: 0, critica: 0 }, byStatus = { abierta: 0, en_progreso: 0, cerrada: 0 };
      areas.forEach(a => byArea[a] = 0);

      tickets.forEach(t => {
        if (byArea[t.area] !== undefined) byArea[t.area]++;
        if (byPriority[t.priorityLevel] !== undefined) byPriority[t.priorityLevel]++;
        if (byStatus[t.status] !== undefined) byStatus[t.status]++;
      });

      return json(res, 200, {
        total: tickets.length, open: open.length, closed: tickets.filter(t => t.status === 'cerrada').length,
        byArea, byPriority, byStatus, employees: Object.keys(store.data.employees || {}).length,
        topTickets: open.sort((a, b) => b.score - a.score).slice(0, 5).map(t => ({
          id: t.id, ticketId: t.ticketId || `T-${t.id}`, title: t.title, area: t.area,
          priority: t.priorityLevel, score: t.score, requesterName: enrichTicket(t, store).requesterName
        }))
      });
    }

    // ================= TICKETS =================
    if (pathname === '/api/tickets' && method === 'GET') {
      let tickets = Object.values(store.data.tickets || {}).map(t => enrichTicket(t, store)).map(refreshPriority);
      const status = query.get('status'), area = query.get('area'), priority = query.get('priority'), search = query.get('search');
      if (status) tickets = tickets.filter(t => t.status === status);
      if (area) tickets = tickets.filter(t => t.area === area);
      if (priority) tickets = tickets.filter(t => t.priorityLevel === priority);
      if (search) {
        const s = search.toLowerCase();
        tickets = tickets.filter(t => (t.title || '').toLowerCase().includes(s) || String(t.id).includes(s) || (t.ticketId || '').toLowerCase().includes(s) || (t.requesterName || '').toLowerCase().includes(s));
      }
      tickets.sort((a, b) => b.score - a.score);
      return json(res, 200, tickets);
    }

    if (pathname === '/api/tickets/resolved' && method === 'GET') {
      const tickets = Object.values(store.data.tickets || {}).filter(t => t.status === 'cerrada').map(t => enrichTicket(t, store)).map(refreshPriority).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      return json(res, 200, tickets);
    }

    if (parts[0] === 'api' && parts[1] === 'tickets' && parts[2]) {
      const id = Number(parts[2]);
      if (isNaN(id)) return json(res, 400, { error: 'ID de ticket inválido' });

      // ✅ DELETE PRIMERO: Idempotente, evita error "no encontrado" en doble clic
      if (method === 'DELETE' && parts.length === 3) {
        if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
        try {
          store.deleteTicket(id);
          store.renumberTickets();
          console.log(`🗑️ [PANEL] Ticket #${id} eliminado correctamente`);
          return json(res, 200, { ok: true, message: `Ticket #${id} eliminado correctamente` });
        } catch (error) {
          console.error(`❌ [PANEL] Error al eliminar ticket ${id}:`, error.message);
          return json(res, 500, { error: `Error al eliminar: ${error.message}` });
        }
      }

      // Para GET, PATCH y POST, SÍ necesitamos que el ticket exista
      const ticket = store.getTicket(id);
      if (!ticket) return json(res, 404, { error: 'Ticket no encontrado' });

      if (method === 'GET' && parts.length === 3) {
        refreshPriority(ticket);
        return json(res, 200, enrichTicket(ticket, store));
      }

      if (method === 'PATCH' && parts.length === 3) {
        if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
        const body = await readBody(req);
        const previousStatus = ticket.status;
        const previousAssignee = ticket.assignedTo;
        const changes = {};

        if (body.status && ['abierta', 'en_progreso', 'cerrada'].includes(body.status)) changes.status = body.status;
        if (body.area) changes.area = body.area;
        if (body.urgency && ['baja', 'media', 'alta', 'critica'].includes(body.urgency)) changes.urgency = body.urgency;
        if (body.priorityLevel && ['baja', 'media', 'alta', 'critica'].includes(body.priorityLevel)) {
          changes.priorityLevel = body.priorityLevel;
          changes.manualPriority = true;
        }
        
        if (body.assignedTo !== undefined) {
          const rawPhone = body.assignedTo ? String(body.assignedTo).trim() : "";
          changes.assignedTo = rawPhone.length >= 8 ? toPhone(rawPhone) : null;
        }
        changes.updatedAt = nowISO();

        const updated = store.updateTicket(id, changes);

        // ✅ Notificar y cambiar estado si se asignó a alguien nuevo
        if (changes.assignedTo && changes.assignedTo !== previousAssignee) {
          const employee = store.getEmployee(changes.assignedTo);
          if (employee) {
            setEmployeeState(changes.assignedTo, 'trabajando', updated.id);
            const message = getNaturalAssignmentMessage(updated, employee.name);
            if (safeQueue) {
              safeQueue.sendProactive(`${changes.assignedTo}@s.whatsapp.net`, message).catch(err => console.error(`❌ Error en cola: ${err.message}`));
            } else if (sendText) {
              sendText(`${changes.assignedTo}@s.whatsapp.net`, message).catch(err => console.error(`❌ Error al notificar: ${err.message}`));
            }
            console.log(`📤 Notificación de asignación enviada a ${employee.name} desde el panel`);
          }
        }

        if (body.observaciones && changes.status === 'cerrada') {
          updated.messages.push({ from: 'panel', name: session.name, text: `📝 Observaciones al cerrar:\n${body.observaciones}`, kind: 'observacion_cierre', at: nowISO() });
        }

        if (!changes.manualPriority) refreshPriority(updated);

        if (changes.status === 'cerrada' && previousStatus !== 'cerrada') {
          notifyRequesterOnClose({ ticket: updated, sendText, logger, observaciones: body.observaciones || null, store }).catch(err => console.error(`❌ Error notificando cierre: ${err.message}`));
        }

        return json(res, 200, enrichTicket(updated, store));
      }

      if (method === 'POST' && parts[3] === 'messages') {
        const body = await readBody(req);
        if (!body.text) return json(res, 400, { error: 'Texto requerido' });

        const current = store.getTicket(id);
        const cleanFromPhone = body.from ? String(body.from).replace(/\D/g, '') : 'panel';
        const employee = cleanFromPhone !== 'panel' ? store.getEmployee(cleanFromPhone) : null;
        const displayName = (employee && employee.name) ? employee.name : (body.fromName || session.name || 'Panel');

        current.messages.push({ from: cleanFromPhone, name: displayName, text: body.text, kind: 'nota_panel', at: nowISO() });
        store.updateTicket(id, { updatedAt: nowISO() });
        return json(res, 200, { ok: true });
      }
    }

    // ================= EMPLEADOS =================
    if (pathname === '/api/employees' && method === 'GET') return json(res, 200, Object.values(store.data.employees || {}));
    
    if (pathname === '/api/employees' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      if (!body.phone || !body.name || !body.area || !body.role) return json(res, 400, { error: 'Faltan datos' });
      const areas = getAllAreas(store);
      if (!areas.includes(body.area)) return json(res, 400, { error: 'Área inválida' });
      const clean = toPhone(body.phone);
      store.upsertEmployee(clean, { name: body.name, area: body.area, role: body.role, notificationsEnabled: body.notificationsEnabled ?? true });
      return json(res, 200, store.getEmployee(clean));
    }

    if (parts[0] === 'api' && parts[1] === 'employees' && parts[2]) {
      const phone = toPhone(parts[2]);
      const existing = store.getEmployee(phone);
      if (method === 'PUT') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
        if (!existing) return json(res, 404, { error: 'Empleado no encontrado' });
        const body = await readBody(req);
        const areas = getAllAreas(store);
        if (body.area && !areas.includes(body.area)) return json(res, 400, { error: 'Área inválida' });
        store.upsertEmployee(phone, { name: body.name || existing.name, area: body.area || existing.area, role: body.role || existing.role, notificationsEnabled: body.notificationsEnabled ?? existing.notificationsEnabled });
        return json(res, 200, store.getEmployee(phone));
      }
      if (method === 'DELETE') {
        if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
        if (!existing) return json(res, 404, { error: 'Empleado no encontrado' });
        store.deleteEmployee(phone);
        return json(res, 200, { ok: true });
      }
    }

    if (pathname === '/api/employees/bulk' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      const employees = body.employees || [];
      const createAreas = body.createAreas ?? false;
      if (!Array.isArray(employees) || employees.length === 0) return json(res, 400, { error: 'No se enviaron empleados' });
      if (employees.length > 200) return json(res, 400, { error: 'Máximo 200 empleados por importación' });

      const results = { created: 0, updated: 0, errors: [] };
      let allAreas = getAllAreas(store);

      for (let i = 0; i < employees.length; i++) {
        const emp = employees[i];
        if (!emp.name?.trim() || !emp.phone?.trim() || !emp.area?.trim() || !emp.role?.trim()) {
          results.errors.push({ row: i + 1, error: 'Faltan datos' }); continue;
        }
        const cleanPhone = toPhone(String(emp.phone).trim());
        if (cleanPhone.length < 8) { results.errors.push({ row: i + 1, error: `Teléfono inválido: ${emp.phone}` }); continue; }

        let area = String(emp.area).trim();
        if (!allAreas.includes(area)) {
          if (createAreas) { store.addCustomArea(area); allAreas = getAllAreas(store); }
          else { results.errors.push({ row: i + 1, error: `Área no existe: ${area}` }); continue; }
        }

        const existing = store.getEmployee(cleanPhone);
        store.upsertEmployee(cleanPhone, { name: emp.name.trim(), area, role: emp.role.trim(), notificationsEnabled: existing?.notificationsEnabled ?? true });
        existing ? results.updated++ : results.created++;
      }
      return json(res, 200, results);
    }

    // ================= ÁREAS =================
    if (pathname === '/api/areas' && method === 'GET') {
      return json(res, 200, [...new Set([...(config.areas || []), ...(store.getCustomAreas() || [])])]);
    }
    if (pathname === '/api/areas' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      if (!body.area || typeof body.area !== 'string') return json(res, 400, { error: 'Área requerida' });
      store.addCustomArea(body.area);
      return json(res, 200, { ok: true, areas: getAllAreas(store) });
    }
    if (pathname === '/api/areas' && method === 'DELETE') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      if (!body.area) return json(res, 400, { error: 'Área requerida' });
      store.removeCustomArea(body.area);
      return json(res, 200, { ok: true });
    }

    // ================= CONFIGURACIÓN =================
    if (pathname === '/api/config/messages' && method === 'GET') return json(res, 200, store.getSettings().customMessages || {});
    if (pathname === '/api/config/messages' && method === 'PUT') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      store.setSetting('customMessages', body);
      require('./ai').setCustomMessages(body);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/config/general' && method === 'GET') {
      const s = store.getSettings();
      return json(res, 200, { botName: s.botName || config.botName, minDelayMs: s.minDelayMs ?? config.minDelayMs, maxDelayMs: s.maxDelayMs ?? config.maxDelayMs, priorityThreshold: s.priorityThreshold ?? config.priorityThreshold, autoAlerts: s.autoAlerts ?? true });
    }
    if (pathname === '/api/config/general' && method === 'PUT') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      const s = store.getSettings();
      if (body.botName) s.botName = body.botName;
      if (typeof body.minDelayMs === 'number') s.minDelayMs = body.minDelayMs;
      if (typeof body.maxDelayMs === 'number') s.maxDelayMs = body.maxDelayMs;
      if (typeof body.priorityThreshold === 'number') s.priorityThreshold = body.priorityThreshold;
      if (typeof body.autoAlerts === 'boolean') s.autoAlerts = body.autoAlerts;
      Object.keys(s).forEach(k => store.setSetting(k, s[k]));
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/config/alerts' && method === 'GET') {
      const s = store.getSettings();
      return json(res, 200, { autoAlerts: s.autoAlerts ?? true, notifyRequester: s.notifyRequester ?? true, notifyAssignee: s.notifyAssignee ?? true });
    }
    if (pathname === '/api/config/alerts' && method === 'PUT') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      if (typeof body.autoAlerts === 'boolean') store.setSetting('autoAlerts', body.autoAlerts);
      if (typeof body.notifyRequester === 'boolean') store.setSetting('notifyRequester', body.notifyRequester);
      if (typeof body.notifyAssignee === 'boolean') store.setSetting('notifyAssignee', body.notifyAssignee);
      return json(res, 200, { ok: true });
    }

    // ================= SEGURIDAD =================
    if (pathname === '/api/config/safety' && method === 'GET') {
      if (!safety) return json(res, 500, { error: 'Safety no inicializado' });
      return json(res, 200, { config: safety.config, stats: safety.getStats() });
    }
    if (pathname === '/api/config/safety' && method === 'PUT') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      if (!safety) return json(res, 500, { error: 'Safety no inicializado' });
      Object.assign(safety.config, await readBody(req));
      safety.saveConfig();
      return json(res, 200, { ok: true, config: safety.config });
    }
    if (pathname === '/api/config/safety/reset' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      if (!safety) return json(res, 500, { error: 'Safety no inicializado' });
      safety.reset();
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/config/safety/pause' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      if (!safety) return json(res, 500, { error: 'Safety no inicializado' });
      const body = await readBody(req);
      if (body.pause) { safety.paused = true; safety.pauseUntil = Date.now() + (body.duration || 1800000); }
      else { safety.paused = false; safety.pauseUntil = null; }
      return json(res, 200, { ok: true, paused: safety.paused });
    }

    // ================= COLA =================
    if (pathname === '/api/queue/status' && method === 'GET') {
      if (!safeQueue) return json(res, 500, { error: 'Cola no inicializada' });
      return json(res, 200, safeQueue.getStats());
    }
    if (pathname === '/api/queue/clear' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      if (!safeQueue) return json(res, 500, { error: 'Cola no inicializada' });
      return json(res, 200, { ok: true, cleared: safeQueue.clearQueue() });
    }

    // ================= RED =================
    if (pathname === '/api/network/info' && method === 'GET') {
      const info = require('./network').getSystemInfo();
      const publicUrl = store.getSetting('publicUrl');
      const localUrls = info.localIPs.map(ip => ({ label: ip.label, url: `http://${ip.address}:${serverPort}` }));
      if (publicUrl) localUrls.push({ label: '🌍 Público (Túnel)', url: publicUrl });
      return json(res, 200, { ...info, port: serverPort, localUrls, tunnel: store.getSetting('tunnel', { enabled: false, url: null }) });
    }
    if (pathname === '/api/network/tunnel' && method === 'PUT') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      store.setSetting('tunnel', { enabled: body.enabled ?? false, type: body.type || 'localhost.run', url: body.url || null, updatedAt: nowISO() });
      return json(res, 200, { ok: true });
    }

    // ================= BASE DE DATOS =================
    if (pathname === '/api/database/schema' && method === 'GET') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      return json(res, 200, store.getSchema());
    }
    if (pathname === '/api/database/query' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      if (!body.sql || typeof body.sql !== 'string') return json(res, 400, { error: 'Consulta SQL requerida' });
      const sqlLower = body.sql.toLowerCase().trim();
      if (sqlLower.includes('drop table') || sqlLower.includes('delete from sqlite_master')) return json(res, 403, { error: 'Operación peligrosa bloqueada' });
      try { return json(res, 200, store.executeQuery(body.sql)); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }

    // ================= WHATSAPP =================
    if (pathname === '/api/whatsapp/status' && method === 'GET') {
      if (!connection) return json(res, 500, { error: 'Gestor de conexión no disponible' });
      return json(res, 200, connection.getStatus());
    }
    if (pathname === '/api/whatsapp/disconnect' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      if (!connection) return json(res, 500, { error: 'Gestor de conexión no disponible' });
      try { await connection.unlink(); return json(res, 200, { ok: true }); }
      catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (pathname === '/api/whatsapp/reconnect' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      if (!connection) return json(res, 500, { error: 'Gestor de conexión no disponible' });
      try { await connection.reconnect(); return json(res, 200, { ok: true, message: 'Solicitando nuevo QR...' }); }
      catch (error) { return json(res, 500, { error: error.message }); }
    }

    // ================= MENSAJES =================
    if (pathname === '/api/messages/send' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      if (!body.to || !body.text) return json(res, 400, { error: 'Faltan datos' });
      const clean = toPhone(body.to);
      if (safeQueue) {
        const result = await safeQueue.safeSend(`${clean}@s.whatsapp.net`, body.text);
        return json(res, result.sent ? 200 : 429, { ok: result.sent, phone: clean, reason: result.reason });
      }
      try {
        const sent = await sendText(`${clean}@s.whatsapp.net`, body.text);
        return json(res, 200, { ok: sent, phone: clean });
      } catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (pathname === '/api/messages/broadcast' && method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'Texto requerido' });
      if (safety && !safety.config.broadcastEnabled) return json(res, 400, { error: 'Broadcast deshabilitado' });
      
      let targets = Object.values(store.data.employees || {}).filter(e => e.notificationsEnabled !== false).map(e => e.phone);
      if (body.area) targets = Object.values(store.data.employees || {}).filter(e => e.area === body.area && e.notificationsEnabled !== false).map(e => e.phone);
      targets = [...new Set(targets.filter(Boolean))];
      if (targets.length === 0) return json(res, 400, { error: 'No hay destinatarios válidos' });

      if (safeQueue) {
        const results = await safeQueue.safeBroadcast(targets, `📢 ${body.text}`, Object.values(store.data.employees || {}));
        return json(res, 200, { ok: true, sent: results.filter(r => r.sent).length, total: targets.length, failed: results.filter(r => !r.sent).map(f => ({ phone: f.phone, reason: f.reason })) });
      }
      return json(res, 400, { error: 'Cola no disponible' });
    }

    // ================= SETTINGS LEGACY =================
    if (pathname === '/api/settings' && method === 'GET') return json(res, 200, store.getSettings());
    if (pathname === '/api/settings' && method === 'PUT') {
      if (session.role !== 'admin') return json(res, 403, { error: 'Sin permisos' });
      const body = await readBody(req);
      const next = { ...store.getSettings(), ...body };
      if (typeof body.priorityThreshold === 'number') next.priorityThreshold = Math.max(0, Math.min(100, body.priorityThreshold));
      Object.entries(next).forEach(([k, v]) => store.setSetting(k, v));
      return json(res, 200, next);
    }

    return json(res, 404, { error: `Ruta no encontrada: ${method} ${pathname}` });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url.pathname, url.searchParams);
      else serveFile(req, res, url.pathname);
    } catch (error) {
      console.error(`❌ [PANEL] Error: ${error.message}`);
      if (logger) logger.error({ err: error.message }, 'Error en panel');
      if (!res.headersSent) json(res, 500, { error: error.message });
    }
  });

  server.on('error', (err) => console.error(`❌ [PANEL] No se pudo iniciar: ${err.code} - ${err.message}`));
  server.listen(serverPort, serverHost, () => {
    console.log('\n==========================================');
    console.log('🌐 PANEL WEB INICIADO CORRECTAMENTE');
    console.log(`   Local: http://localhost:${serverPort}`);
    console.log('==========================================\n');
  });

  return server;
}

module.exports = { startPanel };