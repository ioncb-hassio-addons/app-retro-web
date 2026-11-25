import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../app/database.js";
import { loadConfig } from "../app/config.js";
import { ensureStorage } from "../app/storage.js";
import { createRetroApp } from "../app/server.js";
import { normalizeTitle, titleFromFilename } from "../app/titles.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadOrCreateSelfSignedCertificate, resolveTls } from "../app/tls.js";
import {
  buildCoverCandidates,
  crc32Buffer,
  createIndexWorker,
  hashFile,
} from "../app/indexer.js";
import { compatibleLocalSave } from "../public/local-store.js";
import { createLogger } from "../app/logger.js";

async function setup() {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "retro-web-test-"));
  ensureStorage(dataPath);
  const config = {
    dataPath,
    internalPort: 0,
    externalPort: 0,
    external_access: true,
    external_username: "player",
    external_password: "secret",
    allow_external_rom_upload: false,
    external_admin_password: "",
    session_timeout_hours: 1,
    max_upload_mb: 4096,
    profile_limit: 8,
    enable_arcade: true,
  };
  const db = createDatabase(dataPath);
  const ingress = await listen(createRetroApp(config, db, "ingress"));
  const external = await listen(createRetroApp(config, db, "external"));
  return { dataPath, config, db, ingress, external };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const result = app.listen(0, "127.0.0.1", () => resolve(result));
  });
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function json(response) {
  assert.ok(response.headers.get("content-type")?.includes("application/json"));
  return response.json();
}

test("external access is disabled until valid credentials are supplied", async () => {
  const fixture = await setup();
  try {
    const unauthorized = await fetch(`${fixture.external.base}/api/games`);
    assert.equal(unauthorized.status, 401);

    const failedLogin = await fetch(`${fixture.external.base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "player", password: "wrong" }),
    });
    assert.equal(failedLogin.status, 401);

    const login = await fetch(`${fixture.external.base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "player", password: "secret" }),
    });
    assert.equal(login.status, 200);
    assert.ok(login.headers.get("set-cookie"));
  } finally {
    await fixture.ingress.close();
    await fixture.external.close();
    fixture.db.close();
    fs.rmSync(fixture.dataPath, { recursive: true, force: true });
  }
});

