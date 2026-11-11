// background.js — shows the solver's status on the toolbar icon (badge) and keeps
// the last status for the popup banner. The content script never needs to draw
// anything on the page for this, which matters when the button is hidden.

const GRAY = '#6b7280';
const RED = '#dc2626';
const TITLE = 'AI ELIT Solver';

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'aqs-status') return;

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
  const fullText = String(msg.text || '').slice(0, 300);
  // Hover over the icon to read the whole answer (the badge only fits ~4 characters)
  chrome.action.setTitle({ ...target, title: msg.state === 'working' ? TITLE : `${TITLE}\n${fullText}` });
  chrome.storage.local.set({ lastStatus: { state: msg.state, text: fullText, time: Date.now() } });
});
