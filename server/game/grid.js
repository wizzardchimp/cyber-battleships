/**
 * Grid model: ship placement, hit resolution and serialisation.
 *
 * Pure logic - no sockets, timers or knowledge of players. A grid owns a
 * fleet and the record of shots that have landed on it.
 */

import {
  FLEET_TEMPLATE,
  FLEET_TOTAL_CELLS,
  GRID_COLS,
  GRID_ROWS,
  GameError,
  assert,
  coordName,
} from './constants.js';

const keyOf = (col, row) => `${col},${row}`;

export class Grid {
  constructor({ id, ownerTeamId = null, label = '', cols = GRID_COLS, rows = GRID_ROWS }) {
    this.id = id;
    this.ownerTeamId = ownerTeamId;
    this.label = label;
    this.cols = cols;
    this.rows = rows;
    this.ships = [];
    this.shots = new Map(); // "col,row" -> shot
    this.placementMode = 'random';
    this.locked = false;
  }

  /** Place a standard fleet randomly, avoiding overlapping cells. */
  placeRandom(rng = Math.random) {
    for (let fleetAttempt = 0; fleetAttempt < 200; fleetAttempt += 1) {
      const ships = [];
      const occupied = new Set();
      let failed = false;

      for (const template of FLEET_TEMPLATE) {
        let placed = false;
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const horizontal = rng() < 0.5;
          const maxCol = horizontal ? this.cols - template.length : this.cols - 1;
          const maxRow = horizontal ? this.rows - 1 : this.rows - template.length;
          const col = Math.floor(rng() * (maxCol + 1));
          const row = Math.floor(rng() * (maxRow + 1));
          const cells = [];
          let free = true;

          for (let i = 0; i < template.length; i += 1) {
            const c = horizontal ? col + i : col;
            const r = horizontal ? row : row + i;
            if (occupied.has(keyOf(c, r))) {
              free = false;
              break;
            }
            cells.push({ col: c, row: r });
          }

          if (free) {
            cells.forEach((cell) => occupied.add(keyOf(cell.col, cell.row)));
            ships.push({
              key: template.key,
              name: template.name,
              length: template.length,
              cells,
              hits: [],
            });
            placed = true;
            break;
          }
        }
        if (!placed) {
          failed = true;
          break;
        }
      }

      if (!failed) {
        this.ships = ships;
        this.shots = new Map();
        this.placementMode = 'random';
        return this;
      }
    }
    throw new GameError('FLEET_PLACEMENT_FAILED', 'Could not place the fleet. Try again.');
  }

  /**
   * Replace the fleet from host-supplied coordinates.
   * Ships look like: { key, cells: [{ col, row }] }.
   */
  setShips(ships) {
    assert(Array.isArray(ships), 'INVALID_SHIPS', 'Ships must be an array.');
    assert(ships.length === FLEET_TEMPLATE.length, 'INVALID_SHIPS', 'A full fleet of five ships is required.');

    const seenKeys = new Set();
    const occupied = new Set();
    const normalised = [];

    for (const input of ships) {
      const template = FLEET_TEMPLATE.find((entry) => entry.key === input.key);
      assert(template, 'INVALID_SHIPS', `Unknown ship: ${input?.key ?? 'missing'}`);
      assert(!seenKeys.has(template.key), 'INVALID_SHIPS', `Duplicate ship: ${template.name}`);
      seenKeys.add(template.key);

      const cells = Array.isArray(input.cells) ? input.cells : [];
      assert(cells.length === template.length, 'INVALID_SHIPS', `${template.name} must occupy ${template.length} cells.`);

      const parsed = cells.map((cell) => ({
        col: Number.parseInt(cell.col, 10),
        row: Number.parseInt(cell.row, 10),
      }));

      for (const cell of parsed) {
        assert(
          Number.isInteger(cell.col) && Number.isInteger(cell.row)
            && cell.col >= 0 && cell.col < this.cols
            && cell.row >= 0 && cell.row < this.rows,
          'INVALID_SHIPS',
          `${template.name} is outside the grid.`,
        );
        const key = keyOf(cell.col, cell.row);
        assert(!occupied.has(key), 'INVALID_SHIPS', 'Ships cannot overlap.');
        occupied.add(key);
      }

      const sameRow = parsed.every((cell) => cell.row === parsed[0].row);
      const sameCol = parsed.every((cell) => cell.col === parsed[0].col);
      assert(sameRow || sameCol, 'INVALID_SHIPS', `${template.name} must be in a straight line.`);

      const sorted = [...parsed].sort((a, b) => (sameRow ? a.col - b.col : a.row - b.row));
      for (let i = 1; i < sorted.length; i += 1) {
        const prev = sorted[i - 1];
        const current = sorted[i];
        const step = sameRow ? current.col - prev.col : current.row - prev.row;
        assert(step === 1, 'INVALID_SHIPS', `${template.name} cells must be contiguous.`);
      }

      normalised.push({
        key: template.key,
        name: template.name,
        length: template.length,
        cells: sorted,
        hits: [],
      });
    }

    assert(seenKeys.size === FLEET_TEMPLATE.length, 'INVALID_SHIPS', 'A full fleet of five ships is required.');
    this.ships = FLEET_TEMPLATE.map((tpl) => normalised.find((ship) => ship.key === tpl.key));
    this.shots = new Map();
    this.placementMode = 'manual';
    return this;
  }

  inBounds(col, row) {
    return Number.isInteger(col) && Number.isInteger(row)
      && col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  shipAt(col, row) {
    return this.ships.find((ship) => ship.cells.some((cell) => cell.col === col && cell.row === row)) || null;
  }

  hasShot(col, row) {
    return this.shots.has(keyOf(col, row));
  }

  /**
   * Resolve a shot at a coordinate.
   * Returns { hit, sunk, ship, coord, alreadyDestroyedFleet }.
   */
  fire(col, row, byTeamId, at = Date.now()) {
    assert(this.inBounds(col, row), 'INVALID_COORDINATE', 'That coordinate is outside the grid.');
    assert(this.ships.length > 0, 'NO_FLEET', 'This fleet has not been deployed yet.');
    assert(!this.hasShot(col, row), 'ALREADY_FIRED', 'That coordinate has already been targeted.');

    const ship = this.shipAt(col, row);
    const hit = Boolean(ship);
    let sunk = false;

    if (hit) {
      const key = keyOf(col, row);
      if (!ship.hits.includes(key)) ship.hits.push(key);
      sunk = ship.hits.length === ship.length;
    }

    const shot = {
      col,
      row,
      coord: coordName(col, row),
      byTeamId,
      hit,
      sunkShipKey: sunk ? ship.key : null,
      sunkShipName: sunk ? ship.name : null,
      at,
    };
    this.shots.set(keyOf(col, row), shot);

    return { hit, sunk, ship: ship ? { key: ship.key, name: ship.name } : null, shot };
  }

  isShipSunk(ship) {
    return ship.hits.length === ship.length;
  }

  get destroyed() {
    return this.ships.length > 0 && this.ships.every((ship) => this.isShipSunk(ship));
  }

  get health() {
    const hitCells = this.ships.reduce((sum, ship) => sum + ship.hits.length, 0);
    return {
      total: FLEET_TOTAL_CELLS,
      remaining: Math.max(0, FLEET_TOTAL_CELLS - hitCells),
      hits: hitCells,
    };
  }

  get shipSummary() {
    return this.ships.map((ship) => ({
      key: ship.key,
      name: ship.name,
      length: ship.length,
      hits: ship.hits.length,
      remaining: ship.length - ship.hits.length,
      sunk: this.isShipSunk(ship),
    }));
  }

  /**
   * Build the cell matrix for a particular viewer.
   * revealShips - show every ship cell (host, or player's own fleet)
   * Returns an array of rows, each an array of state strings.
   */
  cellMatrix({ revealShips = false } = {}) {
    const sunkCells = new Set();
    for (const ship of this.ships) {
      if (this.isShipSunk(ship)) {
        ship.cells.forEach((cell) => sunkCells.add(keyOf(cell.col, cell.row)));
      }
    }

    const matrix = [];
    for (let row = 0; row < this.rows; row += 1) {
      const line = [];
      for (let col = 0; col < this.cols; col += 1) {
        const key = keyOf(col, row);
        const shot = this.shots.get(key);
        const ship = this.shipAt(col, row);

        if (shot) {
          if (shot.hit) line.push(sunkCells.has(key) ? 'sunk' : 'hit');
          else line.push('miss');
        } else if (ship) {
          line.push(revealShips ? 'ship' : 'unknown');
        } else {
          line.push('unknown');
        }
      }
      matrix.push(line);
    }
    return matrix;
  }

  toJSON() {
    return {
      id: this.id,
      ownerTeamId: this.ownerTeamId,
      label: this.label,
      cols: this.cols,
      rows: this.rows,
      ships: this.ships.map((ship) => ({
        key: ship.key,
        name: ship.name,
        length: ship.length,
        cells: ship.cells.map((cell) => ({ ...cell })),
        hits: [...ship.hits],
      })),
      shots: [...this.shots.values()].map((shot) => ({ ...shot })),
      placementMode: this.placementMode,
      locked: this.locked,
    };
  }

  static fromJSON(data) {
    const grid = new Grid({
      id: data.id,
      ownerTeamId: data.ownerTeamId ?? null,
      label: data.label ?? '',
      cols: data.cols ?? GRID_COLS,
      rows: data.rows ?? GRID_ROWS,
    });
    grid.ships = (data.ships ?? []).map((ship) => ({
      key: ship.key,
      name: ship.name,
      length: ship.length,
      cells: ship.cells.map((cell) => ({ col: cell.col, row: cell.row })),
      hits: [...(ship.hits ?? [])],
    }));
    grid.shots = new Map((data.shots ?? []).map((shot) => [keyOf(shot.col, shot.row), shot]));
    grid.placementMode = data.placementMode ?? 'random';
    grid.locked = Boolean(data.locked);
    return grid;
  }
}
