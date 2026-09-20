require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;

// Every provider Matrix AI Studio can talk to. Keys live only here, never
// in the browser. Add a new persona's backend by adding an entry here and
// pointing the frontend's persona.provider at its key.
const PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    key: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || 'nex-agi/nex-n2.5-pro:free',
    extraHeaders: { 'HTTP-Referer': 'http://localhost', 'X-Title': 'Matrix AI' }
  },
  xkiro: {
    url: 'https://api.xkiro.com/v1/chat/completions',
    key: process.env.XKIRO_API_KEY,
    model: process.env.XKIRO_MODEL || 'mistralai/codestral-2508',
    extraHeaders: {}
  },
  fathom: {
    url: process.env.FATHOM_BASE_URL ? `${process.env.FATHOM_BASE_URL.replace(/\/$/, '')}/chat/completions` : 'https://integrate.api.nvidia.com/v1/chat/completions',
    key: process.env.FATHOM_API_KEY,
    model: process.env.FATHOM_MODEL || 'moonshotai/kimi-k3',
    extraHeaders: {}
  }
};

if (!PROVIDERS.openrouter.key) {
  console.error('Missing OPENROUTER_API_KEY. Set it in a .env file (see .env.example).');
  process.exit(1);
}
for (const [name, cfg] of Object.entries(PROVIDERS)) {
  if (!cfg.key) console.warn(`Warning: no API key set for "${name}" — that persona will fail until ${name.toUpperCase()}_API_KEY is set in .env.`);
}

// Fallback identity used only when the client doesn't supply its own system
// prompt (i.e. the default Matrix AI persona, no custom AI selected).
const BASE_SYSTEM_PROMPT = `You are Matrix AI, a helpful, thoughtful AI assistant. ` +
  `If asked who you are, what your name is, what model you are, who made you, or ` +
  `anything about your identity/origin, you must answer that your name is "Matrix AI" ` +
  `and nothing else about underlying models or providers. Otherwise, answer the user's ` +
  `question normally, clearly, and helpfully.`;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Serve the frontend from ./public so the browser and API share an origin
// (no CORS headaches) and no API key ever has to leave this server.
app.use(express.static(path.join(__dirname, 'public')));

// Basic abuse protection: caps requests per IP so a runaway client fails
// fast and locally instead of burning through any provider's quota.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', providers: Object.keys(PROVIDERS).filter(p => !!PROVIDERS[p].key) });
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { messages, systemPrompt, provider: providerName } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Request body must include a non-empty "messages" array.' });
  }

  const provider = PROVIDERS[providerName] || PROVIDERS.openrouter;
  if (!provider.key) {
    return res.status(500).json({ error: `No API key configured for provider "${providerName || 'openrouter'}" on this server.` });
  }

  // Only user/assistant turns are trusted as chat history; the system
  // prompt (persona name + instructions) is a separate, explicit field so
  // it can't be smuggled in as a fake "system" message in the array.
  const cleanHistory = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content)))
    .map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.slice(0, 8000) : m.content
    }))
    .slice(-40); // keep the last 40 turns

  const finalSystemPrompt = typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt : BASE_SYSTEM_PROMPT;
  const upstreamMessages = [{ role: 'system', content: finalSystemPrompt }, ...cleanHistory];

  let upstreamRes;
  try {
    upstreamRes = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.key}`,
        ...provider.extraHeaders
      },
      body: JSON.stringify({
        model: provider.model,
        messages: upstreamMessages,
        stream: true
      })
    });
  } catch (err) {
    console.error(`Failed to reach ${providerName || 'openrouter'}:`, err);
    return res.status(502).json({ error: `Could not reach the ${providerName || 'openrouter'} API. Please try again.` });
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    const errText = await upstreamRes.text().catch(() => '');
    console.error(`${providerName || 'openrouter'} error:`, upstreamRes.status, errText);
    return res.status(upstreamRes.status).json({ error: 'AI provider returned an error.', detail: errText });
  }

  // Stream the response straight through to the browser as Server-Sent Events.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const reader = upstreamRes.body.getReader();

  req.on('close', () => {
    reader.cancel().catch(() => {});
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (err) {
    console.error('Stream interrupted:', err);
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Matrix AI Studio backend running at http://localhost:${PORT}`);
});
