const os = require('os');

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const results = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Solo IPv4 y no internas (127.0.0.1)
      if (iface.family === 'IPv4' && !iface.internal) {
        results.push({
          interface: name,
          address: iface.address,
          label: getInterfaceLabel(name)
        });
      }
    }
  }

  return results;
}

function getInterfaceLabel(name) {
  const labels = {
    'eth0': 'Ethernet',
    'eth1': 'Ethernet 2',
    'wlan0': 'WiFi',
    'wlan1': 'WiFi 2',
    'en0': 'Ethernet/WiFi',
    'en1': 'Thunderbolt/Ethernet',
    'wlp': 'WiFi'
  };

  for (const [prefix, label] of Object.entries(labels)) {
    if (name.startsWith(prefix)) return label;
  }
  return name;
}

function getHostname() {
  return os.hostname();
}

function getPlatform() {
  return os.platform();
}

function getSystemInfo() {
  return {
    hostname: getHostname(),
    platform: getPlatform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    memory: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + ' GB',
    uptime: Math.floor(os.uptime() / 60) + ' min',
    localIPs: getLocalIPs()
  };
}

module.exports = {
  getLocalIPs,
  getHostname,
  getPlatform,
  getSystemInfo
};