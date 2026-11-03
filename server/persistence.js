/**
 * Debounced, atomic snapshot persistence.
 *
 * A game in progress is written to DATA_DIR/game-state.json a few hundred
 * milliseconds after each change. On boot the snapshot is restored so a
 * server restart (or Railway redeploy) does not lose the session.
 */

import fs from 'node:fs';
import path from 'node:path';

export class StateStore {
  constructor({ dataDir, filename = 'game-state.json', debounceMs = 350 }) {
    this.file = path.join(dataDir, filename);
    this.dir = dataDir;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.pending = null;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  load() {
    if (!fs.existsSync(this.file)) return null;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      console.warn('[state] Snapshot could not be read, ignoring:', error.message);
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // best effort
      }
      return null;
    }
  }

  schedule(snapshot) {
    this.pending = snapshot;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const data = this.pending;
      this.pending = null;
      if (data) this.save(data);
    }, this.debounceMs);
  }

  save(snapshot) {
    const temp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(snapshot));
      fs.renameSync(temp, this.file);
      this.lastSaveAt = Date.now();
    } catch (error) {
      console.error('[state] Failed to save snapshot:', error.message);
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      const data = this.pending;
      this.pending = null;
      this.save(data);
    }
  }

  clear() {
    this.flush();
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      // best effort
    }
  }
}
