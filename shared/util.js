/** Small text utilities shared by server and browser clients. */
export function cleanText(value, maxLength = 80) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function nameKey(value) {
  return cleanText(value, 80).toLowerCase();
}

export function normaliseCode(value) {
  return cleanText(value, 16).replace(/[^a-z0-9]/gi, '').toUpperCase();
}

export function compactNumber(value) {
  const n = Number(value) || 0;
  return Intl.NumberFormat('en-GB', { notation: n >= 10000 ? 'compact' : 'standard' }).format(n);
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function titleCase(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/(^|[\s_-])([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}
