const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const url = require('url');

let latestPairingCode = 'Not requested yet. Open the web link below to generate one!';
let isConnected = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: ['Chrome (Linux)', 'Chrome', '120.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startBot, 5000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      latestPairingCode = 'CONNECTED SUCCESSFULLY! 🎉';
      console.log('✅ Connected to WhatsApp! Anti-Link Guard is ACTIVE.');
    }
  });

  // Create an interactive web server so you can request a code right from your phone browser
  const PORT = process.env.PORT || 8080;
  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);

    if (parsedUrl.pathname === '/pair') {
      const phoneNumber = parsedUrl.query.phone;
      if (!phoneNumber) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        return res.end('<h3>Error: Please provide a phone number. Example: /pair?phone=254701400053</h3>');
      }

      try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        console.log(`Web panel requested pairing code for ${cleanNumber}...`);
        
        // Brief pause to stabilize socket before requesting
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const code = await sock.requestPairingCode(cleanNumber);
        latestPairingCode = code;
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>Your Pairing Code is: <span style="color:blue; font-size:30px;">${code}</span></h2><p>Go to WhatsApp > Linked Devices > Link with phone number and type this code immediately!</p><a href="/">Back</a>`);
      } catch (err) {
        console.error('Web pairing error:', err);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h3>Failed to get code: ${err.message}</h3><p>Make sure the number has no '+' and try refreshing the main page.</p>`);
      }
      return;
    }

    // Default home page
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <head><title>Campus Market Bot Panel</title></head>
        <body style="font-family: Arial; padding: 20px; text-align: center;">
          <h2>Campus Market Place Anti-Link Bot</h2>
          <p>Status: <b>${isConnected ? 'CONNECTED ✅' : 'DISCONNECTED / WAITING FOR PAIRING ⏳'}</b></p>
          <hr/>
          <h3>Current Pairing Code:</h3>
          <h1 style="color: #0070f3; background: #f0f4f8; padding: 15px; display: inline-block; border-radius: 8px;">${latestPairingCode}</h1>
          <br><br>
          <hr/>
          <h3>Generate Code via Web:</h3>
          <form action="/pair" method="GET">
            <input type="text" name="phone" placeholder="254701400053" style="padding: 10px; font-size: 16px; width: 250px;" required />
            <br><br>
            <button type="submit" style="padding: 10px 20px; font-size: 16px; background: #0070f3; color: white; border: none; border-radius: 5px; cursor: pointer;">Get Pairing Code</button>
          </form>
        </body>
      </html>
    `);
  });

  // Prevent multiple server listen crashes on restart
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') console.error(e);
  });
  
  if (!server.listening) {
    server.listen(PORT, () => console.log(`Web panel running on port ${PORT}`));
  }

  // Listen for group messages and block links
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || !remoteJid.endsWith('@g.us')) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        '';

      const LINK_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+)/i;
      const ALLOWED_DOMAIN = 'campus-marketplace-kenya.bolt.host';

      if (!text || !LINK_REGEX.test(text)) continue;
      if (text.toLowerCase().includes(ALLOWED_DOMAIN)) continue;

      try {
        const groupMetadata = await sock.groupMetadata(remoteJid);
        const sender = msg.key.participant || msg.participant;
        const senderInfo = groupMetadata.participants.find((p) => p.id === sender);
        const isSenderAdmin = senderInfo?.admin === 'admin' || senderInfo?.admin === 'superadmin';

        if (isSenderAdmin) continue;

        await sock.sendMessage(remoteJid, { delete: msg.key });
        await sock.sendMessage(remoteJid, {
          text: `⚠️ @${sender.split('@')[0]}, external links are not allowed here. Post your item for free on *Campus Market Place*: https://${ALLOWED_DOMAIN}`,
          mentions: [sender]
        });
      } catch (err) {
        console.error('Error moderating message:', err);
      }
    }
  });
}

startBot();
    
