const express = require('express');
const axios = require('axios');
const fs = require('fs');

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

// ── Startup env check ────────────────────────────────────────────────────────
console.log('[ENV] ZAPI_INSTANCE:', ZAPI_INSTANCE ? `OK (${ZAPI_INSTANCE.slice(0, 6)}...)` : 'MISSING');
console.log('[ENV] ZAPI_TOKEN:', ZAPI_TOKEN ? 'OK' : 'MISSING');
console.log('[ENV] ZAPI_CLIENT_TOKEN:', ZAPI_CLIENT_TOKEN ? `OK (${ZAPI_CLIENT_TOKEN.slice(0, 6)}...)` : 'MISSING');
console.log('[ENV] TYPEBOT_TOKEN:', TYPEBOT_TOKEN ? 'OK' : 'MISSING');
console.log('[ENV] TYPEBOT_API_URL:', TYPEBOT_API_URL);

// ── Sessões persistidas em arquivo com TTL ────────────────────────────────────
const SESSIONS_FILE = '/app/sessions.json';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[SESSIONS] erro ao carregar:', e.message);
  }
  return {};
}

function saveSessions(sessions) {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions), 'utf8');
  } catch (e) {
    console.error('[SESSIONS] erro ao salvar:', e.message);
  }
}

function pruneExpired(sessions) {
  const now = Date.now();
  let pruned = 0;
  for (const phone of Object.keys(sessions)) {
    const s = sessions[phone];
    if (s.at && now - s.at > SESSION_TTL_MS) {
      delete sessions[phone];
      pruned++;
    }
  }
  if (pruned) {
    console.log('[SESSIONS] expiradas removidas:', pruned);
    saveSessions(sessions);
  }
}

const sessions = loadSessions();
pruneExpired(sessions);
console.log('[SESSIONS] carregadas:', Object.keys(sessions).length);

// ── Z-API helpers ─────────────────────────────────────────────────────────────
async function zapiPost(endpoint, body) {
  const url = `${ZAPI_URL}/${endpoint}`;
  try {
    const resp = await axios.post(url, body, { headers: ZAPI_HEADERS });
    console.log(`[ZAPI-OK] ${endpoint} →`, resp.data?.messageId || resp.status);
    return resp.data;
  } catch (err) {
    console.error(`[ZAPI-ERR] ${endpoint} →`, err.response?.status, JSON.stringify(err.response?.data || err.message));
    throw err;
  }
}

async function sendToZapi(phone, message) {
  try {
    if (message.type === 'text') {
      const text = message.content?.markdown || message.content?.plainText || '';
      if (!text) return;
      console.log('[SEND-TEXT]', phone, '->', text.slice(0, 80));
      await zapiPost('send-text', { phone, message: text });

    } else if (message.type === 'image') {
      console.log('[SEND-IMAGE]', phone, '->', message.content.url);
      const payload = { phone, image: message.content.url };
      if (message.content.caption) payload.caption = message.content.caption;
      await zapiPost('send-image', payload);

    } else if (message.type === 'video') {
      const payload = { phone, video: message.content.url };
      if (message.content.caption) payload.caption = message.content.caption;
      await zapiPost('send-video', payload);

    } else {
      console.log('[SKIP] tipo:', message.type);
    }
  } catch (err) {
    // erro já logado em zapiPost
  }
}

async function sendButtons(phone, text, buttons) {
  const options = buttons.map((b, i) => `${i + 1}. ${b.content}`).join('\n');
  const full = `${text}\n\n${options}`;
  console.log('[SEND-BUTTONS]', phone, `(${buttons.length} opções)`);
  try {
    await zapiPost('send-text', { phone, message: full });
  } catch (err) {
    // erro já logado em zapiPost
  }
}

