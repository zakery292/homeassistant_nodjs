const express = require('express');
const bodyParser = require('body-parser');
const net = require('net');
const app = express();
const HTTP_PORT = 3000;
const TCP_PORT = 4346;
const fs = require('fs');
const path = require('path');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const LUX_IP = '8.208.83.249'; // LUX IP address
const LUX_PORT = 4346; // Assuming LUX listens on the same port

let config = {
    dongleIP: null,
    homeAssistantIP: null,
    sendToLUX: false,
    sendToHomeAssistant: false, // Added flag for Home Assistant
  };

let sentPackets = [];
let receivedPackets = [];


let dongleSocket = null;
let homeAssistantSocket = null;
let luxSocket = null;
let initialPacket = null;

let selectLuxYes = '';
let selectLuxNo = '';
let selectHaYes = '';
let selectHaNo = '';

if (config.sendToLUX) {
    selectLuxYes = 'selected';
    selectLuxNo = '';
} else {
    selectLuxYes = '';
    selectLuxNo = 'selected';
}
if (config.sendToHomeAssistant) {
    selectHaYes = 'selected';
    selectHaNo = '';
} else {
    selectHaYes = '';
    selectHaNo = 'selected';
}





const CONFIG_FILE = '/data/config.json';

loadConfig();

function logPacket(packetArray, packet, isSent) {
  const packetLog = {
    timestamp: new Date().toLocaleString(),
    data: packet.toString('hex'),
    direction: isSent ? 'Sent' : 'Received'
  };
  packetArray.push(packetLog);
  if (packetArray.length > 20) {
    packetArray.shift(); // Keep only the last 20 packets
  }
}

function saveConfig() {
  fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), (err) => {
    if (err) console.error('Failed to save configuration:', err);
    else console.log('Configuration saved successfully.');
  });
}

function getNormalizedAddress(address) {
    if (address && address.includes('::ffff:')) {
        return address.replace('::ffff:', '');
    }
    return address;
}


function connectToLUX() {
  if (!config.sendToLUX || luxSocket) {
    return;
  }

  luxSocket = new net.Socket();

  luxSocket.connect(LUX_PORT, LUX_IP, () => {
    console.log('Connected to LUX');
  });

  luxSocket.on('data', (data) => {
    if (dongleSocket) {
      dongleSocket.write(data);
      console.log(`Received data from LUX and forwarded to Dongle: ${data.toString('hex')}`);
    }
  });

  // Adjust the 'close' event handler
  luxSocket.on('close', () => {
    console.log('Connection to LUX closed');
    // Check if the closure was intentional (config changed or dongle disconnected)
    if (config.sendToLUX) {
      console.log('Attempting to reconnect to LUX...');
      connectToLUX();
    } else {
      luxSocket = null;
    }
  });

  luxSocket.on('error', (err) => {
    console.error('Connection to LUX error:', err);
    luxSocket.destroy();
    luxSocket = null;
  });
}


const tcpServer = net.createServer((socket) => {
  const remoteAddress = getNormalizedAddress(socket.remoteAddress);
  console.log(`TCP connection established from ${remoteAddress}`);

  // Check if the connected client is the Dongle
  if (remoteAddress === getNormalizedAddress(config.dongleIP)) {
    console.log('Dongle connected');
    dongleSocket = socket;
  }
  // Check if the connected client is Home Assistant
  else if (remoteAddress === getNormalizedAddress(config.homeAssistantIP)) {
    console.log('Home Assistant connected');
    homeAssistantSocket = socket;
  }

  socket.on('data', (data) => {
    handleIncomingData(socket, data);
  });

  socket.on('close', () => {
    console.log(`Connection closed by ${remoteAddress}`);
    // Clear the specific socket variable when its connection closes
    if (socket === dongleSocket) {
      console.log('Dongle socket closed');
      dongleSocket = null;
    } else if (socket === homeAssistantSocket) {
      console.log('Home Assistant socket closed');
      homeAssistantSocket = null;
    } else if (socket === luxSocket) {
      console.log('LUX socket closed');
      luxSocket = null;
    }
  });

  socket.on('error', (err) => {
    console.error(`Socket error from ${remoteAddress}:`, err);
    // Enhanced logging for ECONNRESET
    if (err.code === 'ECONNRESET') {
        console.log(`ECONNRESET error from ${remoteAddress}. This might indicate the dongle was restarted or there was a network issue.`);
    }
    socket.destroy();
  });
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`TCP server listening on port ${TCP_PORT}`);
});


