let database;

function openDatabase() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open("carrot-blood-pressure", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("changes", { keyPath: "seq", autoIncrement: true }).createIndex("user", "user");
        db.createObjectStore("months", { keyPath: ["user", "month"] }).createIndex("user", "user");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  }
  return database;
}

async function transaction(stores, mode, run) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const store = (name) => tx.objectStore(name);
    tx.oncomplete = () => resolve(result?.());
    tx.onabort = () => reject(tx.error);
    const result = run(store);
  });
}

export function enqueue(change) {
  return transaction(["changes"], "readwrite", (store) => {
    store("changes").add(change);
  });
}

export function queuedChanges(user) {
  return transaction(["changes"], "readonly", (store) => {
    const request = store("changes").index("user").getAll(user);
    return () => request.result;
  });
}

export function readMonth(user, month) {
  return transaction(["months", "changes"], "readonly", (store) => {
    const cache = store("months").get([user, month]);
    const changes = store("changes").index("user").getAll(user);
    return () => ({ cache: cache.result, changes: changes.result.filter((change) => change.month === month) });
  });
}

export function cacheMonth(user, month, records) {
  return transaction(["months"], "readwrite", (store) => {
    store("months").put({ user, month, records, complete: true });
  });
}

export function finishChange(change, reason) {
  return transaction(["changes", "months"], "readwrite", (store) => {
    const queue = store("changes");
    const current = queue.get(change.seq);
    current.onsuccess = () => {
      if (!current.result) return;
      if (reason) {
        queue.put({ ...change, reason });
        return;
      }
      queue.delete(change.seq);
      const months = store("months");
      const key = [change.user, change.month];
      const request = months.get(key);
      request.onsuccess = () => {
        const entry = request.result ?? { user: change.user, month: change.month, records: [], complete: false };
        const records = entry.records.filter((record) => record.id !== change.id);
        if (change.record) records.push(change.record);
        months.put({ ...entry, records });
      };
    };
  });
}

export function discardChanges(user, id) {
  return transaction(["changes"], "readwrite", (store) => {
    const queue = store("changes");
    const request = queue.index("user").getAll(user);
    request.onsuccess = () => {
      for (const change of request.result) {
        if (change.id === id) queue.delete(change.seq);
      }
    };
  });
}

export function clearHistory(user) {
  return transaction(["months"], "readwrite", (store) => {
    const months = store("months");
    const request = months.index("user").getAllKeys(user);
    request.onsuccess = () => {
      for (const key of request.result) months.delete(key);
    };
  });
}
