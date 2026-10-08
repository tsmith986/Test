// Tiny JSON-file datastore. This app has exactly one user, so a single JSON
// file (written atomically) is simpler and more portable than a database.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COLLECTIONS = ['leads', 'sites', 'submissions', 'requests', 'payments'];

export function createDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const file = path.join(dataDir, 'db.json');

  let state = { settings: {} };
  for (const c of COLLECTIONS) state[c] = [];
  if (fs.existsSync(file)) {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }

  let pending = null;
  function save() {
    // Coalesce bursts of writes into one disk write.
    if (pending) return;
    pending = setImmediate(() => {
      pending = null;
      flush();
    });
  }
  function flush() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  const now = () => new Date().toISOString();

  function collection(name) {
    if (!COLLECTIONS.includes(name)) throw new Error(`Unknown collection ${name}`);
    return {
      all: () => state[name],
      get: (id) => state[name].find((r) => r.id === id),
      find: (fn) => state[name].find(fn),
      filter: (fn) => state[name].filter(fn),
      insert(data) {
        const row = { id: crypto.randomUUID(), createdAt: now(), updatedAt: now(), ...data };
        state[name].push(row);
        save();
        return row;
      },
      update(id, patch) {
        const row = state[name].find((r) => r.id === id);
        if (!row) return null;
        Object.assign(row, patch, { id: row.id, createdAt: row.createdAt, updatedAt: now() });
        save();
        return row;
      },
      remove(id) {
        const i = state[name].findIndex((r) => r.id === id);
        if (i === -1) return false;
        state[name].splice(i, 1);
        save();
        return true;
      },
    };
  }

  return {
    dataDir,
    uploadsDir: path.join(dataDir, 'uploads'),
    leads: collection('leads'),
    sites: collection('sites'),
    submissions: collection('submissions'),
    requests: collection('requests'),
    payments: collection('payments'),
    getSettings: () => state.settings,
    setSettings(patch) {
      Object.assign(state.settings, patch);
      save();
      return state.settings;
    },
    flush,
  };
}
