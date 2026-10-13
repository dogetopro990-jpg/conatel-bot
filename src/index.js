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
  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (error) {
    logger.error({ err: error.message, jid }, 'Error enviando mensaje');
    return false;
  }
}

async function sendPresence(jid, type) {
  if (!sock || !sock.user?.id || !jid) return false;
  try {
    if (type === 'composing') {
      await sock.sendPresenceUpdate('composing', jid);
    } else {
      await sock.sendPresenceUpdate('paused', jid);
    }
    return true;
  } catch (error) {
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
    logger
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
        logger.info({ bot: botPhoneNumber }, 'Bot conectado a WhatsApp');
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