function handleIncomingData(socket, data) {
  const remoteAddress = getNormalizedAddress(socket.remoteAddress);
  let source = 'Unknown';
  let destinations = [];

  const normalizedDongleIP = getNormalizedAddress(config.dongleIP);
  const normalizedHomeAssistantIP = getNormalizedAddress(config.homeAssistantIP);
  const normalizedLUX_IP = getNormalizedAddress(LUX_IP);

  if (remoteAddress === normalizedDongleIP) {
    source = 'Dongle';
  } else if (remoteAddress === normalizedHomeAssistantIP) {
    source = 'Home Assistant';
  } else if (remoteAddress === normalizedLUX_IP) {
    source = 'LUX';
  }

  logPacket(receivedPackets, data, false); // Log received data
  console.log(`${source} sent data: ${data.toString('hex')}`);

  // Handling data from Dongle
  if (remoteAddress === normalizedDongleIP) {
    // Echo back logic
    if (!initialPacket) {
      initialPacket = data;
      socket.write(data); // Echo back
      destinations.push('Dongle (Echo back)');
    } else if (data.equals(initialPacket)) {
      socket.write(data); // Echo back
      destinations.push('Dongle (Echo back)');
    }

    if (dongleSocket === null) dongleSocket = socket;

    console.log(`Attempting to forward to Home Assistant. sendToHomeAssistant: ${config.sendToHomeAssistant}, homeAssistantSocket: ${homeAssistantSocket ? "Exists" : "Does not exist"}`);
    
    if (config.sendToHomeAssistant && homeAssistantSocket) {
      homeAssistantSocket.write(data);
      destinations.push('Home Assistant');
      console.log(`Data forwarded to Home Assistant: ${data.toString('hex')}`);
    } else {
      console.log(`Conditions not met to forward to Home Assistant.`);
    }

    if (config.sendToLUX && luxSocket) {
      luxSocket.write(data);
      destinations.push('LUX');
    }
  }

  // Handling data from Home Assistant
  if (remoteAddress === normalizedHomeAssistantIP) {
    if (dongleSocket) {
      dongleSocket.write(data);
      destinations.push('Dongle');
    }
  }

  // Handling data from LUX
  if (remoteAddress === normalizedLUX_IP) {
    if (dongleSocket) {
      dongleSocket.write(data);
      destinations.push('Dongle');
    }
  }

  if (destinations.length) {
    console.log(`${source} sent data to: ${destinations.join(', ')}`);
    destinations.forEach(destination => {
      logPacket(sentPackets, data, true); // Log sent data for each destination
    });
  } else {
    console.log(`${source} sent data, but no action taken: ${data.toString('hex')}`);
  }
}


// Update your /configure endpoint to handle sendToHomeAssistant
app.post('/configure', (req, res) => {
    console.log(req.body);
    const prevSendToLUX = config.sendToLUX;
    config.dongleIP = req.body.dongleIP;
    config.homeAssistantIP = req.body.homeAssistantIP;
    config.sendToLUX = req.body.sendToLUX === 'yes';
    config.sendToHomeAssistant = req.body.sendToHomeAssistant === 'yes'; // Add this line
  
    console.log('Configuration updated:', config);
    saveConfig();
    
  
    // LUX reconnection logic remains the same
  
    res.send('Configuration updated successfully');
  });
app.get('index.html', (req, res) => {
  console.log('Accessing root route, loading index.html...');

  fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, html) => {
    if (err) {
      console.error('Error reading index.html file:', err);
      return res.status(500).send('Error loading configuration page');
    }

    console.log('Initial HTML loaded, starting placeholder replacement...');
    console.log('Current config:', config);

    html = html.replace(/{{dongleIP}}/g, config.dongleIP || 'Not set')
               .replace(/{{homeAssistantIP}}/g, config.homeAssistantIP || 'Not set')
               .replace(/{{selectHaNo}}/g, !config.sendToHomeAssistant ? 'selected' : '')
               .replace(/{{selectHaYes}}/g, config.sendToHomeAssistant ? 'selected' : '')
               .replace(/{{selectLuxNo}}/g, !config.sendToLUX ? 'selected' : '')
               .replace(/{{selectLuxYes}}/g, config.sendToLUX ? 'selected' : '');

    console.log('Placeholder replacement completed, sending modified HTML...');
    res.send(html);
  });
});

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      config = JSON.parse(data);
      console.log('Configuration loaded:', config);
    } else {
      console.log('config.json does not exist. Creating with default configuration.');
      saveConfig();  // This will create the file with the current config object.
    }
  } catch (err) {
    console.log('Error handling the configuration file:', err);
  }
}


app.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`Configuration server running at http://localhost:${HTTP_PORT}`);
    connectToLUX();
});
