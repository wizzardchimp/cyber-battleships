const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function coordLabel(x, y) {
  return `${LETTERS[x] || x + 1}${y + 1}`;
}

/**
 * Render a battle grid as HTML. Cells are buttons when interactive and spans
 * otherwise. Shots are always visible; ships only when `ships` is provided
 * (the server sends them once the game is over).
 */
export function renderGrid({
  size = 10,
  shots = [],
  ships = [],
  interactive = false,
  disabled = false,
  axes = true,
  label = 'battle grid',
} = {}) {
  const shotMap = new Map();
  for (const shot of shots) shotMap.set(`${shot.x},${shot.y}`, shot);

  const shipMap = new Map();
  for (const ship of ships || []) {
    for (const cell of ship.cells || []) shipMap.set(`${cell.x},${cell.y}`, ship);
  }

  const columns = axes ? size + 1 : size;
  const parts = [
    `<div class="battle-grid" style="--grid-size:${columns}" role="grid" aria-label="${label}">`,
  ];

  if (axes) {
    parts.push('<span class="battle-axis" aria-hidden="true"></span>');
    for (let x = 0; x < size; x += 1) {
      parts.push(`<span class="battle-axis" aria-hidden="true">${LETTERS[x] || x + 1}</span>`);
    }
  }

  for (let y = 0; y < size; y += 1) {
    if (axes) parts.push(`<span class="battle-axis" aria-hidden="true">${y + 1}</span>`);
    for (let x = 0; x < size; x += 1) {
      const key = `${x},${y}`;
      const shot = shotMap.get(key);
      const ship = shipMap.get(key);
      const classes = ['battle-cell'];
      if (shot) classes.push(shot.hit ? 'is-hit' : 'is-miss');
      if (ship) {
        classes.push('is-ship');
        if (ship.sunk) classes.push('is-sunk');
      }
      const coordinate = coordLabel(x, y);
      const title = shot
        ? `${coordinate} ${shot.hit ? 'hit' : 'miss'}`
        : ship
          ? `${coordinate} ${ship.name}`
          : coordinate;

      if (interactive) {
        parts.push(
          `<button class="${classes.join(' ')}" type="button" data-fire-x="${x}" data-fire-y="${y}" aria-label="${title}" ${shot || disabled ? 'disabled' : ''}></button>`,
        );
      } else {
        parts.push(`<span class="${classes.join(' ')}" title="${title}"></span>`);
      }
    }
  }

  parts.push('</div>');
  return parts.join('');
}
