/** Socket.IO client wrapper. The client library is served by our own server. */

export function connect() {
  if (!window.io) {
    throw new Error('Socket.IO client failed to load.');
  }
  return window.io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 600,
    reconnectionDelayMax: 4000,
    timeout: 10000,
  });
}