test("ROM uploads, BIOS uploads, and profile saves are isolated", async () => {
  const fixture = await setup();
  try {
    const profileResponse = await fetch(
      `${fixture.ingress.base}/api/admin/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Player 2",
          avatar: "🕹️",
          color: "#5b8def",
        }),
      },
    );
    assert.equal(profileResponse.status, 201);
    const secondProfile = await json(profileResponse);
    const firstProfile = fixture.db
      .prepare("SELECT id FROM profiles WHERE name = 'Player 1'")
      .get();

    const romForm = new FormData();
    romForm.append("platform", "nes");
    romForm.append("title", "Test ROM");
    romForm.append("file", new Blob(["test-rom"]), "test.nes");
    const romUpload = await fetch(
      `${fixture.ingress.base}/api/admin/upload/rom`,
      { method: "POST", body: romForm },
    );
    assert.equal(romUpload.status, 201);
    const game = await json(romUpload);
    assert.equal(game.biosSystem, null);
    assert.equal(game.romFilename, "test.nes");

    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12);
    png.writeUInt32BE(32, 16);
    png.writeUInt32BE(32, 20);
    const coverForm = new FormData();
    coverForm.append(
      "file",
      new Blob([png], { type: "image/png" }),
      "cover.png",
    );
    const coverUpload = await fetch(
      `${fixture.ingress.base}/api/admin/games/${game.id}/cover`,
      { method: "PUT", body: coverForm },
    );
    assert.equal(coverUpload.status, 204);
    const invalidCoverForm = new FormData();
    invalidCoverForm.append(
      "file",
      new Blob(["<svg onload=alert(1)>"], { type: "image/svg+xml" }),
      "cover.svg",
    );
    const invalidCover = await fetch(
      `${fixture.ingress.base}/api/admin/games/${game.id}/cover`,
      { method: "PUT", body: invalidCoverForm },
    );
    assert.equal(invalidCover.status, 400);
    const games = await json(
      await fetch(`${fixture.ingress.base}/api/games`, {
        headers: { "x-profile-id": firstProfile.id },
      }),
    );
    assert.equal(games.find((item) => item.id === game.id).has_cover, 1);
    assert.equal(
      games.find((item) => item.id === game.id).cover_path,
      undefined,
    );
    const gameDetails = await json(
      await fetch(`${fixture.ingress.base}/api/games/${game.id}`, {
        headers: { "x-profile-id": firstProfile.id },
      }),
    );
    assert.equal(gameDetails.hasCover, true);

    const biosForm = new FormData();
    biosForm.append("system", "n64");
    biosForm.append("file", new Blob(["test-bios"]), "bios.bin");
    const biosUpload = await fetch(
      `${fixture.ingress.base}/api/admin/upload/bios`,
      { method: "POST", body: biosForm },
    );
    assert.equal(biosUpload.status, 204);
    fixture.db
      .prepare("UPDATE games SET bios_system = 'n64' WHERE id = ?")
      .run(game.id);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(fixture.dataPath, "bios", "n64", "manifest.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.filename, "bios.bin");
    assert.equal(
      manifest.hash,
      createHash("sha256")
        .update(
          fs.readFileSync(
            path.join(fixture.dataPath, "bios", "n64", "bios.bin"),
          ),
        )
        .digest("hex"),
    );

    const biosDownload = await fetch(
      `${fixture.ingress.base}/api/games/${game.id}/bios/${manifest.filename}`,
      { headers: { "x-profile-id": firstProfile.id } },
    );
    assert.equal(biosDownload.status, 200);
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(await biosDownload.arrayBuffer()))
        .digest("hex"),
      manifest.hash,
    );

    const firstSave = await fetch(
      `${fixture.ingress.base}/api/games/${game.id}/saves/state/1`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-profile-id": firstProfile.id,
          "x-retro-core": game.core,
          "x-retro-emulator-version": "4.2.3",
          "x-retro-rom-hash": game.hash,
        },
        body: new Uint8Array([1, 2, 3]),
      },
    );
    assert.equal(firstSave.status, 204);

    const secondProfileRead = await fetch(
      `${fixture.ingress.base}/api/games/${game.id}/saves/state/1`,
      {
        headers: {
          "x-profile-id": secondProfile.id,
          "x-retro-core": game.core,
          "x-retro-emulator-version": "4.2.3",
          "x-retro-rom-hash": game.hash,
        },
      },
    );
    assert.equal(secondProfileRead.status, 404);

    const firstProfileRead = await fetch(
      `${fixture.ingress.base}/api/games/${game.id}/saves/state/1`,
      {
        headers: {
          "x-profile-id": firstProfile.id,
          "x-retro-core": game.core,
          "x-retro-emulator-version": "4.2.3",
          "x-retro-rom-hash": game.hash,
        },
      },
    );
    assert.deepEqual(
      new Uint8Array(await firstProfileRead.arrayBuffer()),
      new Uint8Array([1, 2, 3]),
    );
    const incompatible = await fetch(
      `${fixture.ingress.base}/api/games/${game.id}/saves/state/1`,
      {
        headers: {
          "x-profile-id": firstProfile.id,
          "x-retro-core": "another-core",
          "x-retro-emulator-version": "4.2.3",
          "x-retro-rom-hash": game.hash,
        },
      },
    );
    assert.equal(incompatible.status, 409);
    const saveMetadata = await json(
      await fetch(
        `${fixture.ingress.base}/api/games/${game.id}/saves/state/1/meta`,
        { headers: { "x-profile-id": firstProfile.id } },
      ),
    );
    assert.equal(saveMetadata.hash.length, 64);
    assert.equal(saveMetadata.core, game.core);
    assert.equal(saveMetadata.romHash, game.hash);

    const staleWrite = await fetch(
      `${fixture.ingress.base}/api/games/${game.id}/saves/state/1`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-profile-id": firstProfile.id,
          "x-retro-core": game.core,
          "x-retro-emulator-version": "4.2.3",
          "x-retro-rom-hash": game.hash,
          "if-match-save-hash": "stale-hash",
        },
        body: new Uint8Array([9, 9, 9]),
      },
    );
    assert.equal(staleWrite.status, 412);

    const coverRead = await fetch(
      `${fixture.ingress.base}/api/games/${game.id}/cover`,
      { headers: { "x-profile-id": firstProfile.id } },
    );
    assert.equal(coverRead.status, 200);
    assert.equal(coverRead.headers.get("content-type"), "image/png");
  } finally {
    await fixture.ingress.close();
    await fixture.external.close();
    fixture.db.close();
    fs.rmSync(fixture.dataPath, { recursive: true, force: true });
  }
});

test("external sessions cannot reach admin routes by default", async () => {
  const fixture = await setup();
  try {
    const login = await fetch(`${fixture.external.base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "player", password: "secret" }),
    });
    const sessionCookie = login.headers.get("set-cookie").split(";")[0];
    const { csrf } = await login.json();

    const admin = await fetch(`${fixture.external.base}/api/admin/platforms`, {
      headers: {
        cookie: sessionCookie,
        "x-retro-csrf": csrf,
      },
    });
    assert.equal(admin.status, 404);
  } finally {
    await fixture.ingress.close();
    await fixture.external.close();
    fixture.db.close();
    fs.rmSync(fixture.dataPath, { recursive: true, force: true });
  }
});

