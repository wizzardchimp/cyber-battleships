let offset = 0;

export function syncClock(serverNow) {
  if (Number.isFinite(serverNow)) offset = Number(serverNow) - Date.now();
}

export function serverNow() {
  return Date.now() + offset;
}

export function formatClock(timestamp) {
  if (!timestamp) return '--:--';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function msRemaining(endsAt) {
  if (!endsAt) return 0;
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, end - serverNow());
}

export function formatCountdown(endsAt) {
  const totalSeconds = Math.ceil(msRemaining(endsAt) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function timeAgo(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.round((serverNow() - Date.parse(timestamp)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
