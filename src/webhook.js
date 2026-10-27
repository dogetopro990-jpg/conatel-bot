const http = require('http');
const { exec } = require('child_process');

// Usa la misma variable de tu .env o pon una contraseña secreta aquí
const SECRET = process.env.WEBHOOK_SECRET || 'mi_secreto_super_seguro_123';
const PORT = 3001; // Puerto diferente al del panel (3000)

console.log(`🎧 Servidor de actualizaciones escuchando en puerto ${PORT}...`);

const server = http.createServer((req, res) => {
  // GitHub enviará un POST a esta ruta
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    
    req.on('end', () => {
      console.log('🔄 ¡Cambio detectado en GitHub! Iniciando actualización...');
      
      // 1. Descargar los últimos cambios de GitHub
      exec('git pull origin main', (err, stdout, stderr) => {
        if (err) {
          console.error('❌ Error al hacer git pull:', err.message);
          res.writeHead(500);
          res.end('Error en git pull');
          return;
        }
        
        console.log('✅ Código actualizado correctamente.');
        console.log('🔄 Ordenando a PM2 un reinicio graceful (sin perder sesión)...');
        
        // 2. Reiniciar el bot usando PM2
        exec('pm2 reload conatel-bot', (err2) => {
          if (err2) {
            console.error('❌ Error al reiniciar PM2:', err2.message);
          } else {
            console.log('✅ Bot reiniciado con la nueva versión.');
          }
        });
        
        res.writeHead(200);
        res.end('Actualización en proceso');
      });
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Webhook activo y listo para recibir señales de GitHub.`);
});