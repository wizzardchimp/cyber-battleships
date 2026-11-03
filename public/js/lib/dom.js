/** Tiny shared DOM helpers. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmt(value) {
  const number = Number(value) || 0;
  return number.toLocaleString('en-GB');
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function showToast(message, type = '', duration = 3200) {
  let layer = document.getElementById('toasts');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'toasts';
    layer.className = 'toast-layer';
    document.body.appendChild(layer);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`.trim();
  toast.textContent = String(message ?? '');
  layer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 320);
  }, duration);
}

export function downloadFile(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

export const COLUMN_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
