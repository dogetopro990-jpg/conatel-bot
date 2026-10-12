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
const MessageQueue = require('./queue');
const Handler = require('./handler');
const { startAlerts } = require('./alerts');

const baileysLogger = pino({
  level: process.env.BAILEYS_LOG_LEVEL || 'silent'
});

let sock = null;
let alertsStarted = false;

const queue = new MessageQueue({
  minDelay: config.minDelayMs,
  maxDelay: config.maxDelayMs,
  logger
});

async function sendText(jid, text) {
  if (!sock || !sock.user?.id || !jid || !text) return false;

  return queue.add(async () => {
    try {
      await sock.sendMessage(jid, { text });
      return true;
    } catch (error) {
      logger.error({ err: error.message, jid }, 'Error enviando mensaje');
      return false;
    }
  });
}

async function start() {
  const store = new Store(config.dataFile);
  await store.load();

  const handler = new Handler({
    store,
    sendText,
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
      markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        QRCodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'open') {
        logger.info('Bot conectado a WhatsApp');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;

        if (code !== DisconnectReason.loggedOut) {
          setTimeout(connect, 4000);
        } else {
          logger.warn('Sesión cerrada. Borra auth_info y vuelve a escanear QR.');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        try {
          await handler.handleMessage(message);
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