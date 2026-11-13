export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'className') node.className = value;
    else if (key === 'textContent') node.textContent = value;
    else if (key === 'innerHTML') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function setHtml(target, html) {
  const node = typeof target === 'string' ? $(target) : target;
  if (node) node.innerHTML = html;
  return node;
}

export function on(target, event, selectorOrHandler, handler) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) return () => {};
  if (typeof selectorOrHandler === 'function') {
    node.addEventListener(event, selectorOrHandler);
    return () => node.removeEventListener(event, selectorOrHandler);
  }
  const listener = (eventObject) => {
    const match = eventObject.target.closest(selectorOrHandler);
    if (match && node.contains(match)) handler(eventObject, match);
  };
  node.addEventListener(event, listener);
  return () => node.removeEventListener(event, listener);
}

export function initials(name) {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function toast(message, level = 'info', root = '#toast-root') {
  const container = typeof root === 'string' ? $(root) : root;
  if (!container) return;
  const item = el('div', { className: `toast toast--${level}`, role: 'status' });
  item.innerHTML = `<span class="toast__dot"></span><span>${escapeHtml(message)}</span>`;
  container.append(item);
  // A burst of events (e.g. a class joining) must not bury the screen.
  while (container.children.length > 4) container.firstElementChild?.remove();
  requestAnimationFrame(() => item.classList.add('is-visible'));
  setTimeout(() => {
    item.classList.remove('is-visible');
    setTimeout(() => item.remove(), 280);
  }, 3200);
}
