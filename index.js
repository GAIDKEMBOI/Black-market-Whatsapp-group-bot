const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');

const BOT_PHONE_NUMBER = '254701400053';
const ALLOWED_DOMAIN = 'campus-marketplace-kenya.bolt.host';
const LINK_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+)/i;

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Campus Market Place Anti-Link Bot is running!');
}).listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: ['Ubuntu', 'Chrome', '120.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startBot, 5000);
      }
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp! Anti-Link Guard is ACTIVE.');
    }
  });

  // Request pairing code safely after socket initializes
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const cleanNumber = BOT_PHONE_NUMBER.replace(/[^0-9]/g, '');
        console.log(`Requesting pairing code for ${cleanNumber}...`);
        const code = await sock.requestPairingCode(cleanNumber);
        console.log('\n=========================================');
        console.log(`YOUR WHATSAPP PAIRING CODE: ${code}`);
        console.log('=========================================\n');
      } catch (err) {
        console.error('Failed to request pairing code:', err);
      }
    }, 8000); // Wait 8 seconds for secure connection handshake
  }

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
