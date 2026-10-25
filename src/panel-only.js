const path = require('path');
const Store = require('./store');
const { startPanel } = require('./panel');

const config = require('./config');

async function startPanelOnly() {
  const store = new Store(config.dataFile);
  await store.load();

  console.log('🚀 Iniciando panel web en Render...');
  
  startPanel({
    store,
    sendText: async () => false, // No envía mensajes desde Render
    logger: console,
    port: process.env.PANEL_PORT || 10000,
    host: '0.0.0.0'
  });
}

startPanelOnly().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});