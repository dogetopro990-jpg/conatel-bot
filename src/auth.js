const crypto = require('crypto');

class Auth {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();
    
    // Crear usuarios por defecto si no existen
    if (!this.store.data.users) {
      this.store.data.users = {
        'admin': {
          username: 'admin',
          password: this.hashPassword('admin123'),
          role: 'admin',
          name: 'Administrador',
          createdAt: new Date().toISOString()
        },
        'visualizador': {
          username: 'visualizador',
          password: this.hashPassword('visual123'),
          role: 'visualizador',
          name: 'Visualizador',
          createdAt: new Date().toISOString()
        }
      };
      this.store.save();
      console.log('   👥 Usuarios por defecto creados: admin/admin123, visualizador/visual123');
    }
  }

  hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  async login(username, password) {
    const user = this.store.data.users[username];
    if (!user) return null;
    
    const hashedPassword = this.hashPassword(password);
    if (user.password !== hashedPassword) return null;

    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      username: user.username,
      role: user.role,
      name: user.name,
      createdAt: Date.now()
    });

    return {
      sessionId,
      username: user.username,
      role: user.role,
      name: user.name
    };
  }

  async logout(sessionId) {
    this.sessions.delete(sessionId);
  }

  validateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    
    // Expirar sesión después de 24 horas
    if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
      this.sessions.delete(sessionId);
      return null;
    }
    
    return session;
  }

  // Registro público (desde login.html) - siempre crea visualizadores
  async registerPublic(username, password, name) {
    // Validaciones
    if (!username || !password || !name) {
      throw new Error('Todos los campos son obligatorios');
    }

    if (username.length < 3) {
      throw new Error('El nombre de usuario debe tener al menos 3 caracteres');
    }

    if (password.length < 6) {
      throw new Error('La contraseña debe tener al menos 6 caracteres');
    }

    if (this.store.data.users[username]) {
      throw new Error('El nombre de usuario ya existe');
    }

    // Crear usuario con rol "visualizador" por defecto
    this.store.data.users[username] = {
      username,
      password: this.hashPassword(password),
      role: 'visualizador', // Siempre visualizador para registros públicos
      name,
      createdAt: new Date().toISOString()
    };

    await this.store.save();
    
    console.log(`   👤 Nuevo usuario registrado: ${username} (${name}) - Rol: visualizador`);
    
    return { 
      username, 
      role: 'visualizador', 
      name,
      message: 'Usuario creado exitosamente con rol de visualizador'
    };
  }

  // Crear usuario (solo admin, puede elegir el rol)
  async createUser(username, password, role, name) {
    if (this.store.data.users[username]) {
      throw new Error('El usuario ya existe');
    }

    if (!['admin', 'visualizador'].includes(role)) {
      throw new Error('Rol inválido');
    }

    this.store.data.users[username] = {
      username,
      password: this.hashPassword(password),
      role,
      name,
      createdAt: new Date().toISOString()
    };

    await this.store.save();
    
    console.log(`   👤 Usuario creado: ${username} (${name}) - Rol: ${role}`);
    
    return { username, role, name };
  }

  async deleteUser(username) {
    if (username === 'admin') {
      throw new Error('No se puede eliminar el usuario admin principal');
    }

    if (!this.store.data.users[username]) {
      throw new Error('Usuario no encontrado');
    }

    delete this.store.data.users[username];
    await this.store.save();
    
    console.log(`   🗑️  Usuario eliminado: ${username}`);
  }

  async listUsers() {
    return Object.values(this.store.data.users).map(u => ({
      username: u.username,
      role: u.role,
      name: u.name,
      createdAt: u.createdAt
    }));
  }

  async changeUserRole(username, newRole) {
    if (!this.store.data.users[username]) {
      throw new Error('Usuario no encontrado');
    }

    if (!['admin', 'visualizador'].includes(newRole)) {
      throw new Error('Rol inválido');
    }

    this.store.data.users[username].role = newRole;
    await this.store.save();
    
    console.log(`   🔄 Rol de ${username} cambiado a: ${newRole}`);
    
    return { username, role: newRole };
  }

  async changePassword(username, newPassword) {
    if (!this.store.data.users[username]) {
      throw new Error('Usuario no encontrado');
    }

    if (newPassword.length < 6) {
      throw new Error('La contraseña debe tener al menos 6 caracteres');
    }

    this.store.data.users[username].password = this.hashPassword(newPassword);
    await this.store.save();
    
    console.log(`   🔑 Contraseña actualizada para: ${username}`);
  }
}

module.exports = Auth;