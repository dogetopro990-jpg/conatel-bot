#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const SQLStore = require('./database');

const JSON_FILE = process.argv[2] || './data/store.json';
const DB_FILE = process.argv[3] || './data/conatel.db';

console.log('🔄 Migrando de JSON a SQLite...\n');

if (!fs.existsSync(JSON_FILE)) {
  console.log(`❌ No se encontró ${JSON_FILE}`);
  console.log('   Uso: node src/migrate.js [ruta_json] [ruta_db]');
  process.exit(1);
}

if (fs.existsSync(DB_FILE)) {
  console.log(`⚠️  La base de datos ${DB_FILE} ya existe.`);
  const answer = require('readline-sync').question('¿Sobrescribir? (s/N): ');
  if (answer.toLowerCase() !== 's') {
    console.log('Cancelado.');
    process.exit(0);
  }
  fs.unlinkSync(DB_FILE);
}

const rawData = fs.readFileSync(JSON_FILE, 'utf-8');
const data = JSON.parse(rawData);

const db = new SQLStore(DB_FILE);

console.log(`📂 Leyendo ${JSON_FILE}...`);
console.log(`   Usuarios: ${Object.keys(data.users || {}).length}`);
console.log(`   Empleados: ${Object.keys(data.employees || {}).length}`);
console.log(`   Tickets: ${Object.keys(data.tickets || {}).length}`);
console.log(`   Áreas custom: ${(data.settings?.customAreas || []).length}`);
console.log('');

// Migrar usuarios
const users = data.users || {};
for (const [username, user] of Object.entries(users)) {
  db.upsertUser({
    username: user.username || username,
    password: user.password,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt
  });
}
console.log(`✅ ${Object.keys(users).length} usuarios migrados`);

// Migrar empleados
const employees = data.employees || {};
for (const [phone, emp] of Object.entries(employees)) {
  db.upsertEmployee(phone, {
    name: emp.name,
    area: emp.area,
    role: emp.role,
    notificationsEnabled: emp.notificationsEnabled !== false,
    registeredAt: emp.registeredAt
  });
}
console.log(`✅ ${Object.keys(employees).length} empleados migrados`);

// Migrar tickets
const tickets = data.tickets || {};
for (const [id, ticket] of Object.entries(tickets)) {
  const messages = ticket.messages || [];
  const ticketData = {
    ...ticket,
    messages: [] // Los insertamos por separado
  };
  const created = db.createTicket(ticketData);
  
  // Insertar mensajes
  for (const msg of messages) {
    db.addTicketMessage(created.id, msg);
  }
}
console.log(`✅ ${Object.keys(tickets).length} tickets migrados`);

// Migrar áreas custom
const customAreas = data.settings?.customAreas || [];
for (const area of customAreas) {
  db.addCustomArea(area);
}
console.log(`✅ ${customAreas.length} áreas custom migradas`);

// Migrar settings
const settings = data.settings || {};
for (const [key, value] of Object.entries(settings)) {
  if (key === 'customAreas') continue; // Ya migradas
  db.setSetting(key, value);
}
console.log(`✅ ${Object.keys(settings).length} settings migrados`);

// Migrar sesiones activas
const activeTickets = data.activeTickets || {};
for (const [chatKey, data] of Object.entries(activeTickets)) {
  db.setActiveTicket(chatKey, data.ticketId, data.expiresAt);
}
console.log(`✅ ${Object.keys(activeTickets).length} sesiones activas migradas`);

// Migrar sesiones de registro
const sessions = data.sessions || {};
for (const [key, session] of Object.entries(sessions)) {
  if (session) db.setSession(key, session);
}
console.log(`✅ ${Object.keys(sessions).length} sesiones de registro migradas`);

console.log('\n🎉 Migración completada');
console.log(`   Base de datos: ${DB_FILE}`);
console.log(`   Tamaño: ${(fs.statSync(DB_FILE).size / 1024).toFixed(1)} KB`);
console.log('\n💡 Siguiente paso: cambia DATA_FILE=./data/conatel.db en .env');
console.log('   y actualiza Store.js para usar SQLStore.\n');

db.close();