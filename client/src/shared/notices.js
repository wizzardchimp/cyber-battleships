import { escapeHtml } from './dom.js';
import { sfx } from './audio.js';

/** Full-screen notices shared by the big screen and the phones. */

let readyTimers = [];

export function cancelGetReady() {
  for (const timer of readyTimers) clearTimeout(timer);
  readyTimers = [];
  document.querySelector('.get-ready')?.remove();
}

/**
 * "GET READY, 3, 2, 1, GO!" before a question round. opensIn is how long until
 * answering opens; joining part-way through picks up at the right number.
 * The banner blocks taps until GO.
 */
export function runGetReady({ opensIn, sound = true }) {
  cancelGetReady();
  if (!(opensIn > 300)) return;
  const node = document.createElement('div');
  node.className = 'get-ready is-blocking';
  node.setAttribute('role', 'alert');
  document.body.append(node);

  const show = (label, kind) => {
    node.innerHTML = `<div class="get-ready__card get-ready__card--${kind}"><strong>${label}</strong></div>`;
  };
  const steps = [
    { left: Infinity, label: 'GET READY', kind: 'ready' },
    { left: 3000, label: '3', kind: 'count' },
    { left: 2000, label: '2', kind: 'count' },
    { left: 1000, label: '1', kind: 'count' },
  ];
  const current = [...steps].reverse().find((step) => opensIn <= step.left) || steps[0];
  show(current.label, current.kind);
  for (const step of steps) {
    if (step.left >= opensIn) continue;
    readyTimers.push(
      setTimeout(() => {
        show(step.label, step.kind);
        if (sound) sfx.tick();
      }, opensIn - step.left),
    );
  }
  readyTimers.push(
    setTimeout(() => {
      node.classList.remove('is-blocking');
      show('GO!', 'go');
      if (sound) sfx.success();
    }, opensIn),
    setTimeout(() => node.remove(), opensIn + 800),
  );
}

export function getReadyBlocking() {
  return Boolean(document.querySelector('.get-ready.is-blocking'));
}

/** A full-screen warning that a fleet is down to its last ship. It never blocks taps. */
export function showLastBoat({ detail, color = '#ff4d6d', sound = true }) {
  const node = document.createElement('div');
  node.className = 'last-boat';
  node.style.setProperty('--side', color);
  node.setAttribute('role', 'alert');
  node.innerHTML = `<strong>LAST BOAT!</strong><span>${escapeHtml(detail)}</span>`;
  document.body.append(node);
  if (sound) sfx.alert();
  setTimeout(() => node.remove(), 3600);
}

/** Boards that have just gone down to one ship afloat, comparing two states. */
export function newLastBoats(before, after) {
  if (!before?.round || !after?.round || before.round.number !== after.round.number) return [];
  const previous = new Map((before.round.boards || []).map((board) => [board.id, board]));
  return (after.round.boards || []).filter((board) => {
    const old = previous.get(board.id);
    return old && board.shipsTotal > 1 && board.shipsTotal - board.shipsSunk === 1 && old.shipsTotal - old.shipsSunk > 1;
  });
}
