const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const TYPEBOT_API_URL = process.env.TYPEBOT_API_URL || 'https://haras-pk-typebot-viewer.royura.easypanel.host';
const TYPEBOT_ID = 'bot-festa-kaick-1-1e0ubq6';
const TYPEBOT_TOKEN = process.env.TYPEBOT_TOKEN;

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const ZAPI_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;
const ZAPI_HEADERS = { 'Client-Token': ZAPI_CLIENT_TOKEN };

// phone -> sessionId
const sessions = {};

async function sendToZapi(phone, message) {
  try {
    if (message.type === 'text') {
      const text = message.content?.markdown || message.content?.plainText || '';
      if (!text) {
        console.log('[SKIP] mensagem text sem conteúdo:', JSON.stringify(message.content));
        return;
      }
      console.log('[SEND-TEXT]', phone, '->', text.slice(0, 80));
      await axios.post(`${ZAPI_URL}/send-text`, { phone, message: text }, { headers: ZAPI_HEADERS });
    } else if (message.type === 'image') {
      console.log('[SEND-IMAGE]', phone, '->', message.content.url);
      try {
        const imgRes = await axios.get(message.content.url, { responseType: 'arraybuffer' });
        const mime = (imgRes.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
        const b64 = `data:${mime};base64,${Buffer.from(imgRes.data).toString('base64')}`;
        const payload = { phone, image: b64 };
        if (message.content.caption) payload.caption = message.content.caption;
        await axios.post(`${ZAPI_URL}/send-image`, payload, { headers: ZAPI_HEADERS });
      } catch (imgErr) {
        console.error('[IMG-FALLBACK] falhou, enviando como link:', imgErr.message);
        const caption = message.content.caption ? `\n${message.content.caption}` : '';
        await axios.post(`${ZAPI_URL}/send-text`, {
          phone,
          message: `${message.content.url}${caption}`,
        }, { headers: ZAPI_HEADERS });
      }
    } else if (message.type === 'video') {
      const payload = { phone, video: message.content.url };
      if (message.content.caption) payload.caption = message.content.caption;
      await axios.post(`${ZAPI_URL}/send-video`, payload, { headers: ZAPI_HEADERS });
    } else {
      console.log('[SKIP] tipo não suportado:', message.type);
    }
  } catch (err) {
    console.error('[ZAPI-ERR] send:', err.response?.status, JSON.stringify(err.response?.data), err.message);
  }
}

async function sendButtons(phone, text, buttons) {
  const buttonList = buttons.map((b) => ({ label: b.content }));
  console.log('[SEND-BUTTONS]', phone, '| caption:', text.slice(0, 60), '| buttons:', buttonList.map(b => b.label));
  try {
    await axios.post(`${ZAPI_URL}/send-button-list`, {
      phone,
      message: text,
      buttonList: { buttons: buttonList },
    }, { headers: ZAPI_HEADERS });
  } catch (err) {
    console.error('[ZAPI-ERR] send-button-list:', err.response?.status, JSON.stringify(err.response?.data));
    // fallback: texto com opções numeradas
    const options = buttons.map((b, i) => `${i + 1}. ${b.content}`).join('\n');
    try {
      await axios.post(`${ZAPI_URL}/send-text`, {
        phone,
        message: `${text}\n\n${options}`,
      }, { headers: ZAPI_HEADERS });
    } catch (err2) {
      console.error('[ZAPI-ERR] fallback send-text:', err2.response?.status, JSON.stringify(err2.response?.data));
    }
  }
}

async function processTypebotResponse(phone, data) {
  const messages = data.messages || [];
  const input = data.input;

  if (input && input.type === 'choice input') {
    const buttons = input.items || [];
    const lastText = messages.filter((m) => m.type === 'text').pop();
    const otherMessages = lastText ? messages.filter((m) => m !== lastText) : messages;

    for (const msg of otherMessages) {
      await sendToZapi(phone, msg);
      await new Promise((r) => setTimeout(r, 500));
    }

    const caption = lastText
      ? (lastText.content?.markdown || lastText.content?.plainText || 'Escolha uma opção:')
      : 'Escolha uma opção:';

    await sendButtons(phone, caption, buttons);
  } else {
    for (const msg of messages) {
      await sendToZapi(phone, msg);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;

  // Ignora mensagens enviadas pelo próprio bot
  if (body.fromMe) return;

  const phone = body.phone || body.from;
  const text = body.text?.message || body.message || '';

  if (!phone || !text) return;

  try {
    let responseData;

    if (sessions[phone]) {
      const resp = await axios.post(
        `${TYPEBOT_API_URL}/api/v1/sessions/${sessions[phone]}/continueChat`,
        { message: text },
        { headers: { Authorization: `Bearer ${TYPEBOT_TOKEN}` } }
      );
      responseData = resp.data;
      if (responseData.status === 'ended') delete sessions[phone];
    } else {
      const resp = await axios.post(
        `${TYPEBOT_API_URL}/api/v1/typebots/${TYPEBOT_ID}/startChat`,
        { prefilledVariables: { phone } },
        { headers: { Authorization: `Bearer ${TYPEBOT_TOKEN}` } }
      );
      responseData = resp.data;
      sessions[phone] = resp.data.sessionId;
    }

    console.log('[TYPEBOT]', JSON.stringify(responseData).slice(0, 500));
    await processTypebotResponse(phone, responseData);
  } catch (err) {
    console.error('Erro no webhook:', err.response?.data || err.message);
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook rodando na porta ${PORT}`));
