import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../app/database.js";
import { loadConfig } from "../app/config.js";
import { ensureStorage, seedDefaultSystemAvatars } from "../app/storage.js";
import { createRetroApp, rateLimitKey } from "../app/server.js";
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
import { createLogger, formatLogTimestamp } from "../app/logger.js";

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

test("new profiles use a random valid default color", async () => {
  const fixture = await setup();
  try {
    const form = new FormData();
    form.append("name", "Random Color");
    form.append("avatar", "🎮");
    form.append("language", "es");
    const response = await fetch(`${fixture.ingress.base}/api/admin/profiles`, {
      method: "POST",
      body: form,
    });
    assert.equal(response.status, 201);
    const profile = await json(response);
    assert.match(profile.color, /^#[0-9a-f]{6}$/i);
  } finally {
    await fixture.ingress.close();
    await fixture.external.close();
    fixture.db.close();
    fs.rmSync(fixture.dataPath, { recursive: true, force: true });
  }
});

test("avatar rate limits are separated by profile and fall back to IP", () => {
  const request = {
    ip: "127.0.0.1",
    headers: {
      cookie: "retro_web_profile=11111111-1111-1111-1111-111111111111",
    },
    get(name) {
      if (name === "x-profile-id") return "";
      return "";
    },
  };
  assert.equal(
    rateLimitKey(request, null, "ingress"),
    "profile:11111111-1111-1111-1111-111111111111",
  );

  const secondProfileRequest = {
    ip: "127.0.0.1",
    headers: {
      cookie: "retro_web_profile=22222222-2222-2222-2222-222222222222",
    },
    get() {
      return "";
    },
  };
  assert.equal(
    rateLimitKey(secondProfileRequest, null, "ingress"),
    "profile:22222222-2222-2222-2222-222222222222",
  );

  const noProfileRequest = {
    ip: "127.0.0.2",
    headers: { cookie: "" },
    get() {
      return "";
    },
  };
  assert.equal(rateLimitKey(noProfileRequest, null, "ingress"), "ip:127.0.0.2");
});

test("first installation seeds the 40 default system avatars once", () => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "retro-web-avatars-"));
  try {
    ensureStorage(dataPath);
    const systemDirectory = path.join(dataPath, "avatars", "system");
    const avatars = fs
      .readdirSync(systemDirectory)
      .filter((filename) => /^avatar_\d{2}\.webp$/i.test(filename))
      .sort();

    assert.equal(avatars.length, 40);
    assert.equal(avatars[0], "avatar_01.webp");
    assert.equal(avatars[39], "avatar_40.webp");

    fs.writeFileSync(
      path.join(systemDirectory, "avatar_02.webp"),
      Buffer.from("administrator-avatar"),
    );
    seedDefaultSystemAvatars(dataPath);
    assert.equal(
      fs.readFileSync(path.join(systemDirectory, "avatar_02.webp"), "utf8"),
      "administrator-avatar",
    );
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test("packaged default avatars have no transparent bottom margin", () => {
  const defaultsDirectory = path.join(process.cwd(), "app", "default-avatars");
  const avatars = fs
    .readdirSync(defaultsDirectory)
    .filter((filename) => /^avatar_\d{2}\.webp$/i.test(filename))
    .sort();

  assert.equal(avatars.length, 40);
  for (const filename of avatars) {
    const buffer = fs.readFileSync(path.join(defaultsDirectory, filename));
    assert.equal(buffer.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(buffer.subarray(8, 12).toString("ascii"), "WEBP");
  }
});

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

test("profile avatars support system selection and custom WebP uploads", async () => {
  const fixture = await setup();
  try {
    const webpSignature = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([36, 0, 0, 0]),
      Buffer.from("WEBP"),
    ]);

    assert.ok(
      (await json(await fetch(`${fixture.ingress.base}/api/avatars`))).includes(
        "avatar_02.webp",
      ),
    );

    const systemAvatarResponse = await fetch(
      `${fixture.ingress.base}/api/avatars/avatar_02.webp`,
    );
    assert.equal(systemAvatarResponse.status, 200);
    assert.match(
      systemAvatarResponse.headers.get("content-type") || "",
      /webp/,
    );
    assert.match(
      systemAvatarResponse.headers.get("cache-control") || "",
      /private, max-age=3600, must-revalidate/,
    );

    const systemForm = new FormData();
    systemForm.append("name", "System Avatar");
    systemForm.append("avatar", "avatar_02.webp");
    systemForm.append("color", "#5b8def");
    systemForm.append("language", "es");
    const systemResponse = await fetch(
      `${fixture.ingress.base}/api/admin/profiles`,
      { method: "POST", body: systemForm },
    );
    assert.equal(systemResponse.status, 201);
    const systemProfile = await json(systemResponse);
    assert.equal(systemProfile.avatar, "avatar_02.webp");

    const customForm = new FormData();
    customForm.append("name", "Custom Avatar");
    customForm.append("avatar", "custom");
    customForm.append("color", "#ff3b6b");
    customForm.append("language", "en");
    customForm.append(
      "avatarFile",
      new Blob([webpSignature], { type: "image/webp" }),
      "avatar.webp",
    );
    const customResponse = await fetch(
      `${fixture.ingress.base}/api/admin/profiles`,
      { method: "POST", body: customForm },
    );
    assert.equal(customResponse.status, 201);
    const customProfile = await json(customResponse);
    assert.equal(customProfile.avatar, "custom");

    const avatarResponse = await fetch(
      `${fixture.ingress.base}/api/profiles/${customProfile.id}/avatar`,
    );
    assert.equal(avatarResponse.status, 200);
    assert.match(avatarResponse.headers.get("content-type") || "", /webp/);
    assert.match(
      avatarResponse.headers.get("cache-control") || "",
      /private, max-age=3600, must-revalidate/,
    );

    const patchForm = new FormData();
    patchForm.append("avatar", "avatar_02.webp");
    const patchResponse = await fetch(
      `${fixture.ingress.base}/api/admin/profiles/${customProfile.id}`,
      { method: "PATCH", body: patchForm },
    );
    assert.equal(patchResponse.status, 200);
    assert.equal((await json(patchResponse)).avatar, "avatar_02.webp");
    assert.equal(
      (
        await fetch(
          `${fixture.ingress.base}/api/profiles/${customProfile.id}/avatar`,
        )
      ).status,
      404,
    );

    const invalidForm = new FormData();
    invalidForm.append(
      "avatarFile",
      new Blob(["not-a-webp"], { type: "image/png" }),
      "avatar.png",
    );
    const invalidResponse = await fetch(
      `${fixture.ingress.base}/api/admin/profiles/${systemProfile.id}`,
      { method: "PATCH", body: invalidForm },
    );
    assert.equal(invalidResponse.status, 400);

    const traversalResponse = await fetch(
      `${fixture.ingress.base}/api/avatars/%2e%2e%2Favatar_02.webp`,
    );
    assert.equal(traversalResponse.status, 404);

    const traversalDelete = await fetch(
      `${fixture.ingress.base}/api/admin/avatars/..%2Fserver.js`,
      { method: "DELETE" },
    );
    assert.equal(traversalDelete.status, 400);

    const deleteResponse = await fetch(
      `${fixture.ingress.base}/api/admin/avatars/avatar_02.webp`,
      { method: "DELETE" },
    );
    assert.equal(deleteResponse.status, 204);
    assert.equal(
      (await fetch(`${fixture.ingress.base}/api/avatars/avatar_02.webp`))
        .status,
      404,
    );

    for (let index = 0; index < 301; index += 1) {
      await fetch(`${fixture.ingress.base}/api/avatars`);
    }
    const limitedResponse = await fetch(`${fixture.ingress.base}/api/avatars`);
    assert.equal(limitedResponse.status, 429);
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
    logger.info("Hidden message");
    logger.warning("Visible message");
  } finally {
    console.log = originalLog;
  }
  assert.equal(messages.length, 0);

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    createLogger({ log_level: "warning" }).warning("Indexed state");
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings[0], /^\[\d{2}:\d{2}:\d{2}\] WARNING: Indexed state$/);

  const originalInfo = console.log;
  const infos = [];
  console.log = (message) => infos.push(message);
  try {
    createLogger({ log_level: "info" }).info("Worker started", {
      newFiles: 2,
    });
  } finally {
    console.log = originalInfo;
  }
  assert.match(
    infos[0],
    /^\[\d{2}:\d{2}:\d{2}\] INFO: Worker started newFiles=2$/,
  );
});