async function processTypebotResponse(phone, data) {
  const messages = data.messages || [];
  const input = data.input;

  if (input && input.type === 'choice input') {
    const buttons = input.items || [];
    const lastText = messages.filter((m) => m.type === 'text').pop();
    const others = lastText ? messages.filter((m) => m !== lastText) : messages;

    for (const msg of others) {
      await sendToZapi(phone, msg);
      await new Promise((r) => setTimeout(r, 800));
    }

    const caption = lastText
      ? (lastText.content?.markdown || lastText.content?.plainText || 'Escolha uma opção:')
      : 'Escolha uma opção:';

    await sendButtons(phone, caption, buttons);
  } else {
    for (const msg of messages) {
      await sendToZapi(phone, msg);
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body.fromMe) return;

  const phone = body.phone || body.from;
  const text = body.text?.message || body.message || body.text || '';

  console.log('[RECV]', phone, '|', String(text).slice(0, 60));

  if (!phone || !text) {
    console.log('[SKIP] sem phone ou texto');
    return;
  }

  pruneExpired(sessions);

  try {
    let responseData;

    const startChat = async () => {
      console.log('[SESSION] iniciando novo chat');
      const resp = await axios.post(
        `${TYPEBOT_API_URL}/api/v1/typebots/${TYPEBOT_ID}/startChat`,
        { prefilledVariables: { phone } },
        { headers: { Authorization: `Bearer ${TYPEBOT_TOKEN}` } }
      );
      sessions[phone] = { id: resp.data.sessionId, at: Date.now() };
      saveSessions(sessions);
      console.log('[SESSION] nova:', resp.data.sessionId);
      return resp.data;
    };

    if (sessions[phone]) {
      const sid = sessions[phone].id || sessions[phone];
      console.log('[SESSION] continuando:', sid);
      try {
        const resp = await axios.post(
          `${TYPEBOT_API_URL}/api/v1/sessions/${sid}/continueChat`,
          { message: String(text) },
          { headers: { Authorization: `Bearer ${TYPEBOT_TOKEN}` } }
        );
        responseData = resp.data;
        // atualiza timestamp de atividade
        sessions[phone] = { id: sid, at: Date.now() };
        saveSessions(sessions);
        if (responseData.status === 'ended') {
          delete sessions[phone];
          saveSessions(sessions);
          console.log('[SESSION] encerrada');
        }
      } catch (sessionErr) {
        // Sessão expirada ou inválida no Typebot → reinicia
        console.log('[SESSION] inválida, reiniciando. Erro:', sessionErr.response?.status || sessionErr.message);
        delete sessions[phone];
        saveSessions(sessions);
        responseData = await startChat();
      }
    } else {
      responseData = await startChat();
    }

    const msgTypes = (responseData.messages || []).map((m) => m.type);
    const inputType = responseData.input?.type || 'none';
    console.log('[TYPEBOT]', `msgs: [${msgTypes}] input: ${inputType}`);

    await processTypebotResponse(phone, responseData);
  } catch (err) {
    console.error('[WEBHOOK-ERR]', err.response?.status, JSON.stringify(err.response?.data || err.message));
  }
});

// ── Debug endpoint ─────────────────────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  const phone = req.query.phone || '5521959435722';
  const result = {
    env: {
      ZAPI_INSTANCE: ZAPI_INSTANCE ? `OK (${ZAPI_INSTANCE.slice(0, 6)}...)` : 'MISSING',
      ZAPI_TOKEN: ZAPI_TOKEN ? 'OK' : 'MISSING',
      ZAPI_CLIENT_TOKEN: ZAPI_CLIENT_TOKEN ? `OK (${ZAPI_CLIENT_TOKEN.slice(0, 6)}...)` : 'MISSING',
      TYPEBOT_TOKEN: TYPEBOT_TOKEN ? 'OK' : 'MISSING',
      TYPEBOT_API_URL,
    },
    sessions: Object.keys(sessions).length,
    zapiTest: null,
  };

  try {
    const resp = await axios.post(`${ZAPI_URL}/send-text`, {
      phone,
      message: '[DEBUG] container consegue enviar para Z-API?',
    }, { headers: ZAPI_HEADERS });
    result.zapiTest = { ok: true, data: resp.data };
  } catch (err) {
    result.zapiTest = { ok: false, status: err.response?.status, error: err.response?.data || err.message };
  }

  res.json(result);
});

// Resetar sessão de um número específico
app.get('/reset/:phone', (req, res) => {
  const { phone } = req.params;
  if (sessions[phone]) {
    delete sessions[phone];
    saveSessions(sessions);
    console.log('[RESET] sessão removida:', phone);
    res.json({ ok: true, message: `Sessão de ${phone} removida` });
  } else {
    res.json({ ok: true, message: `Sem sessão ativa para ${phone}` });
  }
});

// Limpar todas as sessões
app.get('/clear-sessions', (_, res) => {
  const count = Object.keys(sessions).length;
  for (const k of Object.keys(sessions)) delete sessions[k];
  saveSessions(sessions);
  console.log('[CLEAR] todas as sessões removidas:', count);
  res.json({ ok: true, cleared: count });
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook rodando na porta ${PORT}`));
