import { escapeHtml } from '../shared/dom.js';

/**
 * A scrollable look through the questions in one or more lists, with the right
 * answers marked, so the host can check the content before a game. It sits on
 * top of the settings page and changes nothing unless the host presses the
 * add or remove button for a single list.
 */

const LETTERS = ['A', 'B', 'C', 'D'];
let active = null;

export function closeQuestionPreview() {
  active?.close();
}

/**
 * lists: [{ id, name }]. load(id) resolves to that list's questions.
 * selection (single list only): { isChosen(), toggle() }, where toggle resolves
 * to whether the list is in the game afterwards.
 */
export function openQuestionPreview({ title, lists, load, selection = null }) {
  closeQuestionPreview();
  const opener = document.activeElement;
  const node = document.createElement('div');
  node.className = 'qpreview';
  node.innerHTML = `
    <section class="qpreview__box hud" role="dialog" aria-modal="true" aria-label="Question preview">
      <header class="qpreview__head">
        <div>
          <h2 class="qpreview__title">${escapeHtml(title)}</h2>
          <p class="qpreview__count" data-count>Loading questions…</p>
        </div>
        <div class="qpreview__tools">
          ${
            lists.length > 1
              ? `<select class="input qpreview__select" data-filter aria-label="Show one list">
                  <option value="">All ${lists.length} lists</option>
                  ${lists.map((list) => `<option value="${escapeHtml(list.id)}">${escapeHtml(list.name)}</option>`).join('')}
                </select>`
              : ''
          }
          <button class="btn btn--small btn--ghost" type="button" data-shuffle aria-pressed="false">SHUFFLE</button>
        </div>
      </header>
      <div class="qpreview__body scroll-wide" data-body tabindex="0"></div>
      <footer class="qpreview__foot">
        <span class="qpreview__note">The correct answer is marked. In the game the answers appear in a random order.</span>
        ${selection ? '<button class="btn btn--small" type="button" data-select></button>' : ''}
        <button class="btn btn--primary" type="button" data-close>BACK TO SETTINGS</button>
      </footer>
    </section>`;
  document.body.append(node);

  const body = node.querySelector('[data-body]');
  const count = node.querySelector('[data-count]');
  const filter = node.querySelector('[data-filter]');
  const shuffleButton = node.querySelector('[data-shuffle]');
  const selectButton = node.querySelector('[data-select]');
  let rows = [];
  let order = null; // a shuffled copy of rows while SHUFFLE is on

  function draw() {
    const only = filter?.value || '';
    const shown = (order || rows).filter((row) => !only || row.listId === only);
    count.textContent = `${shown.length} question${shown.length === 1 ? '' : 's'}`;
    body.innerHTML = shown.length
      ? `<ol class="qpreview__list">${shown
          .map(
            (row, index) => `
          <li class="qpreview__item">
            <p class="qpreview__meta">${index + 1} · ${escapeHtml(row.listName)}${row.category ? ` · ${escapeHtml(row.category)}` : ''}</p>
            <p class="qpreview__prompt">${escapeHtml(row.prompt)}</p>
            <ul class="qpreview__options">
              ${row.options
                .map(
                  (option, i) =>
                    `<li class="${i === row.answerIndex ? 'is-correct' : ''}"><b>${LETTERS[i] || i + 1}</b><span>${escapeHtml(option)}</span>${i === row.answerIndex ? '<em>✓ CORRECT</em>' : ''}</li>`,
                )
                .join('')}
            </ul>
          </li>`,
          )
          .join('')}</ol>`
      : '<p class="muted">There are no questions to show.</p>';
    body.scrollTop = 0;
  }

  function labelSelect(chosen = selection?.isChosen()) {
    if (!selectButton) return;
    selectButton.textContent = chosen ? 'REMOVE FROM GAME' : 'ADD TO GAME';
  }

  function onKey(event) {
    // Keep Escape and the game keys away from the page underneath.
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  }

  function close() {
    if (active !== handle) return;
    active = null;
    window.removeEventListener('keydown', onKey, true);
    node.remove();
    opener?.focus?.();
  }

  const handle = { close };
  active = handle;
  window.addEventListener('keydown', onKey, true);

  node.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (event.target === node || event.target.closest('[data-close]')) {
      close();
    } else if (event.target.closest('[data-shuffle]')) {
      if (order) order = null;
      else {
        order = [...rows];
        for (let i = order.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
      }
      shuffleButton.setAttribute('aria-pressed', String(Boolean(order)));
      shuffleButton.textContent = order ? 'IN ORDER' : 'SHUFFLE';
      draw();
    } else if (event.target.closest('[data-select]')) {
      selectButton.disabled = true;
      const chosen = await selection.toggle();
      selectButton.disabled = false;
      labelSelect(chosen);
    }
  });
  node.addEventListener('change', (event) => {
    event.stopPropagation();
    if (event.target === filter) draw();
  });

  labelSelect();
  body.focus();

  Promise.all(
    lists.map(async (list) => (await load(list.id)).map((question) => ({ ...question, listId: list.id, listName: list.name }))),
  )
    .then((loaded) => {
      if (active !== handle) return;
      rows = loaded.flat();
      draw();
    })
    .catch((error) => {
      if (active !== handle) return;
      count.textContent = 'Could not load the questions';
      body.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
    });
}
