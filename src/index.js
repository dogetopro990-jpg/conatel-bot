const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const QRCodeTerminal = require('qrcode-terminal');
const pino = require('pino');

const config = require('./config');
const logger = require('./logger');
const Store = require('./store');
const ResponseQueue = require('./queue');
const Handler = require('./handler');
const { startAlerts } = require('./alerts');

const baileysLogger = pino({
  level: process.env.BAILEYS_LOG_LEVEL || 'silent'
});

let sock = null;
let alertsStarted = false;
let reconnecting = false;
let botPhoneNumber = null;

async function sendText(jid, text) {
  if (!sock || !sock.user?.id || !jid || !text) return false;
  
  const timestamp = new Date().toISOString();
  const chatId = jid.split('@')[0];
  const preview = text.length > 50 ? text.substring(0, 50) + '...' : text;
  
  console.log(`\n📤 [${timestamp}]`);
  console.log(`   ENVIADO → ${chatId}`);
  console.log(`   Texto: "${preview}"`);
  
  try {
    await sock.sendMessage(jid, { text });
    console.log(`   ✅ Mensaje enviado correctamente`);
    return true;
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
    logger.error({ err: error.message, jid }, 'Error enviando mensaje');
    return false;
  }
}

async function sendPresence(jid, type) {
  if (!sock || !sock.user?.id || !jid) return false;
  
  const timestamp = new Date().toISOString();
  const chatId = jid.split('@')[0];
  const action = type === 'composing' ? '📝 TYPING' : '⏸️  PAUSED';
  
  console.log(`\n${action} [${timestamp}]`);
  console.log(`   Chat: ${chatId}`);
  
  try {
    if (type === 'composing') {
      await sock.sendPresenceUpdate('composing', jid);
      console.log(`   ✅ Typing activado`);
    } else {
      await sock.sendPresenceUpdate('paused', jid);
      console.log(`   ✅ Typing desactivado`);
    }
    return true;
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
    return false;
  }
}

async function start() {
  const store = new Store(config.dataFile);
  await store.load();

  const responseQueue = new ResponseQueue({
    sendText,
    sendPresence,
    logger,
    minDelay: config.minDelayMs,
    maxDelay: config.maxDelayMs
  });

  const handler = new Handler({
    store,
    responseQueue,
    logger,
    sendText,
    sendPresence
  });

  if (!alertsStarted) {
    alertsStarted = true;
    startAlerts({ sendText, store, logger });
  }

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(config.authFolder);

    sock = makeWASocket({
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      shouldIgnoreJid: () => false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) QRCodeTerminal.generate(qr, { small: true });

      if (connection === 'open') {
        botPhoneNumber = sock.user?.id?.split(':')[0]?.split('@')[0];
        console.log(`\n🟢 [${new Date().toISOString()}] Bot conectado a WhatsApp`);
        console.log(`   Número: ${botPhoneNumber}`);
        console.log(`   Self-test: ${config.selfTest ? 'ACTIVADO' : 'DESACTIVADO'}\n`);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut && !reconnecting) {
          reconnecting = true;
          setTimeout(async () => {
            reconnecting = false;
            await connect();
          }, 4000);
        } else if (code === DisconnectReason.loggedOut) {
          logger.warn('Sesión cerrada. Borra auth_info y vuelve a escanear QR.');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        try {
          await handler.handleMessage(message, botPhoneNumber);
        } catch (error) {
          logger.error({ err: error.message }, 'Error procesando mensaje');
        }
      }
    });
  }

  await connect();
}

start().catch((error) => {
  logger.fatal(error);
  process.exit(1);
});