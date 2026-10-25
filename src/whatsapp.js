const QRCode = require('qrcode');

class WhatsAppManager {
  constructor() {
    this.sock = null;
    this.qr = null;
    this.qrDataUrl = null;
    this.status = 'disconnected'; // disconnected, connecting, connected, logged_out
    this.user = null;
    this.onStatusChange = null; // callback para notificar cambios
  }

  setSocket(sock) {
    this.sock = sock;
  }

  setStatus(status, user = null) {
    this.status = status;
    this.user = user;
    if (this.onStatusChange) {
      this.onStatusChange(status, user);
    }
    console.log(`   📱 Estado WhatsApp: ${status}${user ? ` (${user})` : ''}`);
  }

  async setQR(qrString) {
    this.qr = qrString;
    try {
      this.qrDataUrl = await QRCode.toDataURL(qrString, {
        width: 400,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      });
      console.log(`   📱 QR actualizado`);
    } catch (error) {
      console.error(`   ❌ Error generando QR: ${error.message}`);
      this.qrDataUrl = null;
    }
  }

  getStatus() {
    return {
      status: this.status,
      user: this.user,
      hasQR: !!this.qrDataUrl,
      qrDataUrl: this.qrDataUrl
    };
  }

  async disconnect() {
    if (this.sock) {
      try {
        await this.sock.logout();
        this.setStatus('disconnected');
        this.qr = null;
        this.qrDataUrl = null;
        this.user = null;
        return true;
      } catch (error) {
        console.error(`   ❌ Error al desvincular: ${error.message}`);
        return false;
      }
    }
    return false;
  }
}

// Singleton
let instance = null;
function getWhatsAppManager() {
  if (!instance) {
    instance = new WhatsAppManager();
  }
  return instance;
}

module.exports = { WhatsAppManager, getWhatsAppManager };