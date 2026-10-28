const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const QRCodeTerminal = require('qrcode-terminal');
const pino = require('pino');
const localtunnel = require('localtunnel');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const Store = require('./store');
const SafetyManager = require('./safety');
const SafeQueue = require('./queue');
const Handler = require('./handler');
const ConnectionManager = require('./connection');
const { startAlerts } = require('./alerts');
const { startPanel } = require('./panel');
const { processPendingNotifications } = require('./tickets');
const { toPhone } = require('./utils');

const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });

let sock = null, safeQueue = null, connection = null, handler = null, store = null;
let connecting = false, manualDisconnect = false, reconnectTimer = null;
let alertsStarted = false, panelStarted = false, notificationsStarted = false;
let botPhoneNumber = null, publicUrl = null, tunnel = null;

// ============================================================
// ENVÍO DE MENSAJES
// ============================================================
async function rawSendText(jid, text) {
  if (!sock || !sock.user?.id || !jid || !text) return false;
  try { await sock.sendMessage(jid, { text }); return true; } 
  catch (error) { logger.error({ err: error.message, jid }, 'Error enviando'); return false; }
}

async function sendText(jid, text, options = {}) {
  if (!jid || !text) return false;
  if (!safeQueue) return rawSendText(jid, text);
  const result = await safeQueue.safeSend(jid, text, options);
  return result.sent === true;
}

async function sendPresence(jid, type) {
  if (!sock || !sock.user?.id || !jid) return false;
  try { await sock.sendPresenceUpdate(type === 'composing' ? 'composing' : 'paused', jid); return true; } 
  catch { return false; }
}

// ============================================================
// CIERRE DEL TÚNEL
// ============================================================
async function forceCloseTunnel() {
  if (tunnel) {
    console.log('🔌 Cerrando túnel...');
    try { await tunnel.close(); } catch {}
    tunnel = null;
    publicUrl = null;
    console.log('✅ Túnel cerrado');
  }
}

// ============================================================
// CONEXIÓN WHATSAPP
// ============================================================
function scheduleReconnect() {
  if (reconnectTimer || manualDisconnect) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!manualDisconnect) await connect();
  }, 5000);
}

async function stopConnection() {
  manualDisconnect = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { if (sock) await sock.end(false); } catch (error) { logger.warn({ err: error.message }, 'Cerrando socket'); }
  sock = null;
  botPhoneNumber = null;
  if (connection) connection.clearQR();
}

