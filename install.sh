#!/bin/bash

# Colores para la salida
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}==================================================${NC}"
echo -e "${GREEN}  Instalación y Configuración del Bot CONATEL${NC}"
echo -e "${GREEN}==================================================${NC}"

# Verificar que se ejecuta con permisos de sudo para las partes que lo requieren
if [ "$EUID" -ne 0 ]; then
  echo -e "${YELLOW}⚠️  Se requieren permisos de administrador para algunas instalaciones.${NC}"
  echo -e "${YELLOW}   Se te pedirá tu contraseña cuando sea necesario.${NC}"
fi

# 1. Actualizar sistema e instalar dependencias del SO
echo -e "\n${YELLOW}📦 Paso 1: Instalando dependencias del sistema...${NC}"
sudo apt update -y
sudo apt install -y nodejs npm sqlite3 psmisc curl

# Verificar versión de Node.js (se recomienda v18 o superior)
NODE_VERSION=$(node -v | cut -d 'v' -f 2 | cut -d '.' -f 1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}❌ Error: Se requiere Node.js v18 o superior. Tu versión es v$NODE_VERSION.${NC}"
  echo -e "${YELLOW}💡 Ejecuta: curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt install -y nodejs${NC}"
  exit 1
fi
echo -e "${GREEN}✅ Node.js $(node -v) y dependencias instalados correctamente.${NC}"

# 2. Instalar dependencias de Node.js
echo -e "\n${YELLOW}📦 Paso 2: Instalando dependencias de Node.js (npm install)...${NC}"
npm install
if [ $? -ne 0 ]; then
  echo -e "${RED}❌ Error al instalar dependencias de npm.${NC}"
  exit 1
fi
echo -e "${GREEN}✅ Dependencias de Node.js instaladas.${NC}"

# 3. Configurar archivo de entorno
echo -e "\n${YELLOW}⚙️  Paso 3: Configurando archivo .env...${NC}"
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo -e "${GREEN}✅ Archivo .env creado desde .env.example.${NC}"
    echo -e "${YELLOW}⚠️  IMPORTANTE: Revisa y edita el archivo .env con tus configuraciones reales antes de iniciar.${NC}"
  else
    echo -e "${RED}❌ No se encontró .env.example para copiar.${NC}"
    exit 1
  fi
else
  echo -e "${GREEN}✅ El archivo .env ya existe. Se omite la creación.${NC}"
fi

# 4. Crear directorios necesarios
echo -e "\n${YELLOW}📁 Paso 4: Creando directorios de datos...${NC}"
mkdir -p data auth_info
echo -e "${GREEN}✅ Directorios 'data' y 'auth_info' listos.${NC}"

# 5. Crear el servicio systemd para inicio automático
echo -e "\n${YELLOW}⚙️  Paso 5: Configurando el servicio de inicio automático (systemd)...${NC}"
CURRENT_USER=$(whoami)
SERVICE_FILE="/etc/systemd/system/conatel-bot.service"

sudo tee $SERVICE_FILE > /dev/null << EOF
[Unit]
Description=CONATEL Bot WhatsApp
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$(pwd)

# 1. Matar cualquier proceso que esté ocupando el puerto 3000
ExecStartPre=/bin/bash -c 'fuser -k 3000/tcp 2>/dev/null || true'
# 2. Esperar 15 segundos para que el sistema y el WiFi se estabilicen al encender
ExecStartPre=/bin/sleep 15
# 3. Iniciar el bot
ExecStart=/usr/bin/node src/index.js

# 4. Reiniciar automáticamente si falla
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}✅ Servicio systemd creado en $SERVICE_FILE${NC}"

# 6. Habilitar el servicio
echo -e "\n${YELLOW}🚀 Paso 6: Habilitando el servicio...${NC}"
sudo systemctl daemon-reload
sudo systemctl enable conatel-bot.service

# 7. Iniciar el servicio
echo -e "\n${YELLOW}🚀 Paso 7: Iniciando el bot...${NC}"
sudo systemctl start conatel-bot.service

# 8. Reinicio automático para asegurar que el túnel se conecte limpio
echo -e "\n${YELLOW}🔄 Paso 8: Reiniciando el servicio para asegurar conexión limpia del túnel...${NC}"
sleep 5
sudo systemctl restart conatel-bot.service
sleep 5

# 9. Verificar estado
echo -e "\n${YELLOW}🔍 Verificando estado del servicio...${NC}"
sudo systemctl status conatel-bot.service --no-pager

echo -e "\n${GREEN}==================================================${NC}"
echo -e "${GREEN}  ¡Instalación completada con éxito! 🎉${NC}"
echo -e "${GREEN}==================================================${NC}"
echo -e "💡 Para ver los logs en vivo, usa: ${YELLOW}sudo journalctl -u conatel-bot.service -f${NC}"
echo -e "💡 Para reiniciar el bot manualmente: ${YELLOW}sudo systemctl restart conatel-bot.service${NC}"
echo -e "💡 Recuerda escanear el QR en el panel web si es la primera vez."
echo -e "${GREEN}==================================================${NC}"