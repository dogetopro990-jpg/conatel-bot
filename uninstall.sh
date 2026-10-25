#!/bin/bash
echo "⚠️  Desinstalando CONATEL Bot..."
read -p "¿Estás seguro? Esto detendrá el bot y eliminará el servicio (los datos se mantendrán) [y/N]: " confirm

if [[ $confirm == [yY] || $confirm == [yY][eE][sS] ]]; then
    echo "🛑 Deteniendo servicio..."
    sudo systemctl stop conatel-bot
    sudo systemctl disable conatel-bot
    
    echo "🗑️  Eliminando archivo de servicio..."
    sudo rm /etc/systemd/system/conatel-bot.service
    sudo systemctl daemon-reload
    
    echo "✅ Desinstalación del servicio completada."
    echo "💡 Los datos en la carpeta 'data/' NO fueron eliminados."
else
    echo "❌ Desinstalación cancelada."
fi