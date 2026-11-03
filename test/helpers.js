import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuestionStore } from '../server/questions/store.js';
import { SEED_QUESTIONS } from '../server/config.js';
import { Game } from '../server/game/game.js';

export function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyber-battleships-test-'));
  const store = new QuestionStore({ dataDir: dir, seedFile: SEED_QUESTIONS });
  return { store, dir };
}

export function makeGame(settings = {}) {
  const { store, dir } = makeStore();
  const game = new Game({ store, settings: { questionSeconds: 0, ...settings } });
  return { game, store, dir };
}

/** A deterministic fleet layout for manual placement tests. */
export const TEST_FLEET = [
  { key: 'carrier', cells: [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 }, { col: 4, row: 0 }] },
  { key: 'battleship', cells: [{ col: 0, row: 1 }, { col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }] },
  { key: 'cruiser', cells: [{ col: 0, row: 2 }, { col: 1, row: 2 }, { col: 2, row: 2 }] },
  { key: 'submarine', cells: [{ col: 0, row: 3 }, { col: 1, row: 3 }, { col: 2, row: 3 }] },
  { key: 'destroyer', cells: [{ col: 0, row: 4 }, { col: 1, row: 4 }] },
];

export function shipCells() {
  return TEST_FLEET.flatMap((ship) => ship.cells);
}

export function joinTeam(game, name, teamId) {
  return game.join({ code: game.code, name, teamId });
}

export function once(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

export function waitForState(socket, predicate, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('state', handler);
      reject(new Error('Timed out waiting for matching state'));
    }, timeout);
    const handler = (state) => {
      try {
        if (predicate(state)) {
          clearTimeout(timer);
          socket.off('state', handler);
          resolve(state);
        }
      } catch (error) {
        clearTimeout(timer);
        socket.off('state', handler);
        reject(error);
      }
    };
    socket.on('state', handler);
  });
}
