import '../../styles/tokens.css';
import '../../styles/landing.css';
import { $, on } from '../shared/dom.js';
import { unlockAudio, sfx } from '../shared/audio.js';
import { normaliseCode } from '../../../shared/util.js';

const form = $('#join-form');
const input = $('#join-code');
const error = $('#join-error');

const params = new URLSearchParams(window.location.search);
const preset = normaliseCode(params.get('code') || '');
if (preset) input.value = preset;
if (preset.length === 6) input.focus();

input.addEventListener('input', () => {
  input.value = normaliseCode(input.value);
  error.textContent = '';
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  unlockAudio();
  sfx.click();
  const code = normaliseCode(input.value);
  if (code.length !== 6) {
    error.textContent = 'Enter the six-character join code from the projector.';
    input.focus();
    sfx.error();
    return;
  }
  window.location.href = `/play?code=${encodeURIComponent(code)}`;
});

on(document, 'click', 'a', () => {
  unlockAudio();
  sfx.click();
});
