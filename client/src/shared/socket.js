import { io } from 'socket.io-client';

export function createSocket() {
  return io({
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 600,
    reconnectionDelayMax: 4000,
    timeout: 12_000,
  });
}

/** Promise-based emit so UI code can await server acknowledgements. */
export function request(socket, event, payload = {}, timeout = 12_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeout).emit(event, payload, (error, response) => {
      if (error) {
        const timeoutError = new Error('The server did not respond. Check your connection.');
        timeoutError.code = 'TIMEOUT';
        reject(timeoutError);
        return;
      }
      if (response?.ok === false) {
        const commandError = new Error(response.error?.message || 'Command rejected.');
        commandError.code = response.error?.code || 'COMMAND_FAILED';
        reject(commandError);
        return;
      }
      resolve(response || { ok: true });
    });
  });
}

export function emit(socket, event, payload = {}) {
  socket.emit(event, payload);
}