async function connect() {
  if (connecting) return;
  connecting = true;

  try {
    if (connection) connection.setStatus('connecting');
    const { state, saveCreds } = await useMultiFileAuthState(config.authFolder);
    
    const socket = makeWASocket({
      auth: state, logger: baileysLogger, printQRInTerminal: false,
      markOnlineOnConnect: false, shouldIgnoreJid: () => false,
      browser: ['CONATEL Bot', 'Chrome', '1.0.0']
    });
    sock = socket;
    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
      const { connection: connState, lastDisconnect, qr } = update;

      if (qr) {
        if (connection) await connection.setQR(qr);
        if (!connection || !connection.hasSession()) QRCodeTerminal.generate(qr, { small: true });
        console.log('   👉 Abre el panel para escanear el QR');
      }

      if (connState === 'open') {
        manualDisconnect = false;
        botPhoneNumber = socket.user?.id?.split(':')[0]?.split('@')[0];
        if (connection) connection.setConnected(botPhoneNumber);
        console.log(`\n🟢 [${new Date().toISOString()}] Bot conectado a WhatsApp`);
        console.log(`   Número: ${botPhoneNumber}`);
        console.log(`   Cola global: ACTIVA (delay 2s)\n`);
      }

      if (connState === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.log('⚠️  Sesión cerrada desde WhatsApp. Borrando credenciales...');
          if (connection) connection.setLoggedOut('Sesión cerrada desde el teléfono.');
          try { socket.end(false); } catch {}
          sock = null; 
          botPhoneNumber = null;
          
          // 🗑️ BORRAR CARPETA DE AUTH AUTOMÁTICAMENTE
          const authDir = path.resolve(process.cwd(), config.authFolder || 'auth_info');
          if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log('✅ Carpeta de autenticación eliminada correctamente.');
          }
          return;
        }
        if (manualDisconnect) return;
        if (connection) connection.setError(lastDisconnect?.error?.message || 'Desconexión');
        console.log(`⚠️  Conexión cerrada (${code}). Reintentando en 5s...`);
        scheduleReconnect();
      }
    });

    // ============================================================
    // 📩 MANEJO DE MENSAJES + SOLICITUD DE LINK DEL PANEL
    // ============================================================
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        try {
          if (message.message) {
            const text = (message.message.conversation || message.message?.extendedTextMessage?.text || '').toLowerCase().trim();
            const sender = message.key.remoteJid;
            const cleanPhone = toPhone(sender.split('@')[0]);
            const employee = store ? store.getEmployee(cleanPhone) : null;
            
            // ✅ DETECCIÓN FLEXIBLE: Busca palabras clave en cualquier parte del mensaje
            const keywords = ['panel', 'link', 'url', 'enlace', 'pagina'];
            const hasKeyword = keywords.some(keyword => text.includes(keyword));
            
            if ((employee || message.key.fromMe) && hasKeyword) {
              if (publicUrl) {
                const user = employee ? (employee.role === 'admin' ? 'admin' : 'visualizador') : 'admin';
                const pass = employee ? (employee.role === 'admin' ? 'admin123' : 'visual123') : 'admin123';
                
                await sock.sendMessage(sender, { 
                  text: `🔗 *Link del Panel de Control:*\n\n🌐 ${publicUrl}\n\n👤 Usuario: ${user}\n🔑 Contraseña: ${pass}\n\n⚠️ _Enlace confidencial._` 
                });
                console.log(`📤 Link enviado a: ${employee ? employee.name : 'Tú (Self-test)'} (${cleanPhone})`);
                continue; // ⛔ DETIENE AQUÍ: Evita que la IA procese este mensaje
              } else {
                await sock.sendMessage(sender, { text: '⚠️ El panel se está iniciando. Intenta en unos segundos.' });
                continue;
              }
            }
          }
          // Si no era una petición de link, procesamiento normal de la IA
          await handler.handleMessage(message, botPhoneNumber);
        } catch (error) {
          logger.error({ err: error.message }, 'Error procesando mensaje');
        }
      }
    });

  } catch (error) {
    console.error('❌ Error conectando:', error.message);
    if (connection) connection.setError(error.message);
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

// ============================================================
// ARRANQUE
// ============================================================
async function start() {
  store = new Store(config.dataFile);
  await store.load();

  connection = new ConnectionManager({ authFolder: config.authFolder });
  connection.onUnlink = async () => {
    manualDisconnect = true;
    if (sock) { try { await sock.logout(); } catch {} sock = null; botPhoneNumber = null; }
  };
  connection.onReconnect = async () => {
    console.log('🔄 Solicitando nuevo código QR...');
    if (sock) { try { await sock.end(false); } catch {} sock = null; }
    connection.clearQR(); connection.setStatus('connecting');
    setTimeout(async () => { manualDisconnect = false; await connect(); }, 1500);
  };

  const safety = new SafetyManager(store);
  safeQueue = new SafeQueue({ sendText: rawSendText, sendPresence, logger, safety, minDelay: config.minDelayMs, maxDelay: config.maxDelayMs });
  handler = new Handler({ store, responseQueue: safeQueue, safeQueue, safety, logger, sendText, sendPresence });

  if (!panelStarted) { 
    panelStarted = true; 
    try { startPanel({ store, sendText, logger, safety, safeQueue, connection }); } 
    catch (error) { console.error('❌ Error panel:', error); } 
  }
  
  if (!alertsStarted) { alertsStarted = true; startAlerts({ sendText, store, logger }); }
  if (!notificationsStarted) {
    notificationsStarted = true;
    setInterval(async () => { 
      try { await processPendingNotifications({ store, sendText, logger }); } 
      catch (error) { logger.error({ err: error.message }, 'Error notificaciones'); } 
    }, 60000);
  }

  // ============================================================
  // 🌍 TÚNEL LOCALTUNNEL - URL PERSONALIZADA ESTABLE
  // ============================================================
  if (!publicUrl) {
    const portToUse = Number(process.env.PANEL_PORT || config.port || 3000);
    
    console.log('');
    console.log('🌍 ==========================================');
    console.log('🌍 Iniciando túnel LocalTunnel');
    console.log('🌍 ✅ Estrategia: URL estable sin página fea');
    console.log('🌍 ==========================================');
    console.log('');

    // 1. Definir la URL objetivo (la guardada o la por defecto)
    const savedUrl = store.getSetting('publicUrl');
    let targetSubdomain = 'conatel-bot-05-12-1995'; // Tu URL preferida por defecto
    
    if (savedUrl && savedUrl.includes('.loca.lt')) {
      const match = savedUrl.match(/https:\/\/([a-z0-9-]+)\.loca\.lt/i);
      if (match) {
        targetSubdomain = match[1];
        console.log(`💾 URL anterior detectada: ${targetSubdomain}.loca.lt`);
      }
    } else {
      console.log(`🎯 URL objetivo: ${targetSubdomain}.loca.lt`);
    }

    let tunnelCreated = false;
    let attempts = 0;
    const maxAttempts = 3; // Intentamos 3 veces obtener ESA URL específica

    while (!tunnelCreated && attempts < maxAttempts) {
      attempts++;
      console.log(`🔄 Intento ${attempts}/${maxAttempts}: Solicitando "${targetSubdomain}"...`);
      
      try {
        const tunnelOptions = { port: portToUse, subdomain: targetSubdomain };
        tunnel = await localtunnel(tunnelOptions);
        const actualUrl = tunnel.url;
        const actualMatch = actualUrl.match(/https:\/\/([a-z0-9-]+)\.loca\.lt/i);
        
        // Verificar si LocalTunnel respetó el subdominio que pedimos
        if (actualMatch && actualMatch[1] === targetSubdomain) {
          console.log('✅ ¡ÉXITO! LocalTunnel respetó tu URL personalizada');
          publicUrl = actualUrl;
          tunnelCreated = true;
        } else {
          console.log(`⚠️  LocalTunnel asignó: ${actualUrl} (no es la URL personalizada)`);
          try { await tunnel.close(); } catch {}
          tunnel = null;
          
          if (attempts < maxAttempts) {
            console.log('⏳ Esperando 5 segundos antes del siguiente intento...');
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      } catch (error) {
        console.log(`❌ Intento ${attempts} falló: ${error.message}`);
        if (attempts < maxAttempts) {
          console.log('⏳ Esperando 5 segundos antes del siguiente intento...');
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }

    // 2. Resultado final
    if (tunnelCreated && publicUrl) {
      // ✅ Guardar la URL exitosa en la BD para el próximo reinicio
      store.setSetting('publicUrl', publicUrl);
      
      console.log('');
      console.log('🌍 ==========================================');
      console.log('🌍 ✅ PANEL ONLINE ACTIVO:');
      console.log(`🌍 ${publicUrl}`);
      console.log('🌍 ==========================================');
      console.log('💡 Esta URL se guardó en la base de datos.');
      console.log('💡 Tu tunnel-welcome.html se verá directo.');
      console.log('');

      tunnel.on('close', () => {
        console.log('⚠️  Túnel cerrado por el servidor. El panel sigue disponible en local.');
        publicUrl = null;
        tunnel = null;
      });
    } else {
      // ❌ AVISO DE ERROR: No se generará URL aleatoria
      console.log('');
      console.log('🌍 ==========================================');
      console.log('❌ ERROR: No se pudo obtener la URL personalizada.');
      console.log(`⚠️  El subdominio "${targetSubdomain}" podría estar en uso temporalmente`);
      console.log('⚠️  o LocalTunnel está teniendo problemas.');
      console.log('💡 El PANEL WEB sigue disponible en tu red local:');
      console.log(`💡 http://localhost:${portToUse}`);
      console.log('💡 Consejo: Espera 2-3 minutos y vuelve a ejecutar "npm start".');
      console.log('🌍 ==========================================');
      console.log('');
    }
  }

  await connect();
}

// ============================================================
// CIERRE LIMPIO
// ============================================================
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 Cerrando...`);
  manualDisconnect = true;
  await forceCloseTunnel();
  await stopConnection();
  console.log('✅ Bot detenido correctamente');
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

start().catch((error) => { logger.fatal(error); process.exit(1); });