const DATABASE_NAME = "retro-web-local";
const DATABASE_VERSION = 1;

let databasePromise;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
        const db = request.result;
        const assets = db.createObjectStore("assets", { keyPath: "key" });
        assets.createIndex("profileId", "profileId");
        assets.createIndex("kind", "kind");
        const saves = db.createObjectStore("saves", { keyPath: "key" });
        saves.createIndex("profileId", "profileId");
        saves.createIndex("gameId", "gameId");
        saves.createIndex("updatedAt", "updatedAt");
        const metadata = db.createObjectStore("metadata", { keyPath: "key" });
        metadata.createIndex("profileId", "profileId");
      };
    });
  }
  return databasePromise;
}

export async function sha256(input) {
  const source =
    input instanceof ArrayBuffer ? input : await blobToArrayBuffer(input);
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function getCachedAsset(profileId, kind, identifier) {
  return get("assets", assetKey(profileId, kind, identifier));
}

export async function cacheAsset(profileId, kind, identifier, metadata, blob) {
  const hash = await sha256(blob);
  const record = {
    key: assetKey(profileId, kind, identifier),
    profileId,
    kind,
    identifier,
    hash,
    size: blob.size,
    blob,
    updatedAt: Date.now(),
    ...metadata,
  };
  await put("assets", record);
  return record;
}

export async function putLocalSave(profileId, game, kind, slot, data) {
  const blob = new Blob([data], { type: "application/octet-stream" });
  const hash = await sha256(blob);
  const record = {
    key: saveKey(profileId, game.id, kind, slot),
    profileId,
    gameId: game.id,
    kind,
    slot,
    core: game.core,
    romHash: game.hash,
    emulatorVersion: game.emulatorVersion,
    size: blob.size,
    hash,
    blob,
    updatedAt: Date.now(),
  };
  await put("saves", record);
  await put("metadata", {
    key: saveKey(profileId, game.id, kind, slot),
    profileId,
    gameId: game.id,
    kind,
    slot,
    hash,
    size: blob.size,
    updatedAt: record.updatedAt,
  });
  return record;
}

export async function getLocalSave(profileId, gameId, kind, slot) {
  return get("saves", saveKey(profileId, gameId, kind, slot));
}

export async function listLocalSaves(profileId, gameId) {
  const db = await openDatabase();
  return transactionResult(
    db.transaction("saves", "readonly").objectStore("saves").index("profileId"),
    "getAll",
    IDBKeyRange.only(profileId),
  ).then((records) =>
    gameId ? records.filter((record) => record.gameId === gameId) : records,
  );
}

export async function getStorageUsage(profileId) {
  const db = await openDatabase();
  const assets = await transactionResult(
    db
      .transaction("assets", "readonly")
      .objectStore("assets")
      .index("profileId"),
    "getAll",
    IDBKeyRange.only(profileId),
  );
  const saves = await transactionResult(
    db.transaction("saves", "readonly").objectStore("saves").index("profileId"),
    "getAll",
    IDBKeyRange.only(profileId),
  );
  const assetsBytes = assets.reduce(
    (total, record) => total + (record.size || record.blob?.size || 0),
    0,
  );
  const savesBytes = saves.reduce(
    (total, record) => total + (record.size || record.blob?.size || 0),
    0,
  );
  return {
    assets: assetsBytes,
    saves: savesBytes,
    total: assetsBytes + savesBytes,
  };
}

export async function clearProfileAssets(profileId) {
  await deleteByProfile("assets", profileId);
}

export async function clearProfileSaves(profileId) {
  await deleteByProfile("saves", profileId);
  await deleteByProfile("metadata", profileId);
}

export async function rememberProfileContext(context) {
  await put("metadata", {
    key: "last-profile-context",
    profileId: context.profileId || "",
    ...context,
  });
}

export async function getRememberedProfileContext() {
  return get("metadata", "last-profile-context");
}

async function deleteByProfile(storeName, profileId) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  const index = transaction.objectStore(storeName).index("profileId");
  const request = index.openCursor(IDBKeyRange.only(profileId));
  await new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });
}

async function get(storeName, key) {
  const db = await openDatabase();
  return transactionResult(
    db.transaction(storeName, "readonly").objectStore(storeName),
    "get",
    key,
  );
}

async function put(storeName, value) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await transactionComplete(transaction);
}

function assetKey(profileId, kind, identifier) {
  return `profile:${profileId}:${kind}:${identifier}`;
}

function saveKey(profileId, gameId, kind, slot) {
  return `profile:${profileId}:game:${gameId}:${kind}:${slot}`;
}

function transactionResult(target, method, value) {
  return new Promise((resolve, reject) => {
    const request = target[method](value);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function blobToArrayBuffer(blob) {
  return blob.arrayBuffer();
}
