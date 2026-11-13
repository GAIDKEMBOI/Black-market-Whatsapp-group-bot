const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');

// 1. CONFIGURATION — Put your secondary bot phone number here (no '+' or spaces)
const BOT_PHONE_NUMBER = '254701400053'; // e.g., 254712345678
const ALLOWED_DOMAIN = 'campus-marketplace-kenya.bolt.host';

// Regex to detect any website URL, wa.me link, or WhatsApp group invite
const LINK_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+)/i;

// Keep-alive HTTP server required by free cloud hosts like Render
const PORT = process.env.PORT || 3000;
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
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  // Request 8-digit Pairing Code if not logged in yet
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const cleanNumber = BOT_PHONE_NUMBER.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        console.log('\n=========================================');
        console.log(`YOUR WHATSAPP PAIRING CODE: ${code}`);
        console.log('=========================================\n');
      } catch (err) {
        console.error('Failed to request pairing code:', err);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp! Anti-Link Guard is ACTIVE.');
    }
  });

  // Listen for incoming group messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      // Only moderate group chats (@g.us)
      if (!remoteJid || !remoteJid.endsWith('@g.us')) continue;

      // Extract text from regular messages, image/video captions, or link previews
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        '';

      if (!text || !LINK_REGEX.test(text)) continue;

      // Allow links to your Campus Market Place website
      if (text.toLowerCase().includes(ALLOWED_DOMAIN)) continue;

      try {
        // Check if sender is a group admin (do not delete admin links)
        const groupMetadata = await sock.groupMetadata(remoteJid);
        const sender = msg.key.participant || msg.participant;
        const senderInfo = groupMetadata.participants.find((p) => p.id === sender);
        const isSenderAdmin =
          senderInfo?.admin === 'admin' || senderInfo?.admin === 'superadmin';

        if (isSenderAdmin) continue;

        // Delete the unauthorized link message for everyone
        await sock.sendMessage(remoteJid, { delete: msg.key });

        // Send a short warning tagging the sender
        await sock.sendMessage(remoteJid, {
          text: `⚠️ @${sender.split('@')[0]}, external links are not allowed here. Post your item for free on *Campus Market Place* and share your listing link instead: https://${ALLOWED_DOMAIN}`,
          mentions: [sender]
        });
      } catch (err) {
        console.error('Error moderating message:', err);
      }
    }
  });
}

startBot();