test("external admin routes require a separately elevated session", async () => {
  const fixture = await setup();
  fixture.config.allow_external_rom_upload = true;
  fixture.config.external_admin_password = "admin-secret";
  fixture.db.close();
  await fixture.ingress.close();
  await fixture.external.close();

  const db = (await import("../app/database.js")).createDatabase(
    fixture.dataPath,
  );
  const external = await listen(createRetroApp(fixture.config, db, "external"));
  try {
    const login = await fetch(`${external.base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "player", password: "secret" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const { csrf } = await login.json();
    const blocked = await fetch(`${external.base}/api/admin/platforms`, {
      headers: { cookie, "x-retro-csrf": csrf },
    });
    assert.equal(blocked.status, 403);

    const elevation = await fetch(`${external.base}/api/external-admin/login`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-retro-csrf": csrf,
      },
      body: JSON.stringify({ password: "admin-secret" }),
    });
    assert.equal(elevation.status, 204);

    const platforms = await fetch(`${external.base}/api/admin/platforms`, {
      headers: { cookie },
    });
    assert.equal(platforms.status, 200);
    assert.ok((await json(platforms)).some((item) => item.id === "nes"));
  } finally {
    await external.close();
    db.close();
    fs.rmSync(fixture.dataPath, { recursive: true, force: true });
  }
});

test("unsafe external configuration is rejected", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "retro-web-options-"),
  );
  const optionsPath = path.join(directory, "options.json");
  fs.writeFileSync(
    optionsPath,
    JSON.stringify({
      external_access: true,
      allow_external_rom_upload: true,
      external_username: "player",
      external_password: "secret",
    }),
  );
  assert.throws(
    () => loadConfig(optionsPath),
    /External ROM uploads require external_admin_password/,
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test("ROM titles are normalized and profile language is persisted", async () => {
  assert.equal(titleFromFilename("Super_Mario_64.z64"), "Super Mario 64");
  assert.equal(
    titleFromFilename("Final.Fantasy.VI.USA.sfc"),
    "Final Fantasy VI USA",
  );
  assert.equal(normalizeTitle(" Manual Title ", "ignored.z64"), "Manual Title");

  const fixture = await setup();
  try {
    const profile = fixture.db
      .prepare("SELECT id FROM profiles ORDER BY created_at LIMIT 1")
      .get();
    const selected = await fetch(
      `${fixture.ingress.base}/api/profiles/select`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: profile.id }),
      },
    );
    const cookie = selected.headers.get("set-cookie").split(";")[0];
    const changed = await fetch(
      `${fixture.ingress.base}/api/profiles/${profile.id}`,
      {
        method: "PATCH",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ language: "en" }),
      },
    );
    assert.equal(changed.status, 204);
    assert.equal(
      fixture.db
        .prepare("SELECT language FROM profiles WHERE id = ?")
        .get(profile.id).language,
      "en",
    );
  } finally {
    await fixture.ingress.close();
    await fixture.external.close();
    fixture.db.close();
    fs.rmSync(fixture.dataPath, { recursive: true, force: true });
  }
});

test("large save states can be synchronized in chunks", async () => {
  const fixture = await setup();
  try {
    const profile = fixture.db
      .prepare("SELECT id FROM profiles ORDER BY created_at LIMIT 1")
      .get();
    fixture.db
      .prepare(
        `INSERT INTO games
         (id, title, platform, core, extension, rom_path, bios_system, size, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        "chunk-game",
        "Chunk Game",
        "nes",
        "fceumm",
        ".nes",
        path.join(fixture.dataPath, "roms", "chunk.nes"),
        1,
        "chunk-rom-hash",
        new Date().toISOString(),
      );
    const save = Buffer.alloc(17 * 1024 * 1024 + 123, 7);
    const hash = createHash("sha256").update(save).digest("hex");
    const chunks = Math.ceil(save.byteLength / (1024 * 1024));
    const startResponse = await fetch(
      `${fixture.ingress.base}/api/games/chunk-game/saves/state/1/chunked/start`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-profile-id": profile.id,
        },
        body: JSON.stringify({
          totalSize: save.byteLength,
          totalChunks: chunks,
          hash,
          ifMatchSaveHash: "none",
          emulatorVersion: "4.2.3",
          core: "fceumm",
          romHash: "chunk-rom-hash",
        }),
      },
    );
    const start = await json(startResponse);
    for (let index = 0; index < chunks; index += 1) {
      const from = index * 1024 * 1024;
      const chunk = save.subarray(
        from,
        Math.min(from + 1024 * 1024, save.byteLength),
      );
      const uploaded = await fetch(
        `${fixture.ingress.base}/api/games/chunk-game/saves/state/1/chunked/${start.uploadId}/${index}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "x-profile-id": profile.id,
          },
          body: chunk,
        },
      );
      assert.equal(uploaded.status, 204);
    }
    const finished = await fetch(
      `${fixture.ingress.base}/api/games/chunk-game/saves/state/1/chunked/${start.uploadId}/finish`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-profile-id": profile.id,
        },
        body: "{}",
      },
    );
    assert.equal(finished.status, 204);
    const stored = fixture.db
      .prepare(
        "SELECT save_hash FROM saves WHERE profile_id = ? AND game_id = ?",
      )
      .get(profile.id, "chunk-game");
    assert.equal(stored.save_hash, hash);
    const metaResponse = await fetch(
      `${fixture.ingress.base}/api/games/chunk-game/saves/state/1/meta`,
      { headers: { "x-profile-id": profile.id } },
    );
    const meta = await json(metaResponse);
    const downloadedChunks = [];
    for (let index = 0; index < chunks; index += 1) {
      const response = await fetch(
        `${fixture.ingress.base}/api/games/chunk-game/saves/state/1/chunk/${index}`,
        { headers: { "x-profile-id": profile.id } },
      );
      assert.equal(response.status, 200);
      downloadedChunks.push(Buffer.from(await response.arrayBuffer()));
    }
    const downloaded = Buffer.concat(downloadedChunks);
    assert.equal(downloaded.length, meta.size);
    assert.equal(createHash("sha256").update(downloaded).digest("hex"), hash);
  } finally {
    await fixture.ingress.close();
    await fixture.external.close();
    fixture.db.close();
    fs.rmSync(fixture.dataPath, { recursive: true, force: true });
  }
});

test("manual ROM index detects new, changed, and deleted files", async () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "retro-web-index-"));
  ensureStorage(dataPath);
  const db = createDatabase(dataPath);
  const romDirectory = path.join(dataPath, "roms", "nes");
  fs.mkdirSync(romDirectory, { recursive: true });
  const romPath = path.join(romDirectory, "Test_Game.nes");
  fs.writeFileSync(romPath, "abcd");
  const biosDirectory = path.join(dataPath, "bios", "arcade");
  fs.mkdirSync(biosDirectory, { recursive: true });
  const biosPath = path.join(biosDirectory, "neogeo.zip");
  fs.writeFileSync(biosPath, "bios-data");

  const worker = createIndexWorker({
    config: { dataPath, enable_cover_indexing: false },
    db,
  });
  try {
    const first = await worker.runNow();
    assert.equal(first.new_files, 2);
    assert.equal(first.changed_files, 0);
    const indexed = db
      .prepare("SELECT sha1,crc32,version FROM indexed_files WHERE kind='rom'")
      .get();
    const biosManifest = JSON.parse(
      fs.readFileSync(path.join(biosDirectory, "manifest.json"), "utf8"),
    );
    assert.equal(
      biosManifest.hash,
      createHash("sha256").update(fs.readFileSync(biosPath)).digest("hex"),
    );
    assert.equal(indexed.sha1, (await hashFile(romPath)).sha1);
    assert.equal(indexed.crc32, crc32Buffer(Buffer.from("abcd")));
    assert.equal(indexed.version, 1);

    fs.writeFileSync(romPath, "efgh");
    const changed = await worker.runNow();
    assert.equal(changed.changed_files, 1);
    const changedRow = db
      .prepare("SELECT sha1,version FROM indexed_files WHERE kind='rom'")
      .get();
    assert.equal(changedRow.version, 2);
    assert.notEqual(changedRow.sha1, indexed.sha1);

    fs.rmSync(romPath);
    const deleted = await worker.runNow();
    assert.equal(deleted.deleted_files, 1);
    const game = db.prepare("SELECT deleted_at FROM games").get();
    assert.ok(game.deleted_at);
  } finally {
    db.close();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("cover candidates follow official name, full name, and prefixes", () => {
  assert.deepEqual(
    buildCoverCandidates("Street Fighter 3 3rd Strike", "Street Fighter III"),
    [
      "Street Fighter III",
      "Street Fighter 3 3rd Strike",
      "Street Fighter 3 3rd",
      "Street Fighter 3",
      "Street Fighter",
      "Street",
    ],
  );
});

test("local state compatibility requires core, ROM, and emulator version", () => {
  const game = {
    core: "fbneo",
    hash: "rom-hash",
    emulatorVersion: "4.2.3",
  };
  assert.equal(
    compatibleLocalSave(
      {
        blob: new Blob(["state"]),
        core: "fbneo",
        romHash: "rom-hash",
        emulatorVersion: "4.2.3",
      },
      game,
    ),
    true,
  );
  assert.equal(
    compatibleLocalSave(
      {
        blob: new Blob(["state"]),
        core: "fceumm",
        romHash: "rom-hash",
        emulatorVersion: "4.2.3",
      },
      game,
    ),
    false,
  );
});

test(
  "TLS resolves and reuses a persistent self-signed certificate",
  {
    skip: spawnSync("openssl", ["version"]).status !== 0,
  },
  () => {
    const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "retro-web-tls-"));
    try {
      const config = {
        dataPath,
        external_access: true,
        ssl: false,
        tls_self_signed_days: 365,
        tls_self_signed_common_name: "retro-web.local",
      };
      const first = resolveTls(config);
      assert.equal(first.source, "self_signed");
      assert.ok(fs.existsSync(first.certPath));
      assert.ok(fs.existsSync(first.keyPath));
      assert.equal(fs.statSync(first.keyPath).mode & 0o777, 0o600);

      const second = loadOrCreateSelfSignedCertificate(config);
      assert.equal(second.source, "self_signed");
      assert.deepEqual(second.cert, first.cert);
      assert.deepEqual(second.key, first.key);
    } finally {
      fs.rmSync(dataPath, { recursive: true, force: true });
    }
  },
);

test("TLS rejects unsafe Home Assistant certificate filenames", () => {
  const config = {
    external_access: true,
    ssl: true,
    certfile: "../fullchain.pem",
    keyfile: "privkey.pem",
  };
  assert.throws(() => resolveTls(config), /Invalid SSL filename/);
});

test("logger uses Home Assistant timestamp format and respects log level", () => {
  const originalLog = console.log;
  const messages = [];
  console.log = (message) => messages.push(message);
  try {
    const logger = createLogger({ log_level: "warning" });
    logger.info("Mensaje oculto");
    logger.warning("Mensaje visible");
  } finally {
    console.log = originalLog;
  }
  assert.equal(messages.length, 0);

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    createLogger({ log_level: "warning" }).warning("Estado indexado");
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings[0], /^\[\d{2}:\d{2}:\d{2}\] WARNING: Estado indexado$/);

  const originalInfo = console.log;
  const infos = [];
  console.log = (message) => infos.push(message);
  try {
    createLogger({ log_level: "info" }).info("Worker iniciado", {
      newFiles: 2,
    });
  } finally {
    console.log = originalInfo;
  }
  assert.match(
    infos[0],
    /^\[\d{2}:\d{2}:\d{2}\] INFO: Worker iniciado newFiles=2$/,
  );
});

test("service worker clones network responses before cache writes", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "sw.js"),
    "utf8",
  );
  assert.match(source, /const responseForCache = response\.clone\(\)/);
  assert.doesNotMatch(source, /cache\.put\(request,\s*response\)/);
});

test("cover hydration updates every duplicate game card", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "app.js"),
    "utf8",
  );
  assert.match(source, /querySelectorAll\("\[data-cover-game\]"\)/);
  assert.match(source, /for \(const image of images\)/);
  assert.doesNotMatch(source, /document\.querySelector\(`\[data-cover-game=/);
});

test("loading a state does not destroy or recreate the emulator", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "app.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /location\.reload\s*\(/);
  assert.match(source, /manager\.loadState\(state\)/);
  assert.match(source, /emulator\.play\?\.\(true\)/);
  assert.doesNotMatch(source, /emulator\.pause\?\.\(true\)/);
});

test("initial state lookup applies local save before comparing server metadata", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "app.js"),
    "utf8",
  );
  assert.match(
    source,
    /if \(compatibleLocalSave\(local, game\)\)[\s\S]*applySaveStateToRunningInstance\(buffer\)/,
  );
  assert.match(source, /remote\.hash === local\.hash/);
  assert.match(source, /remoteUpdatedAt <= localUpdatedAt/);
});

