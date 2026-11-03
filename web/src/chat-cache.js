const DATABASE = "vega-chat-messages";
let connection;
const revisions = new Map();
const keyOf = (user, employee) => JSON.stringify(employee === undefined ? [user] : [user, employee]);
const revision = (key) => revisions.get(key) || 0;
function invalidate(key) { revisions.set(key, revision(key) + 1); }
const range = (user, employee) => IDBKeyRange.bound(employee === undefined ? [user] : [user, employee], employee === undefined ? [user, []] : [user, employee, []]);

function openDatabase() {
  if (connection) return connection;
  connection = new Promise((resolve) => {
    let request, settled = false;
    const finish = (db) => { if (!settled) { settled = true; clearTimeout(timer); resolve(db); } else db?.close(); };
    const timer = setTimeout(() => finish(null), 1000);
    try {
      request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("messages", { keyPath: ["user", "employee", "seq"] });
        store.createIndex("conversation", ["user", "employee"]);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = undefined; };
        finish(db);
      };
      request.onerror = request.onblocked = () => finish(null);
    } catch { finish(null); }
  });
  return connection;
}

// This is a disposable read cache: blocked storage, quotas and private mode must never block chat.
async function access(mode, job) {
  const db = await openDatabase();
  if (!db) return;
  return new Promise((resolve) => {
    let tx, value;
    const timer = setTimeout(() => { try { tx?.abort(); } catch {} resolve(undefined); }, 1000);
    const finish = (result) => { clearTimeout(timer); resolve(result); };
    try {
      tx = db.transaction("messages", mode);
      tx.oncomplete = () => finish(value);
      tx.onabort = tx.onerror = () => finish(undefined);
      job(tx.objectStore("messages"), (result) => { value = result; });
    } catch { try { tx?.abort(); } catch {} finish(undefined); }
  });
}

export function createChatCache(user, employee) {
  const accountKey = keyOf(user), key = keyOf(user, employee);
  const accountVersion = revision(accountKey), version = revision(key);
  revisions.set(key, version);
  const valid = () => !!user && !!employee && accountVersion === revision(accountKey) && version === revision(key);
  return {
    valid,
    async read(before = Number.MAX_SAFE_INTEGER, limit = 60) {
      if (!valid()) return;
      return access("readonly", (store, done) => {
        if (!valid()) return;
        const rows = [];
        const request = store.openCursor(IDBKeyRange.bound([user, employee, 0], [user, employee, before], false, true), "prev");
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || rows.length === limit) {
            if (valid() && rows.length && rows.every((row) => row.session === rows[0].session && Number.isSafeInteger(row.message?.seq) && row.message.seq === row.seq))
              done({ session: rows[0].session, messages: rows.reverse().map((row) => row.message) });
            return;
          }
          rows.push(cursor.value);
          cursor.continue();
        };
      });
    },
    put(session, messages, replace = false) {
      if (!valid() || !session) return Promise.resolve();
      return access("readwrite", (store) => {
        if (!valid()) return;
        if (replace) store.delete(range(user, employee));
        for (const message of messages) {
          if (Number.isSafeInteger(message.seq) && message.seq > 0)
            store.put({ user, employee, session, seq: message.seq, message });
        }
      });
    },
    clear: () => clearChatCache(user, employee),
  };
}

export function clearChatCache(user, employee) {
  if (!user) return Promise.resolve();
  invalidate(keyOf(user, employee));
  return access("readwrite", (store) => store.delete(range(user, employee)));
}

export function pruneChatCache(user, employees) {
  if (!user) return Promise.resolve();
  const allowed = new Set(employees);
  for (const key of revisions.keys()) {
    const [owner, employee] = JSON.parse(key);
    if (owner === user && employee && !allowed.has(employee)) invalidate(key);
  }
  return access("readwrite", (store) => {
    const request = store.index("conversation").openKeyCursor(range(user), "nextunique");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const [, employee] = cursor.key;
      if (!allowed.has(employee)) store.delete(range(user, employee));
      cursor.continue();
    };
  });
}