test("logger timestamp uses the Home Assistant TZ environment", () => {
  const previousTimezone = process.env.TZ;
  const instant = new Date("2026-11-25T21:56:38.000Z");

  try {
    process.env.TZ = "UTC";
    assert.equal(formatLogTimestamp(instant), "21:56:38");

    process.env.TZ = "America/Lima";
    assert.equal(formatLogTimestamp(instant), "16:56:38");
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("runtime logger messages are in English", () => {
  const appDirectory = path.join(process.cwd(), "app");
  const logSourceFiles = [
    path.join(appDirectory, "indexer.js"),
    path.join(appDirectory, "server.js"),
    path.join(appDirectory, "tls.js"),
  ];
  const spanishLoggerText =
    /Indexación|Escaneando|Buscando|completada|fallida|Indexando|No se pudo|actualizada|nueva indexada|Archivo eliminado|Carátulas pendientes|Carátula encontrada|Intento de carátula|No se encontró|reutilizando|certificado autofirmado|usando certificado|Fallo la|Error al procesar|Mensaje oculto|Mensaje visible|Estado indexado|Worker iniciado/i;

  for (const filePath of logSourceFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(source, spanishLoggerText, path.basename(filePath));
  }
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

test("states cannot be saved or loaded before EmulatorJS starts", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "app.js"),
    "utf8",
  );
  assert.match(source, /async function uploadSaveState[\s\S]*stateBeforeStart/);
  assert.match(
    source,
    /async function saveAutoStateForExit[\s\S]*stateBeforeStart/,
  );
  assert.match(source, /async function loadSaveState[\s\S]*stateBeforeStart/);
  assert.match(
    source,
    /async function applySaveStateToRunningInstance[\s\S]*supportsStates[\s\S]*stateLoadFailed/,
  );
  assert.match(source, /deleteLocalSave/);
});

test("web app manifest enables browser installation", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const index = fs.readFileSync(
    path.join(publicDirectory, "index.html"),
    "utf8",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(publicDirectory, "manifest.webmanifest"), "utf8"),
  );
  const sw = fs.readFileSync(path.join(publicDirectory, "sw.js"), "utf8");
  const icons = fs.readdirSync(path.join(publicDirectory, "icons"));

  assert.match(index, /rel="manifest"/);
  assert.match(index, /apple-mobile-web-app-capable/);
  assert.match(index, /apple-touch-icon/);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.ok(icons.includes("icon-192.png"));
  assert.ok(icons.includes("icon-512.png"));
  assert.match(sw, /manifest\.webmanifest/);
  assert.match(sw, /icons\/icon-192\.png/);
  assert.match(sw, /icons\/icon-512\.png/);
});

