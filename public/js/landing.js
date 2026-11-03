/** Landing page: prefill the game code and show the live session QR. */

import { $, esc, showToast } from './lib/dom.js';

const params = new URLSearchParams(window.location.search);
const urlCode = (params.get('code') || '').trim().toUpperCase();

const codeInput = $('#landingCode');
const hint = $('#landingHint');
const qrBox = $('#liveQr');
const liveCode = $('#liveCode');
const liveUrl = $('#liveUrl');
const livePhase = $('#livePhase');
const liveStats = $('#liveStats');

if (urlCode) codeInput.value = urlCode;

const PHASE_COPY = {
  lobby: 'LOBBY OPEN',
  question: 'BRIEFING LIVE',
  reveal: 'SOLUTION',
  battle: 'IN COMBAT',
  ended: 'DEBRIEF',
};

let fetchTimer = null;

async function refreshSession() {
  try {
    const response = await fetch('/api/join', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.code) throw new Error('Malformed response');

    liveCode.textContent = data.code;
    liveUrl.textContent = data.url;
    livePhase.textContent = PHASE_COPY[data.phase] || String(data.phase || 'LIVE').toUpperCase();
    livePhase.className = `chip ${data.phase === 'lobby' ? 'live' : (data.phase === 'ended' ? 'warn' : 'good')}`;

    if (data.qr) {
      qrBox.innerHTML = `<img src="${esc(data.qr)}" alt="QR code to join game ${esc(data.code)}" />`;
    }

    const phaseNote = data.phase === 'lobby'
      ? 'Scan to join the lobby'
      : (data.phase === 'ended' ? 'Waiting for a new game' : 'Late join may be open');
    liveStats.innerHTML = `<span>${esc(phaseNote)}</span><span>Server <b>online</b></span>`;

    if (!codeInput.value.trim()) {
      codeInput.value = data.code;
      codeInput.dataset.autofilled = 'true';
    }
  } catch {
    liveCode.textContent = '-----';
    liveUrl.textContent = 'Operations server not reachable';
    livePhase.textContent = 'OFFLINE';
    livePhase.className = 'chip bad';
    liveStats.innerHTML = '<span>Start the server to go live</span><span>Server <b>offline</b></span>';
    qrBox.innerHTML = '<div class="l-qr-placeholder">Server<br />offline</div>';
  }
}

$('#landingJoin').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = codeInput.value.trim().toUpperCase();
  if (code.length < 4) {
    hint.textContent = 'Enter the full game code shown on the projector.';
    hint.classList.add('bad');
    codeInput.focus();
    return;
  }
  hint.classList.remove('bad');
  hint.textContent = 'Opening operator console…';
  window.location.href = `/play?code=${encodeURIComponent(code)}`;
});

codeInput.addEventListener('input', () => {
  codeInput.dataset.autofilled = 'false';
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  hint.classList.remove('bad');
});

refreshSession();
fetchTimer = setInterval(() => {
  if (document.visibilityState === 'visible') refreshSession();
}, 20000);

window.addEventListener('beforeunload', () => {
  if (fetchTimer) clearInterval(fetchTimer);
});

// Surface a friendly note if someone opens the file directly from disk.
if (window.location.protocol === 'file:') {
  showToast('Open this page through the Node server, not as a local file.', 'bad', 8000);
  hint.textContent = 'Run "npm start" and open the address printed in the terminal.';
  hint.classList.add('bad');
}