test("initial state is applied at EmulatorJS game start, not during ready", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "app.js"),
    "utf8",
  );
  assert.match(source, /window\.EJS_onGameStart = \(\) =>/);
  assert.match(
    source,
    /window\.EJS_onGameStart = \(\) =>[\s\S]*prepareInitialState\(game\)/,
  );
  assert.match(source, /initialStateApplied = false/);
  assert.match(source, /manager\.loadState\(state\)/);
});

test("clearing profile assets forces a fresh server asset download", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "app.js"),
    "utf8",
  );
  assert.match(source, /let assetsCacheCleared = false/);
  assert.match(source, /assetsCacheCleared = true/);
  assert.match(source, /!assetsCacheCleared[\s\S]*cached\?\.blob/);
  assert.match(source, /await teardownEmulatorForAssetReset\(\)/);
  assert.match(
    source,
    /async function teardownEmulatorForAssetReset\(\)[\s\S]*emulator\?\.(pause|gameManager)/,
  );
  const teardownStart = source.indexOf(
    "async function teardownEmulatorForAssetReset",
  );
  const nextFunction = source.indexOf(
    "\nasync function ",
    teardownStart + "async function teardownEmulatorForAssetReset".length,
  );
  const teardownBody =
    nextFunction >= 0
      ? source.slice(teardownStart, nextFunction)
      : source.slice(teardownStart);
  assert.doesNotMatch(teardownBody, /callEvent\?\.\(\"exit\"\)/);
});

