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

console.log('[ENV] ZAPI_INSTANCE:', ZAPI_INSTANCE ? `OK (${ZAPI_INSTANCE.slice(0, 6)}...)` : 'MISSING');
console.log('[ENV] ZAPI_CLIENT_TOKEN:', ZAPI_CLIENT_TOKEN ? 'OK' : 'MISSING');
console.log('[ENV] TYPEBOT_TOKEN:', TYPEBOT_TOKEN ? 'OK' : 'MISSING');

// ── Sessões persistidas com TTL + choices ─────────────────────────────────────
const SESSIONS_FILE = '/app/sessions.json';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (e) { console.error('[SESSIONS] load error:', e.message); }
  return {};
}

function saveSessions(s) {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s), 'utf8'); }
  catch (e) { console.error('[SESSIONS] save error:', e.message); }
}

function pruneExpired(s) {
  const now = Date.now();
  let n = 0;
  for (const p of Object.keys(s)) {
    if (!s[p].at || now - s[p].at > SESSION_TTL_MS) { delete s[p]; n++; }
  }
  if (n) { console.log('[SESSIONS] expiradas:', n); saveSessions(s); }
}

const sessions = loadSessions();
pruneExpired(sessions);
console.log('[SESSIONS] carregadas:', Object.keys(sessions).length);

// ── Deduplicação de mensagens recebidas ───────────────────────────────────────
const recentMsgIds = new Set();
function isDuplicate(msgId) {
  if (!msgId) return false;
  if (recentMsgIds.has(msgId)) return true;
  recentMsgIds.add(msgId);
  // Limpa após 5 min para não crescer indefinidamente
  setTimeout(() => recentMsgIds.delete(msgId), 5 * 60 * 1000);
  return false;
}

// ── Z-API helpers ─────────────────────────────────────────────────────────────
async function zapiPost(endpoint, body) {
  try {
    const resp = await axios.post(`${ZAPI_URL}/${endpoint}`, body, { headers: ZAPI_HEADERS });
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
  } catch (_) { /* erro já logado */ }
}

async function sendButtons(phone, text, buttons) {
  const options = buttons.map((b, i) => `${i + 1}. ${b.content}`).join('\n');
  console.log('[SEND-BUTTONS]', phone, `(${buttons.length} opções)`);
  try { await zapiPost('send-text', { phone, message: `${text}\n\n${options}` }); }
  catch (_) { /* erro já logado */ }
}

async function processTypebotResponse(phone, data) {
  const messages = data.messages || [];
  const input = data.input;

  // Salva as opções disponíveis na sessão para mapear número → texto
  if (input?.type === 'choice input' && sessions[phone]) {
    sessions[phone].choices = input.items.map((it) => it.content);
    sessions[phone].at = Date.now();
    saveSessions(sessions);
  }

  if (input?.type === 'choice input') {
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

  // Deduplicação: ignora webhook duplicado do Z-API
  const msgId = body.messageId || body.id;
  if (isDuplicate(msgId)) {
    console.log('[DEDUP] ignorando duplicata:', msgId);
    return;
  }

  const phone = body.phone || body.from;
  let text = body.text?.message || body.message || body.text || '';
  text = String(text).trim();

  console.log('[RECV]', phone, '|', text.slice(0, 60));
  if (!phone || !text) { console.log('[SKIP] sem phone ou texto'); return; }

  // Mapear número → texto do botão se houver choices salvas
  const sess = sessions[phone];
  if (sess?.choices && /^\d+$/.test(text)) {
    const idx = parseInt(text, 10) - 1;
    if (idx >= 0 && idx < sess.choices.length) {
      console.log('[CHOICE] mapeado:', text, '->', sess.choices[idx]);
      text = sess.choices[idx];
    }
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
      sessions[phone] = { id: resp.data.sessionId, at: Date.now(), choices: null };
      saveSessions(sessions);
      console.log('[SESSION] nova:', resp.data.sessionId);
      return resp.data;
    };

    if (sess?.id) {
      console.log('[SESSION] continuando:', sess.id);
      try {
        const resp = await axios.post(
          `${TYPEBOT_API_URL}/api/v1/sessions/${sess.id}/continueChat`,
          { message: text },
          { headers: { Authorization: `Bearer ${TYPEBOT_TOKEN}` } }
        );
        responseData = resp.data;
        sessions[phone].at = Date.now();
        sessions[phone].choices = null; // limpa choices após resposta
        saveSessions(sessions);
        if (responseData.status === 'ended') {
          delete sessions[phone];
          saveSessions(sessions);
          console.log('[SESSION] encerrada');
        }
      } catch (sessionErr) {
        console.log('[SESSION] inválida, reiniciando. Erro:', sessionErr.response?.status || sessionErr.message);
        delete sessions[phone];
        saveSessions(sessions);
        responseData = await startChat();
      }
    } else {
      responseData = await startChat();
    }

    const msgTypes = (responseData.messages || []).map((m) => m.type);
    console.log('[TYPEBOT]', `msgs:[${msgTypes}] input:${responseData.input?.type || 'none'}`);

    await processTypebotResponse(phone, responseData);
  } catch (err) {
    console.error('[WEBHOOK-ERR]', err.response?.status, JSON.stringify(err.response?.data || err.message));
  }
});

// ── Endpoints utilitários ─────────────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  const phone = req.query.phone || '5521959435722';
  const result = {
    env: {
      ZAPI_INSTANCE: ZAPI_INSTANCE ? `OK (${ZAPI_INSTANCE.slice(0, 6)}...)` : 'MISSING',
      ZAPI_CLIENT_TOKEN: ZAPI_CLIENT_TOKEN ? 'OK' : 'MISSING',
      TYPEBOT_TOKEN: TYPEBOT_TOKEN ? 'OK' : 'MISSING',
      TYPEBOT_API_URL,
    },
    sessions: Object.keys(sessions).length,
    zapiTest: null,
  };
  try {
    const resp = await axios.post(`${ZAPI_URL}/send-text`, {
      phone, message: '[DEBUG] container OK',
    }, { headers: ZAPI_HEADERS });
    result.zapiTest = { ok: true, messageId: resp.data?.messageId };
  } catch (err) {
    result.zapiTest = { ok: false, error: err.response?.data || err.message };
  }
  res.json(result);
});

app.get('/reset/:phone', (req, res) => {
  const { phone } = req.params;
  if (sessions[phone]) { delete sessions[phone]; saveSessions(sessions); }
  console.log('[RESET]', phone);
  res.json({ ok: true, message: `Sessão de ${phone} removida` });
});

app.get('/clear-sessions', (_, res) => {
  const count = Object.keys(sessions).length;
  for (const k of Object.keys(sessions)) delete sessions[k];
  saveSessions(sessions);
  console.log('[CLEAR] sessões:', count);
  res.json({ ok: true, cleared: count });
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook rodando na porta ${PORT}`));
