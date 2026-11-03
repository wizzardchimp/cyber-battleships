import test from 'node:test';
import assert from 'node:assert/strict';
import { Grid } from '../server/game/grid.js';
import { FLEET_TEMPLATE, FLEET_TOTAL_CELLS } from '../server/game/constants.js';
import { TEST_FLEET, shipCells } from './helpers.js';

test('random placement produces a valid, non-overlapping fleet', () => {
  for (let run = 0; run < 120; run += 1) {
    const grid = new Grid({ id: 'g1' });
    grid.placeRandom();
    assert.equal(grid.ships.length, 5);
    const seen = new Set();
    let cells = 0;
    for (const ship of grid.ships) {
      assert.equal(ship.cells.length, ship.length);
      const row = ship.cells[0].row;
      const col = ship.cells[0].col;
      const horizontal = ship.cells.every((cell) => cell.row === row);
      const vertical = ship.cells.every((cell) => cell.col === col);
      assert.ok(horizontal || vertical, 'ship must be straight');
      for (const cell of ship.cells) {
        assert.ok(cell.col >= 0 && cell.col < 10);
        assert.ok(cell.row >= 0 && cell.row < 10);
        const key = `${cell.col},${cell.row}`;
        assert.ok(!seen.has(key), 'ships must not overlap');
        seen.add(key);
        cells += 1;
      }
    }
    assert.equal(cells, FLEET_TOTAL_CELLS);
  }
});

test('manual placement accepts a valid fleet and rejects overlaps', () => {
  const grid = new Grid({ id: 'g1' });
  grid.setShips(TEST_FLEET);
  assert.equal(grid.ships.length, FLEET_TEMPLATE.length);
  assert.equal(grid.placementMode, 'manual');

  const overlapping = TEST_FLEET.map((ship) => ({ ...ship, cells: ship.cells.map((cell) => ({ ...cell })) }));
  overlapping[1].cells = overlapping[0].cells.slice(0, 4);
  assert.throws(() => grid.setShips(overlapping), /overlap/i);
});

test('manual placement rejects broken lines and out of bounds cells', () => {
  const grid = new Grid({ id: 'g1' });
  const broken = TEST_FLEET.map((ship) => ({ ...ship, cells: ship.cells.map((cell) => ({ ...cell })) }));
  broken[0].cells = [
    { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 }, { col: 5, row: 0 },
  ];
  assert.throws(() => grid.setShips(broken), /contiguous/i);

  const outside = TEST_FLEET.map((ship) => ({ ...ship, cells: ship.cells.map((cell) => ({ ...cell })) }));
  outside[0].cells = [
    { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 }, { col: 10, row: 0 },
  ];
  assert.throws(() => grid.setShips(outside), /outside/i);
});

test('fire resolves hits, misses, repeats and a sunk ship', () => {
  const grid = new Grid({ id: 'g1' });
  grid.setShips(TEST_FLEET);

  const miss = grid.fire(9, 9, 't1');
  assert.equal(miss.hit, false);
  assert.equal(grid.health.remaining, FLEET_TOTAL_CELLS);

  const hit = grid.fire(0, 0, 't1');
  assert.equal(hit.hit, true);
  assert.equal(hit.sunk, false);
  assert.equal(grid.health.remaining, FLEET_TOTAL_CELLS - 1);

  assert.throws(() => grid.fire(0, 0, 't1'), /already been targeted/i);

  // Destroy the destroyer (two cells).
  grid.fire(0, 4, 't2');
  const last = grid.fire(1, 4, 't2');
  assert.equal(last.sunk, true);
  assert.equal(last.shot.sunkShipName, 'Destroyer');

  const matrix = grid.cellMatrix();
  assert.equal(matrix[4][0], 'sunk');
  assert.equal(matrix[4][1], 'sunk');
  assert.equal(matrix[9][9], 'miss');

  const ownView = grid.cellMatrix({ revealShips: true });
  assert.equal(ownView[0][1], 'ship');
});

test('grid is destroyed only when every ship cell is hit', () => {
  const grid = new Grid({ id: 'g1' });
  grid.setShips(TEST_FLEET);
  const cells = shipCells();
  cells.forEach((cell, index) => {
    const result = grid.fire(cell.col, cell.row, 't1');
    assert.equal(result.hit, true);
    if (index < cells.length - 1) assert.equal(grid.destroyed, false);
  });
  assert.equal(grid.destroyed, true);
  assert.equal(grid.health.remaining, 0);
});

test('serialisation round-trips a fired grid', () => {
  const grid = new Grid({ id: 'g1', ownerTeamId: 't1', label: 'ALPHA' });
  grid.setShips(TEST_FLEET);
  grid.fire(0, 0, 't2');
  const restored = Grid.fromJSON(JSON.parse(JSON.stringify(grid.toJSON())));
  assert.equal(restored.ships.length, 5);
  assert.equal(restored.hasShot(0, 0), true);
  assert.equal(restored.health.remaining, FLEET_TOTAL_CELLS - 1);
  assert.equal(restored.ownerTeamId, 't1');
});
