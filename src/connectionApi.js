const STATUS_LABELS = {
  disconnected: 'Desconectado',
  connecting: 'Conectando...',
  qrcode: 'Esperando escaneo',
  connected: 'Conectado',
  loggedout: 'Desvinculado',
  error: 'Error de conexión'
};

async function handleConnectionApi(req, res, pathname, method, session, readBody, json, connection) {
  if (!pathname.startsWith('/api/connection/')) return false;

  if (!connection) {
    json(res, 500, { error: 'Gestor de conexión no inicializado' });
    return true;
  }

  // GET status — cualquier usuario autenticado puede VER el estado
  if (pathname === '/api/connection/status' && method === 'GET') {
    const snapshot = connection.snapshot();
    return (json(res, 200, {
      ...snapshot,
      statusLabel: STATUS_LABELS[snapshot.status] || snapshot.status
    }), true);
  }

    // El resto requiere ser ADMIN
  if (session.role !== 'admin') {
    json(res, 403, { error: 'Solo el administrador puede gestionar la vinculación' });
    return true;
  }

  if (pathname === '/api/connection/unlink' && method === 'POST') {
    try {
      const result = await connection.unlink();
      json(res, 200, result);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return true;
  }

  if (pathname === '/api/connection/reconnect' && method === 'POST') {
    try {
      const result = await connection.reconnect();
      json(res, result.ok ? 200 : 409, result);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return true;
  }

  if (pathname === '/api/connection/qr' && method === 'GET') {
    json(res, 200, { qr: connection.qr, expiresAt: connection.qrExpiresAt });
    return true;
  }

  return false;
}

module.exports = { handleConnectionApi, STATUS_LABELS };