test("exit before EmulatorJS starts goes directly to the library", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "app.js"),
    "utf8",
  );
  assert.match(source, /function isEmulatorStarted\(\)/);
  assert.match(source, /emulatorHasStarted = true/);
  assert.match(source, /return emulatorHasStarted/);
  assert.match(
    source,
    /if \(!isEmulatorStarted\(\)\)[\s\S]*teardownEmulatorForAssetReset\(\)/,
  );
  assert.doesNotMatch(source, /romset\|missing\|failed\|error\|desconocido/i);
});
test("storage and save sync use the shared retro dialog", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "app.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(
    source,
    /async function manageLocalStorage[\s\S]*showConfirmDialog/,
  );
  assert.match(
    source,
    /async function uploadLocalSaveIfConfirmed[\s\S]*showConfirmDialog/,
  );
  assert.match(source, /dialog-details/);
  assert.doesNotMatch(
    source,
    /primary:\s*t\("(clearLocalAssetsQuestion|clearLocalSavesQuestion|replaceServerSave)"\)/,
  );
  assert.match(source, /primary:\s*t\("replaceServerSaveAction"\)/);
});

test("unified local storage dialog exposes separate cleanup actions", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "app.js"),
    "utf8",
  );
  assert.match(source, /id:\s*"roms"/);
  assert.match(source, /id:\s*"bios"/);
  assert.match(source, /id:\s*"save"/);
  assert.match(source, /id:\s*"saves"/);
  assert.match(source, /clearProfileAssetKinds/);
  assert.match(source, /clearCurrentGameSaves/);
  assert.match(source, /clearProfileSaves/);
  assert.match(source, /primary:\s*t\("yes"\)/);
  assert.match(source, /cancel:\s*t\("no"\)/);
});

test("i18n dictionaries are split by language and have matching keys", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const i18nSource = fs.readFileSync(
    path.join(publicDirectory, "i18n.js"),
    "utf8",
  );
  const spanish = JSON.parse(
    fs.readFileSync(path.join(publicDirectory, "i18n", "es.json"), "utf8"),
  );
  const english = JSON.parse(
    fs.readFileSync(path.join(publicDirectory, "i18n", "en.json"), "utf8"),
  );

  assert.doesNotMatch(i18nSource, /const dictionaries\s*=\s*\{\s*es\s*:/);
  assert.match(i18nSource, /i18n\/es\.json/);
  assert.match(i18nSource, /i18n\/en\.json/);
  assert.deepEqual(Object.keys(spanish).sort(), Object.keys(english).sort());
  assert.ok(Object.keys(spanish).length > 100);
});
