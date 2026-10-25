#!/bin/bash
echo "🚀 Iniciando instalación de CONATEL Bot en Raspberry Pi..."

# 1. Actualizar sistema
echo "📦 Actualizando paquetes del sistema..."
sudo apt update && sudo apt upgrade -y

# 2. Instalar Node.js (versión LTS 20.x)
echo "🟢 Instalando Node.js LTS..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
else
    echo "Node.js ya está instalado."
fi

# 3. Instalar dependencias del proyecto
echo "📦 Instalando dependencias de Node.js..."
npm install --production

# 4. Configurar servicio systemd
echo "⚙️  Configurando servicio del sistema..."
sudo cp conatel-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable conatel-bot
sudo systemctl start conatel-bot

echo ""
echo "✅ ¡Instalación completada!"
echo "📊 Para ver el estado: sudo systemctl status conatel-bot"
echo "📝 Para ver los logs: sudo journalctl -u conatel-bot -f"
echo "🌐 El panel está disponible en: http://$(hostname -I | awk '{print $1}'):3000"