import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { GhostConversation } from '../agent/loop.js';
import { readTokens } from '../bungie/tokens.js';
import { ensureManifest } from '../bungie/manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 8787);

const app = express();
app.use(express.json());
app.use(express.static(WEB_DIR));

/** One conversation per session cookie. Simple in-memory map (single-user app). */
const sessions = new Map<string, GhostConversation>();
function conversationFor(req: express.Request, res: express.Response): GhostConversation {
  let sid = req.headers['x-ghost-session'] as string | undefined;
  if (!sid || !sessions.has(sid)) {
    sid = randomUUID();
    sessions.set(sid, new GhostConversation());
  }
  res.setHeader('x-ghost-session', sid);
  return sessions.get(sid)!;
}

app.get('/api/status', async (_req, res) => {
  const tokens = await readTokens();
  res.json({ authenticated: tokens !== null });
});

app.post('/api/chat', async (req, res) => {
  const convo = conversationFor(req, res);
  const text = String(req.body?.message ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Empty message.' });
  try {
    const result = await convo.send(text);
    res.json({
      text: result.text,
      pending: result.pending.map((p) => ({ id: p.id, summary: p.summary, plan: p.plan, tool: p.tool })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/confirm', async (req, res) => {
  const convo = conversationFor(req, res);
  const id = String(req.body?.id ?? '');
  try {
    const result = await convo.confirm(id);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/cancel', (req, res) => {
  const convo = conversationFor(req, res);
  convo.cancel(String(req.body?.id ?? ''));
  res.json({ ok: true });
});

app.listen(PORT, async () => {
  console.log(`[ghost] listening on http://localhost:${PORT}`);
  const tokens = await readTokens();
  if (!tokens) {
    console.log('[ghost] Not authenticated yet — run `npm run auth` to log in to Bungie.');
  } else {
    // Warm the manifest so the first real query is fast.
    ensureManifest()
      .then((m) => console.log(`[ghost] manifest ${m.version} ready`))
      .catch((e) => console.warn('[ghost] manifest warm failed:', e.message));
  }
});