test("platform cards use transparent WebP logos", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const source = fs.readFileSync(path.join(publicDirectory, "app.js"), "utf8");
  const swSource = fs.readFileSync(path.join(publicDirectory, "sw.js"), "utf8");
  const logoDirectory = path.join(publicDirectory, "platforms");
  const logos = fs
    .readdirSync(logoDirectory)
    .filter((filename) => filename.endsWith(".webp"))
    .sort();

  assert.match(source, /function platformLogoUrl/);
  assert.match(source, /gb:\s*"gbc"/);
  assert.match(source, /platform-card-logo/);
  assert.doesNotMatch(source, /platform-card-logo[^]*\.png/);
  assert.deepEqual(logos, [
    "arcade.webp",
    "gba.webp",
    "gbc.webp",
    "n64.webp",
    "nes.webp",
    "snes.webp",
  ]);
  for (const logo of logos) {
    assert.match(swSource, new RegExp(`platforms/${logo.replace(".", "\\.")}`));
  }
});

test("library uses breadcrumb navigation and ordered sections", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const source = fs.readFileSync(path.join(publicDirectory, "app.js"), "utf8");
  const spanish = JSON.parse(
    fs.readFileSync(path.join(publicDirectory, "i18n", "es.json"), "utf8"),
  );
  const english = JSON.parse(
    fs.readFileSync(path.join(publicDirectory, "i18n", "en.json"), "utf8"),
  );

  assert.match(source, /id="back-profiles-library"/);
  assert.match(source, /breadcrumb-navigation/);
  assert.match(source, /id="back-library"/);
  assert.match(
    source,
    /<span class="breadcrumb-current">\$\{t\("library"\)\}<\/span>/,
  );
  const topbarEnd = source.indexOf('<main class="content">');
  const topbarSource = topbarEnd >= 0 ? source.slice(0, topbarEnd) : source;
  assert.doesNotMatch(topbarSource, /back-profiles-library/);
  assert.equal(spanish.profiles, "Perfiles");
  assert.equal(spanish.library, "Biblioteca");
  assert.equal(english.profiles, "Profiles");
  assert.equal(english.library, "Library");

  const continueIndex = source.indexOf('t("continuePlaying")');
  const platformsIndex = source.indexOf('t("platforms")');
  const recentIndex = source.indexOf('t("recentlyAdded")');
  assert.ok(continueIndex >= 0);
  assert.ok(platformsIndex > continueIndex);
  assert.ok(recentIndex > platformsIndex);
});

