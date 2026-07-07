const log = document.getElementById('log');
const form = document.getElementById('form');
const input = document.getElementById('input');
const send = document.getElementById('send');
const statusEl = document.getElementById('status');

let session = null;

// Persist the session id header across requests so the server reuses one conversation.
async function api(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers['x-ghost-session'] = session;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('x-ghost-session');
  if (sid) session = sid;
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function addMessage(who, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${who}`;
  wrap.innerHTML = `<div><div class="who">${who === 'user' ? 'You' : 'Ghost'}</div>` +
    `<div class="bubble"></div></div>`;
  wrap.querySelector('.bubble').textContent = text;
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return wrap;
}

function addPlan(action) {
  const el = document.createElement('div');
  el.className = 'plan';
  const steps = action.plan.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  el.innerHTML = `<h4>Confirm: ${escapeHtml(action.summary)}</h4><ul>${steps}</ul>` +
    `<div class="actions"><button class="confirm">Confirm</button>` +
    `<button class="cancel">Cancel</button></div>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;

  el.querySelector('.confirm').addEventListener('click', async () => {
    el.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const { result } = await api('/api/confirm', { id: action.id });
      el.classList.add('done');
      el.querySelector('h4').textContent = `✓ ${action.summary}`;
      el.querySelector('.actions').innerHTML = `<span class="hint">${escapeHtml(result)}</span>`;
    } catch (err) {
      el.querySelector('.actions').innerHTML = `<span class="hint">Failed: ${escapeHtml(err.message)}</span>`;
    }
  });
  el.querySelector('.cancel').addEventListener('click', async () => {
    await api('/api/cancel', { id: action.id }).catch(() => {});
    el.remove();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addMessage('user', text);
  input.value = '';
  send.disabled = true;
  const thinking = addMessage('ghost', '…');
  try {
    const res = await api('/api/chat', { message: text });
    thinking.querySelector('.bubble').textContent = res.text || '(no response)';
    for (const action of res.pending || []) addPlan(action);
  } catch (err) {
    thinking.querySelector('.bubble').textContent = `Error: ${err.message}`;
  } finally {
    send.disabled = false;
    input.focus();
  }
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

fetch('/api/status')
  .then((r) => r.json())
  .then((s) => {
    statusEl.textContent = s.authenticated ? 'connected to Bungie' : 'not authenticated — run npm run auth';
    statusEl.style.color = s.authenticated ? 'var(--ok)' : 'var(--danger)';
  })
  .catch(() => (statusEl.textContent = 'server offline'));
