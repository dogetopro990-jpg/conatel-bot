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

  async createUser(username, password, role, name) {
    if (this.store.data.users[username]) {
      throw new Error('El usuario ya existe');
    }

    this.store.data.users[username] = {
      username,
      password: this.hashPassword(password),
      role,
      name,
      createdAt: new Date().toISOString()
    };

    await this.store.save();
    return { username, role, name };
  }

  async deleteUser(username) {
    if (username === 'admin') {
      throw new Error('No se puede eliminar el usuario admin');
    }

    delete this.store.data.users[username];
    await this.store.save();
  }

  async listUsers() {
    return Object.values(this.store.data.users).map(u => ({
      username: u.username,
      role: u.role,
      name: u.name,
      createdAt: u.createdAt
    }));
  }
}

module.exports = Auth;