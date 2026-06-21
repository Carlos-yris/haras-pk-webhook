const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const TYPEBOT_API_URL = process.env.TYPEBOT_API_URL || 'http://haras_pk_typebot-builder:3000';
const TYPEBOT_ID = 'bot-festa-kaick-1-1e0ubq6';
const TYPEBOT_TOKEN = process.env.TYPEBOT_TOKEN;

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;

// phone -> sessionId
const sessions = {};

async function sendToZapi(phone, message) {
  try {
    if (message.type === 'text') {
      await axios.post(`${ZAPI_URL}/send-text`, {
        phone,
        message: message.content.markdown || message.content.plainText || '',
      });
    } else if (message.type === 'image') {
      await axios.post(`${ZAPI_URL}/send-image`, {
        phone,
        image: message.content.url,
        caption: message.content.caption || '',
      });
    } else if (message.type === 'video') {
      await axios.post(`${ZAPI_URL}/send-video`, {
        phone,
        video: message.content.url,
        caption: message.content.caption || '',
      });
    }
  } catch (err) {
    console.error('Erro ao enviar para Z-API:', err.message);
  }
}

async function sendButtons(phone, text, buttons) {
  try {
    const buttonList = buttons.map((b) => ({ label: b.content }));
    await axios.post(`${ZAPI_URL}/send-button-list`, {
      phone,
      message: text,
      buttonList: { buttons: buttonList },
    });
  } catch (err) {
    // fallback: envia como texto com opções numeradas
    const options = buttons.map((b, i) => `${i + 1}. ${b.content}`).join('\n');
    await axios.post(`${ZAPI_URL}/send-text`, {
      phone,
      message: `${text}\n\n${options}`,
    });
  }
}

async function processTypebotResponse(phone, data) {
  const messages = data.messages || [];
  const input = data.input;

  for (const msg of messages) {
    await sendToZapi(phone, msg);
    await new Promise((r) => setTimeout(r, 500));
  }

  if (input && input.type === 'choice input') {
    const buttons = input.items || [];
    const lastText = messages.filter((m) => m.type === 'text').pop();
    const prompt = lastText ? '' : 'Escolha uma opção:';
    await sendButtons(phone, prompt, buttons);
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
      // Continua sessão existente
      const resp = await axios.post(
        `${TYPEBOT_API_URL}/api/v1/sessions/${sessions[phone]}/continueChat`,
        { message: text },
        { headers: { Authorization: `Bearer ${TYPEBOT_TOKEN}` } }
      );
      responseData = resp.data;

      if (responseData.status === 'ended') {
        delete sessions[phone];
      }
    } else {
      // Inicia nova sessão
      const resp = await axios.post(
        `${TYPEBOT_API_URL}/api/v1/typebots/${TYPEBOT_ID}/startChat`,
        { prefilledVariables: { phone } },
        { headers: { Authorization: `Bearer ${TYPEBOT_TOKEN}` } }
      );
      responseData = resp.data;
      sessions[phone] = resp.data.sessionId;
    }

    await processTypebotResponse(phone, responseData);
  } catch (err) {
    console.error('Erro no webhook:', err.response?.data || err.message);
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook rodando na porta ${PORT}`));
