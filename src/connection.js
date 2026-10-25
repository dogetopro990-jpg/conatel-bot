const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

class ConnectionManager {
  constructor({ authFolder }) {
    this.authFolder = path.resolve(authFolder);

    this.status = 'disconnected';
    // disconnected | connecting | qrcode | connected | loggedout | error
    this.qr = null;
    this.qrExpiresAt = null;
    this.botPhone = null;
    this.lastError = null;
    this.connectedAt = null;
    this.lastEventAt = new Date().toISOString();

    // Se asignan desde index.js
    this.onUnlink = null;
    this.onReconnect = null;

    if (this.hasSession()) {
      this.status = 'disconnected';
    }
  }

  hasSession() {
    try {
      return fs.existsSync(path.join(this.authFolder, 'creds.json'));
    } catch {
      return false;
    }
  }

  async setQR(rawQR) {
    try {
      const qrDataUrl = await QRCode.toDataURL(rawQR, {
        margin: 2,
        width: 420,
        errorCorrectionLevel: 'M',
        color: {
          dark: '#0f172a',
          light: '#ffffff'
        }
      });

      this.qr = qrDataUrl;
      this.qrExpiresAt = Date.now() + 45000;
      this.status = 'qrcode';
      this.lastError = null;
      this.lastEventAt = new Date().toISOString();
      console.log('   📱 QR generado para el panel (válido ~45 segundos)');
    } catch (error) {
      console.error('❌ Error generando QR:', error.message);
    }
  }

  clearQR() {
    this.qr = null;
    this.qrExpiresAt = null;
  }

  setStatus(status, extra = {}) {
    this.status = status;
    this.lastEventAt = new Date().toISOString();
    Object.assign(this, extra);
  }

  setConnected(phone) {
    this.clearQR();
    this.botPhone = phone;
    this.connectedAt = new Date().toISOString();
    this.lastError = null;
    this.setStatus('connected');
  }

  setLoggedOut(message = 'Sesión desvinculada') {
    this.clearQR();
    this.botPhone = null;
    this.connectedAt = null;
    this.lastError = message;
    this.setStatus('loggedout');
  }

  setError(message) {
    this.lastError = message;
    this.lastEventAt = new Date().toISOString();
  }

  async unlink() {
    if (this.onUnlink) await this.onUnlink();

    try {
      fs.rmSync(this.authFolder, { recursive: true, force: true });
    } catch (error) {
      console.error('❌ Error borrando credenciales:', error.message);
      throw new Error('No se pudieron borrar las credenciales');
    }

    this.setLoggedOut('Sesión eliminada. Escanea el QR para volver a vincular.');
    return { ok: true };
  }

  async reconnect() {
    if (this.status === 'connected') {
      return { ok: false, reason: 'El bot ya está conectado' };
    }
    if (this.onReconnect) await this.onReconnect();
    return { ok: true };
  }

  snapshot() {
    return {
      status: this.status,
      qr: this.qr,
      qrExpiresIn: this.qrExpiresAt ? Math.max(0, Math.ceil((this.qrExpiresAt - Date.now()) / 1000)) : 0,
      botPhone: this.botPhone,
      hasSession: this.hasSession(),
      connectedAt: this.connectedAt,
      uptimeSeconds: this.connectedAt
        ? Math.floor((Date.now() - new Date(this.connectedAt).getTime()) / 1000)
        : 0,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt
    };
  }

  // ✅ MÉTODO NUEVO: Adapta el snapshot al formato que espera el frontend
  getStatus() {
    return {
      status: this.status === 'qrcode' ? 'connecting' : this.status,
      user: this.botPhone,
      hasQR: !!this.qr,
      qrDataUrl: this.qr,
      errorMessage: this.lastError
    };
  }
}

module.exports = ConnectionManager;