test("new profile form uses a random default color", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "app.js"),
    "utf8",
  );
  assert.match(source, /function randomProfileColor/);
  assert.match(source, /const defaultProfileColor = randomProfileColor\(\)/);
  assert.match(
    source,
    /\$\{t\("color"\)\}<input name="color" type="color" value="\$\{defaultProfileColor\}"/,
  );
});

test("profile editor edits name, color, and avatar", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const source = fs.readFileSync(path.join(publicDirectory, "app.js"), "utf8");

  assert.match(source, /id="edit-profile-name"/);
  assert.match(source, /id="edit-profile-color"/);
  assert.match(source, /form\.append\("name", editName\)/);
  assert.match(source, /form\.append\("color", editColor\)/);
  assert.match(source, /\$\{t\("edit"\)\}/);
  assert.match(source, /\$\{t\("save"\)\}/);
  assert.match(source, /profile-form-fields/);
  assert.match(source, /profile-avatar-fields/);
  assert.doesNotMatch(source, /\$\{t\("changeProfileImage"\)\}/);
  assert.doesNotMatch(source, /\$\{t\("saveAvatar"\)\}/);
});

test("profile color field is square and aligned", () => {
  const styles = fs.readFileSync(
    path.join(process.cwd(), "public", "styles.css"),
    "utf8",
  );
  assert.match(
    styles,
    /\.profile-form-fields\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*48px;/,
  );
  assert.match(
    styles,
    /\.profile-form-fields label:first-child input\s*\{[\s\S]*width:\s*100%/,
  );
  assert.match(
    styles,
    /\.profile-form-fields input\[type="color"\]\s*\{[\s\S]*width:\s*48px;[\s\S]*height:\s*48px;/,
  );
  assert.match(
    styles,
    /\.profile-form-fields input\[type="color"\]::-webkit-color-swatch\s*\{[\s\S]*border-radius:\s*8px;/,
  );
  assert.match(styles, /\.profile-form-actions\s*\{[\s\S]*margin-top:\s*1rem;/);
  assert.match(styles, /\.profile-edit-actions\s*\{[\s\S]*margin-top:\s*1rem;/);
});

test("emulator toolbar uses compact mobile actions", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const appSource = fs.readFileSync(
    path.join(publicDirectory, "app.js"),
    "utf8",
  );
  const stylesSource = fs.readFileSync(
    path.join(publicDirectory, "styles.css"),
    "utf8",
  );

  assert.match(appSource, /player-slot-control/);
  assert.match(appSource, /toolbar-action-icon/);
  assert.match(appSource, /toolbar-action-text/);
  assert.match(appSource, /function toolbarIcon/);
  assert.match(appSource, /toolbarIcon\("slot"\)/);
  assert.match(appSource, /toolbarIcon\("sync"\)/);
  assert.match(appSource, /toolbarIcon\("storage"\)/);
  assert.match(appSource, /toolbarIcon\("exit"\)/);
  assert.doesNotMatch(
    appSource.slice(appSource.indexOf('<main class="player-view">')),
    /🎞️|☁️|💾|🚪/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width:\s*640px\)[\s\S]*\.player-toolbar-action\s*\{[\s\S]*width:\s*40px;/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width:\s*640px\)[\s\S]*\.toolbar-action-text\s*\{[\s\S]*display:\s*none;/,
  );
});

test("topbar brand title is hidden on small screens", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const appSource = fs.readFileSync(
    path.join(publicDirectory, "app.js"),
    "utf8",
  );
  const stylesSource = fs.readFileSync(
    path.join(publicDirectory, "styles.css"),
    "utf8",
  );

  assert.match(appSource, /<strong class="brand-title">Retro Web<\/strong>/);
  assert.match(
    stylesSource,
    /@media \(max-width:\s*640px\)[\s\S]*\.brand-title\s*\{[\s\S]*display:\s*none;/,
  );
});

test("login view does not render an empty topbar", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const appSource = fs.readFileSync(
    path.join(publicDirectory, "app.js"),
    "utf8",
  );
  const stylesSource = fs.readFileSync(
    path.join(publicDirectory, "styles.css"),
    "utf8",
  );

  assert.match(appSource, /function renderLogin[\s\S]*state\.screen = "login"/);
  const renderLoginStart = appSource.indexOf("function renderLogin()");
  const renderProfilesStart = appSource.indexOf(
    "function renderProfiles()",
    renderLoginStart,
  );
  const loginSource =
    renderLoginStart >= 0 && renderProfilesStart >= 0
      ? appSource.slice(renderLoginStart, renderProfilesStart)
      : "";
  assert.doesNotMatch(
    loginSource,
    /function renderLogin[\s\S]*<header class="topbar">/,
  );
  assert.match(
    stylesSource,
    /\.app-shell:has\(\.login-card\)\s\.topbar\s*\{[\s\S]*display:\s*none;/,
  );
  assert.match(
    stylesSource,
    /\.app-shell:has\(\.login-card\)\s*\{[\s\S]*min-height:\s*100dvh;[\s\S]*display:\s*grid;[\s\S]*place-items:\s*center;/,
  );
  assert.match(
    stylesSource,
    /\.login-card\s*\{[\s\S]*width:\s*min\(440px,\s*100%\);[\s\S]*margin:\s*0;/,
  );
});

test("profile, game, and platform cards use Liquid Glass styling", () => {
  const styles = fs.readFileSync(
    path.join(process.cwd(), "public", "styles.css"),
    "utf8",
  );
  assert.match(
    styles,
    /circle at 10% 10%[\s\S]*circle at 90% 0%[\s\S]*#070912/,
  );
  assert.doesNotMatch(styles, /liquid-orb|rgba\(168, 85, 247/);
  assert.match(styles, /backdrop-filter:\s*blur\(24px\)\s*saturate\(180%\)/);
  assert.match(
    styles,
    /-webkit-backdrop-filter:\s*blur\(24px\)\s*saturate\(180%\)/,
  );
  assert.match(
    styles,
    /\.profile-card::before,[\s\S]*\.game-card::before,[\s\S]*\.platform-card::before/,
  );
  assert.match(styles, /transform:\s*scale\(0\.98\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("profile, game, and platform images block drag without disabling text selection", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const appSource = fs.readFileSync(
    path.join(publicDirectory, "app.js"),
    "utf8",
  );
  const stylesSource = fs.readFileSync(
    path.join(publicDirectory, "styles.css"),
    "utf8",
  );

  assert.match(
    stylesSource,
    /\.profile-card,\s*\.game-card,\s*\.platform-card\s*\{[\s\S]*-webkit-user-drag:\s*none;/,
  );
  assert.match(
    stylesSource,
    /\.profile-card,\s*\.game-card,\s*\.platform-card\s*\{[\s\S]*-webkit-tap-highlight-color:\s*transparent;/,
  );
  assert.match(
    stylesSource,
    /\.profile-card,\s*\.game-card,\s*\.platform-card\s*\{[\s\S]*touch-action:\s*manipulation;/,
  );
  assert.match(appSource, /draggable="false"/);
});

test("changing profile resets the selected library platform", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const source = fs.readFileSync(path.join(publicDirectory, "app.js"), "utf8");

  assert.match(
    source,
    /async function selectProfile[\s\S]*?rememberCurrentViewScroll\("profiles"\);\s*state\.libraryPlatform = null;/,
  );
});

test("profile images support system avatars and custom WebP uploads", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const appSource = fs.readFileSync(
    path.join(publicDirectory, "app.js"),
    "utf8",
  );
  const serverSource = fs.readFileSync(
    path.join(process.cwd(), "app", "server.js"),
    "utf8",
  );
  const storageSource = fs.readFileSync(
    path.join(process.cwd(), "app", "storage.js"),
    "utf8",
  );
  const swSource = fs.readFileSync(path.join(publicDirectory, "sw.js"), "utf8");
  const stylesSource = fs.readFileSync(
    path.join(publicDirectory, "styles.css"),
    "utf8",
  );

  assert.match(appSource, /profileAvatarMarkup/);
  assert.match(appSource, /\/api\/avatars\/\$\{avatar\}/);
  assert.match(appSource, /convertProfileAvatarToWebp/);
  assert.match(appSource, /canvas\.width = 345/);
  assert.match(appSource, /canvas\.height = 345/);
  assert.match(appSource, /"image\/webp"/);
  assert.match(serverSource, /avatarUpload\.single\("avatarFile"\)/);
  assert.match(serverSource, /isWebpBuffer/);
  assert.match(serverSource, /\/api\/profiles\/:profileId\/avatar/);
  assert.match(serverSource, /\/api\/admin\/avatars/);
  assert.match(serverSource, /avatars[\\/"',\]\s]+system/);
  assert.match(serverSource, /normalizeProfileAvatar[\s\S]*🎮/);
  assert.match(storageSource, /"avatars\/system"/);
  assert.match(storageSource, /"avatars\/custom"/);
  assert.match(
    stylesSource,
    /grid-template-columns:\s*repeat\(auto-fill,\s*88px\)/,
  );
  assert.match(
    stylesSource,
    /\.system-avatar-admin-card img\s*\{[\s\S]*width:\s*72px/,
  );
  assert.doesNotMatch(appSource, /public\/avatars|\.\/avatars\//);
  assert.doesNotMatch(swSource, /avatars\/avatar_/);
});

test("library navigation preserves scroll positions per view", () => {
  const publicDirectory = path.join(process.cwd(), "public");
  const source = fs.readFileSync(path.join(publicDirectory, "app.js"), "utf8");

  assert.match(source, /scrollPositions:\s*new Map\(\)/);
  assert.match(source, /function rememberCurrentViewScroll/);
  assert.match(source, /function restoreViewScroll/);
  assert.match(
    source,
    /rememberCurrentViewScroll\(\);\s*state\.libraryPlatform/,
  );
  assert.match(source, /rememberCurrentViewScroll\(\);\s*renderProfiles/);
  assert.match(source, /rememberCurrentViewScroll\(\);\s*if \(state\.screen/);
  assert.match(
    source,
    /window\.scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\)/,
  );
  assert.match(source, /restoreViewScroll\(\);/);
});
