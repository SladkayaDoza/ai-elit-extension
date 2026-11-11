// background.js — shows the solver's status on the toolbar icon (badge), keeps the
// last status for the popup banner, and aggregates usage statistics (tokens/cost).
// The content script never needs to draw anything on the page for this, which
// matters when the button is hidden.

const GRAY = '#6b7280';
const RED = '#dc2626';
const TITLE = 'AI ELIT Solver';

const STATS_KEY = 'usageStats';
const KEEP_DAYS = 120;
const KEEP_RECENT = 30;

// ─── Usage statistics ─────────────────────────────────────────────────────────
// Single writer: every update goes through this queue, so concurrent tabs can't
// overwrite each other's numbers.

let queue = Promise.resolve();
function updateStats(mutate) {
  queue = queue.then(() => new Promise(resolve => {
    chrome.storage.local.get(STATS_KEY, data => {
      const stats = data[STATS_KEY] || { since: Date.now(), total: {}, days: {}, models: {}, recent: [] };
      mutate(stats);
      chrome.storage.local.set({ [STATS_KEY]: stats }, resolve);
    });
  })).catch(() => { });
}

function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function add(agg, e) {
  agg.requests = (agg.requests || 0) + 1;
  if (!e.ok) agg.failed = (agg.failed || 0) + 1;
  agg.prompt = (agg.prompt || 0) + (e.prompt || 0);
  agg.completion = (agg.completion || 0) + (e.completion || 0);
  agg.reasoning = (agg.reasoning || 0) + (e.reasoning || 0);
  agg.cost = (agg.cost || 0) + (e.cost || 0);
}

function recordRequest(e) {
  const t = Date.now();
  updateStats(stats => {
    const day = dayKey(t);
    add(stats.total, e);
    add(stats.days[day] = stats.days[day] || {}, e);
    add(stats.models[e.model] = stats.models[e.model] || {}, e);
    stats.recent.unshift({
      t, model: e.model, ok: !!e.ok,
      prompt: e.prompt || 0, completion: e.completion || 0, cost: e.cost || 0,
    });
    stats.recent.length = Math.min(stats.recent.length, KEEP_RECENT);

    const cutoff = dayKey(t - KEEP_DAYS * 864e5);
    for (const k of Object.keys(stats.days)) if (k < cutoff) delete stats.days[k];
  });
}

function recordQuestion() {
  const day = dayKey(Date.now());
  updateStats(stats => {
    stats.total.questions = (stats.total.questions || 0) + 1;
    const d = stats.days[day] = stats.days[day] || {};
    d.questions = (d.questions || 0) + 1;
  });
}

// ─── Messages from the content script ────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;

  if (msg.type === 'aqs-usage' && msg.entry && msg.entry.model) {
    recordRequest(msg.entry);
    return;
  }
  if (msg.type !== 'aqs-status') return;

  // gray "…" while thinking, red "!" on error; on success the answer numbers
  // of a choice question in gray (e.g. "134"), otherwise no badge
  let text = '…';
  let color = GRAY;
  if (msg.state === 'error') { text = '!'; color = RED; }
  else if (msg.state === 'success') { text = String(msg.badge || '').slice(0, 4); }

  // Per-tab: Chrome clears badge and tooltip by itself when the tab navigates (next question)
  const target = sender.tab && sender.tab.id != null ? { tabId: sender.tab.id } : {};
  chrome.action.setBadgeText({ ...target, text });
  chrome.action.setBadgeBackgroundColor({ ...target, color });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ ...target, color: '#ffffff' });

  // Retry notices etc. are transient; keep only states worth reading in the popup
  if (msg.state === 'info') return;
  if (msg.state === 'success') recordQuestion();

  const fullText = String(msg.text || '').slice(0, 300);
  // Hover over the icon to read the whole answer (the badge only fits ~4 characters)
  chrome.action.setTitle({ ...target, title: msg.state === 'working' ? TITLE : `${TITLE}\n${fullText}` });
  chrome.storage.local.set({
    lastStatus: { state: msg.state, text: fullText, badge: String(msg.badge || ''), time: Date.now() },
  });
});
