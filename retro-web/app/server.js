import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import { loadConfig } from "./config.js";
import {
  downloadLibretroCover,
  imageExtension,
  searchLibretroCovers,
  validateCoverImage,
} from "./covers.js";
import { createDatabase, listGames, listProfiles } from "./database.js";
import { platforms, platformForUpload } from "./platforms.js";
import {
  atomicWrite,
  ensureStorage,
  safeFilename,
  savePath,
  secureCompare,
  sha256File,
} from "./storage.js";
import {
  createSession,
  deleteSession,
  getCookie,
  getSession,
  requireCsrf,
  selectProfile,
} from "./session.js";
import { normalizeTitle } from "./titles.js";
import { resolveTls } from "./tls.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const emulatorManifest = loadEmulatorManifest();

export function createRetroApp(config, db, mode) {
  const app = express();
  app.locals.db = db;
  app.locals.mode = mode;
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Emscripten core glue uses Function/cwrap during emulator startup.
          scriptSrc: ["'self'", "'unsafe-eval'", "blob:"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          workerSrc: ["'self'", "blob:"],
          connectSrc: ["'self'", "blob:"],
          mediaSrc: ["'self'", "blob:"],
          objectSrc: ["'none'"],
          frameAncestors: null,
        },
      },
      frameguard: false,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(
    express.raw({
      type: "application/octet-stream",
      limit: `${Math.max(256, Math.min(4096, config.max_upload_mb))}mb`,
    }),
  );

  const upload = multer({
    dest: path.join(config.dataPath, "temp"),
    limits: { fileSize: config.max_upload_mb * 1024 * 1024 },
  });
  const uploadSessions = new Map();
  const uploadCleanupTimer = setInterval(
    () => {
      for (const [uploadId, session] of uploadSessions) {
        if (Date.now() - session.createdAt > 60 * 60 * 1000) {
          cleanupChunkedSession(uploadSessions, uploadId);
        }
      }
    },
    10 * 60 * 1000,
  );
  uploadCleanupTimer.unref();

  app.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  if (mode === "external") {
    app.use("/api", requireExternalSession(config, db));
  }

  app.get("/api/bootstrap", (request, response) => {
    const profiles = listProfiles(db);
    if (mode === "external") {
      response.json({
        external: true,
        authenticated: Boolean(request.session),
        externalAdminEnabled: config.allow_external_rom_upload,
        csrf: request.session?.csrf_token || null,
        profileId: request.session?.profile_id || null,
        profiles: request.session ? profiles : [],
      });
      return;
    }
    response.json({
      external: false,
      authenticated: true,
      externalAdminEnabled: false,
      profileId: getCookie(request, "retro_web_profile"),
      profiles,
    });
  });

  if (mode === "external") {
    const attempts = new Map();
    app.post("/api/login", (request, response) => {
      const key = request.ip;
      const window = attempts.get(key) || [];
      const recent = window.filter((at) => at > Date.now() - 60_000);
      if (recent.length >= 10) {
        response.status(429).json({ error: "Too many login attempts" });
        return;
      }
      recent.push(Date.now());
      attempts.set(key, recent);

      const username = String(request.body?.username || "");
      const password = String(request.body?.password || "");
      if (
        !secureCompare(username, config.external_username) ||
        !secureCompare(password, config.external_password)
      ) {
        response.status(401).json({ error: "Invalid credentials" });
        return;
      }

      const session = createSession(db, config.session_timeout_hours);
      response.cookie(session.cookieName, session.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: request.get("x-forwarded-proto") === "https",
        maxAge: session.expiresAt - Date.now(),
      });
      response.json({ csrf: session.csrfToken });
    });

    app.post("/api/logout", requireExternalCsrf, (request, response) => {
      deleteSession(db, request);
      response.clearCookie("retro_web_session");
      response.status(204).end();
    });

    app.post(
      "/api/external-admin/login",
      requireExternalCsrf,
      (request, response) => {
        if (
          !config.allow_external_rom_upload ||
          !secureCompare(
            request.body?.password || "",
            config.external_admin_password,
          )
        ) {
          response
            .status(403)
            .json({ error: "Invalid external admin password" });
          return;
        }
        db.prepare(
          "UPDATE sessions SET is_external_admin = 1 WHERE token_hash = ?",
        ).run(request.session.token_hash);
        response.status(204).end();
      },
    );
  }

  app.get("/api/profiles", (request, response) => {
    if (mode === "external" && !request.session) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }
    response.json(listProfiles(db));
  });

  app.post("/api/profiles/select", (request, response) => {
    const profileId = String(request.body?.profileId || "");
    const profile = db
      .prepare("SELECT id FROM profiles WHERE id = ?")
      .get(profileId);
    if (!profile) {
      response.status(404).json({ error: "Profile not found" });
      return;
    }
    if (mode === "external") {
      if (!request.session || !requireCsrf(request, request.session)) {
        response.status(403).json({ error: "Invalid request token" });
        return;
      }
      selectProfile(db, request.session, profileId);
    } else {
      response.cookie("retro_web_profile", profileId, {
        httpOnly: true,
        sameSite: "lax",
        secure: request.get("x-forwarded-proto") === "https",
      });
    }
    response.json({ profileId });
  });

  app.patch("/api/profiles/:profileId", (request, response) => {
    const profileId = activeProfileId(request, response, db, mode);
    if (!profileId || profileId !== request.params.profileId) {
      return;
    }
    if (mode === "external" && !requireCsrf(request, request.session)) {
      response.status(403).json({ error: "Invalid request token" });
      return;
    }
    const language = String(request.body?.language || "");
    if (!["es", "en"].includes(language)) {
      response.status(400).json({ error: "Unsupported language" });
      return;
    }
    db.prepare("UPDATE profiles SET language = ? WHERE id = ?").run(
      language,
      profileId,
    );
    response.status(204).end();
  });

  app.get("/api/games", (request, response) => {
    const profileId = activeProfileId(request, response, db, mode);
    if (!profileId) return;
    response.json(
      listGames(db, profileId).map((game) => ({
        ...game,
        emulatorVersion: emulatorManifest.emulatorVersion,
        coreBuildId: emulatorManifest.cores?.[game.core]?.buildId || null,
        biosUrl: game.bios_system
          ? biosUrlForGame(config.dataPath, game)
          : null,
        biosHash: game.bios_system
          ? readBiosManifest(config.dataPath, game.bios_system)?.hash || null
          : null,
      })),
    );
  });

  app.get("/api/games/:gameId", (request, response) => {
    if (!activeProfileId(request, response, db, mode)) return;
    const game = getGame(db, request.params.gameId);
    if (!game) {
      response.status(404).json({ error: "Game not found" });
      return;
    }
    response.json({
      id: game.id,
      title: game.title,
      platform: game.platform,
      core: game.core,
      hasCover: Boolean(game.cover_path),
      hash: game.hash,
      size: game.size,
      romFilename: game.rom_filename || null,
      emulatorVersion: emulatorManifest.emulatorVersion,
      coreBuildId: emulatorManifest.cores?.[game.core]?.buildId || null,
      biosHash: game.bios_system
        ? readBiosManifest(config.dataPath, game.bios_system)?.hash || null
        : null,
      biosUrl: game.bios_system ? biosUrlForGame(config.dataPath, game) : null,
    });
  });

  app.get("/api/games/:gameId/cover", (request, response) => {
    if (!activeProfileId(request, response, db, mode)) return;
    const game = getGame(db, request.params.gameId);
    if (!game?.cover_path || !fs.existsSync(game.cover_path)) {
      response.status(404).json({ error: "Cover not found" });
      return;
    }
    response.set("Content-Type", game.cover_mime || "image/png");
    response.sendFile(game.cover_path);
  });

  app.get("/api/games/:gameId/rom", (request, response) => {
    if (!activeProfileId(request, response, db, mode)) return;
    const game = getGame(db, request.params.gameId);
    if (!game || !fs.existsSync(game.rom_path)) {
      response.status(404).json({ error: "ROM not found" });
      return;
    }
    response.set("Content-Type", "application/octet-stream");
    response.sendFile(game.rom_path);
  });

  app.get("/api/games/:gameId/bios/:filename", (request, response) => {
    if (!activeProfileId(request, response, db, mode)) return;
    const game = getGame(db, request.params.gameId);
    const manifest = game?.bios_system
      ? readBiosManifest(config.dataPath, game.bios_system)
      : null;
    if (
      !manifest ||
      request.params.filename !== manifest.filename ||
      !manifest.filename
    ) {
      response.status(404).json({ error: "BIOS not available" });
      return;
    }
    const biosPath = path.join(
      config.dataPath,
      "bios",
      game.bios_system,
      manifest.filename,
    );
    if (!fs.existsSync(biosPath)) {
      response.status(404).json({ error: "BIOS file not found" });
      return;
    }
    response.set("Content-Type", "application/octet-stream");
    response.sendFile(biosPath);
  });

  app.get("/api/games/:gameId/saves/:kind/:slot", (request, response) => {
    const profileId = activeProfileId(request, response, db, mode);
    if (!profileId) return;
    const save = getSave(
      db,
      profileId,
      request.params.gameId,
      request.params.kind,
      Number(request.params.slot),
    );
    if (!save || !fs.existsSync(save.file_path)) {
      response.status(404).json({ error: "Save not found" });
      return;
    }
    if (request.params.kind === "state") {
      const expectedCore = request.get("x-retro-core");
      const expectedVersion = request.get("x-retro-emulator-version");
      const expectedRomHash = request.get("x-retro-rom-hash");
      if (
        !save.emulator_version ||
        !save.core_version ||
        !save.rom_hash ||
        save.core_version !== expectedCore ||
        save.emulator_version !== expectedVersion ||
        save.rom_hash !== expectedRomHash
      ) {
        response.status(409).json({
          error:
            "This save state belongs to another emulator, core, or ROM version. Create a new state in the current slot.",
        });
        return;
      }
      if (save.save_hash !== sha256File(save.file_path)) {
        response.status(422).json({
          error: "The save state is corrupted and cannot be restored safely.",
        });
        return;
      }
    }
    response.set("Content-Type", "application/octet-stream");
    response.sendFile(save.file_path);
  });

  app.put("/api/games/:gameId/saves/:kind/:slot", (request, response) => {
    const profileId = activeProfileId(request, response, db, mode);
    if (!profileId) return;
    if (mode === "external" && !requireCsrf(request, request.session)) {
      response.status(403).json({ error: "Invalid request token" });
      return;
    }
    const kind = request.params.kind;
    const slot = Number(request.params.slot);
    if (!["state", "save"].includes(kind) || slot < 1 || slot > 9) {
      response.status(400).json({ error: "Invalid save target" });
      return;
    }
    const game = getGame(db, request.params.gameId);
    if (!game) {
      response.status(404).json({ error: "Game not found" });
      return;
    }
    const data = request.body;
    if (!Buffer.isBuffer(data) || data.length === 0) {
      response.status(400).json({ error: "Save data is required" });
      return;
    }
    if (
      kind === "state" &&
      (!request.get("x-retro-emulator-version") ||
        !request.get("x-retro-core") ||
        !request.get("x-retro-rom-hash"))
    ) {
      response.status(400).json({
        error: "Save state compatibility metadata is required",
      });
      return;
    }
    if (kind === "state" && request.get("x-retro-core") !== game.core) {
      response
        .status(409)
        .json({ error: "Save state core does not match game" });
      return;
    }
    if (kind === "state" && request.get("x-retro-rom-hash") !== game.hash) {
      response
        .status(409)
        .json({ error: "Save state ROM does not match game" });
      return;
    }
    const previous = getSave(db, profileId, game.id, kind, slot);
    const expectedHash = request.get("if-match-save-hash");
    const previousHash =
      previous?.save_hash ||
      (previous?.file_path && fs.existsSync(previous.file_path)
        ? sha256File(previous.file_path)
        : null);
    if (
      expectedHash &&
      expectedHash !== "none" &&
      (!previous || previousHash !== expectedHash)
    ) {
      response.status(412).json({
        error: "The server save changed. Refresh and resolve the conflict.",
      });
      return;
    }
    if (expectedHash === "none" && previous) {
      response.status(412).json({
        error: "A server save now exists. Refresh and resolve the conflict.",
      });
      return;
    }
    const targetPath = savePath(
      config.dataPath,
      profileId,
      game.id,
      kind,
      slot,
    );
    if (fs.existsSync(targetPath)) {
      fs.copyFileSync(targetPath, `${targetPath}.previous`);
    }
    atomicWrite(targetPath, data);
    const saveHash = sha256File(targetPath);
    db.prepare(
      `INSERT INTO saves (
         profile_id, game_id, core, kind, slot, file_path,
         emulator_version, core_version, rom_hash, save_hash, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, game_id, core, kind, slot)
       DO UPDATE SET
         file_path=excluded.file_path,
         emulator_version=excluded.emulator_version,
         core_version=excluded.core_version,
         rom_hash=excluded.rom_hash,
         save_hash=excluded.save_hash,
         updated_at=excluded.updated_at`,
    ).run(
      profileId,
      game.id,
      game.core,
      kind,
      slot,
      targetPath,
      kind === "state"
        ? String(request.get("x-retro-emulator-version") || "")
        : null,
      kind === "state" ? game.core : null,
      kind === "state" ? game.hash : null,
      saveHash,
      new Date().toISOString(),
    );
    markPlayed(db, profileId, game.id);
    response.status(204).end();
  });

  app.get("/api/games/:gameId/saves/:kind/:slot/meta", (request, response) => {
    const profileId = activeProfileId(request, response, db, mode);
    if (!profileId) return;
    const save = getSave(
      db,
      profileId,
      request.params.gameId,
      request.params.kind,
      Number(request.params.slot),
    );
    if (!save || !fs.existsSync(save.file_path)) {
      response.status(404).json({ error: "Save not found" });
      return;
    }
    const hash = save.save_hash || sha256File(save.file_path);
    response.set("ETag", `"${hash}"`);
    response.json({
      hash,
      size: fs.statSync(save.file_path).size,
      updatedAt: save.updated_at,
      core: save.core,
      emulatorVersion: save.emulator_version,
      romHash: save.rom_hash,
      kind: save.kind,
      slot: save.slot,
    });
  });

  app.get(
    "/api/games/:gameId/saves/:kind/:slot/chunk/:index",
    (request, response) => {
      const profileId = activeProfileId(request, response, db, mode);
      if (!profileId) return;
      const save = getSave(
        db,
        profileId,
        request.params.gameId,
        request.params.kind,
        Number(request.params.slot),
      );
      if (!save || !fs.existsSync(save.file_path)) {
        response.status(404).json({ error: "Save not found" });
        return;
      }
      const chunkSize = 1024 * 1024;
      const index = Number(request.params.index);
      const size = fs.statSync(save.file_path).size;
      const totalChunks = Math.ceil(size / chunkSize);
      if (!Number.isInteger(index) || index < 0 || index >= totalChunks) {
        response.status(416).json({ error: "Invalid save chunk index" });
        return;
      }
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, size);
      response.set("Content-Type", "application/octet-stream");
      response.set("X-Save-Total-Chunks", String(totalChunks));
      response.set("X-Save-Total-Size", String(size));
      response.send(fs.readFileSync(save.file_path).subarray(start, end));
    },
  );

  app.post(
    "/api/games/:gameId/saves/:kind/:slot/chunked/start",
    (request, response) => {
      if (
        mode === "external" &&
        !requireCsrf(request, getSession(db, request))
      ) {
        response.status(403).json({ error: "Invalid request token" });
        return;
      }
      const session = validateChunkedSaveRequest(request, response, config);
      if (!session) return;
      const uploadId = crypto.randomUUID();
      const directory = path.join(
        config.dataPath,
        "temp",
        "save-uploads",
        uploadId,
      );
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      uploadSessions.set(uploadId, {
        ...session,
        directory,
        chunks: 0,
        createdAt: Date.now(),
      });
      response.status(201).json({ uploadId });
    },
  );

  app.put(
    "/api/games/:gameId/saves/:kind/:slot/chunked/:uploadId/:index",
    (request, response) => {
      const session = uploadSessions.get(request.params.uploadId);
      if (
        mode === "external" &&
        !requireCsrf(request, getSession(db, request))
      ) {
        response.status(403).json({ error: "Invalid request token" });
        return;
      }
      const profileId = activeProfileId(request, response, db, mode);
      if (
        !session ||
        session.profileId !== profileId ||
        session.gameId !== request.params.gameId
      ) {
        if (!response.headersSent) {
          response.status(404).json({ error: "Chunked save not found" });
        }
        return;
      }
      const index = Number(request.params.index);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= session.totalChunks ||
        !Buffer.isBuffer(request.body) ||
        request.body.length === 0 ||
        request.body.length > 1024 * 1024
      ) {
        response.status(400).json({ error: "Invalid save chunk" });
        return;
      }
      atomicWrite(
        path.join(session.directory, String(index).padStart(6, "0")),
        request.body,
      );
      session.chunks += 1;
      response.status(204).end();
    },
  );

  app.post(
    "/api/games/:gameId/saves/:kind/:slot/chunked/:uploadId/finish",
    (request, response) => {
      const session = uploadSessions.get(request.params.uploadId);
      if (
        mode === "external" &&
        !requireCsrf(request, getSession(db, request))
      ) {
        response.status(403).json({ error: "Invalid request token" });
        return;
      }
      const profileId = activeProfileId(request, response, db, mode);
      if (
        !session ||
        session.profileId !== profileId ||
        session.gameId !== request.params.gameId
      ) {
        if (!response.headersSent) {
          response.status(404).json({ error: "Chunked save not found" });
        }
        return;
      }
      const chunks = Array.from({ length: session.totalChunks }, (_, index) =>
        path.join(session.directory, String(index).padStart(6, "0")),
      );
      if (chunks.some((chunk) => !fs.existsSync(chunk))) {
        response
          .status(409)
          .json({ error: "One or more save chunks are missing" });
        return;
      }
      const assembledPath = path.join(session.directory, "assembled.bin");
      const output = fs.openSync(assembledPath, "w", 0o600);
      try {
        for (const chunk of chunks)
          fs.writeSync(output, fs.readFileSync(chunk));
      } finally {
        fs.closeSync(output);
      }
      if (
        fs.statSync(assembledPath).size !== session.totalSize ||
        sha256File(assembledPath) !== session.expectedHash
      ) {
        cleanupChunkedSession(uploadSessions, request.params.uploadId);
        response
          .status(422)
          .json({ error: "Assembled save hash or size is invalid" });
        return;
      }
      try {
        commitSaveUpload(
          db,
          session,
          fs.readFileSync(assembledPath),
          config.dataPath,
        );
      } catch (error) {
        if (error.status) {
          response.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
      cleanupChunkedSession(uploadSessions, request.params.uploadId);
      response.status(204).end();
    },
  );

  if (mode === "ingress") {
    mountAdminRoutes(app, config, db, upload);
  } else if (config.allow_external_rom_upload) {
    app.use("/api/admin", requireExternalAdmin(config, db));
    mountAdminRoutes(app, config, db, upload);
  }

  if (mode === "external" && !config.allow_external_rom_upload) {
    app.use("/api/admin", (_request, response) => {
      response.status(404).json({ error: "Not found" });
    });
  }

  app.use(
    "/vendor/emulatorjs",
    express.static(path.join(publicRoot, "vendor", "emulatorjs"), {
      maxAge: "7d",
      immutable: true,
    }),
  );
  app.use(express.static(publicRoot, { extensions: ["html"] }));
  app.get("*path", (_request, response) => {
    response.sendFile(path.join(publicRoot, "index.html"));
  });
  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "Retro Web request failed" });
  });

  return app;
}

function mountAdminRoutes(app, config, db, upload) {
  app.get("/api/admin/platforms", (_request, response) => {
    const result = Object.entries(platforms).map(([id, platform]) => ({
      id,
      label: platform.label,
      core: platform.core,
      extensions: platform.extensions,
      disabled: id === "arcade" && !config.enable_arcade,
    }));
    response.json(result);
  });

  app.post("/api/admin/profiles", (request, response) => {
    const profiles = listProfiles(db);
    if (profiles.length >= config.profile_limit) {
      response.status(409).json({ error: "Profile limit reached" });
      return;
    }
    const name = String(request.body?.name || "").trim();
    const avatar = String(request.body?.avatar || "🎮").slice(0, 12);
    const color = /^#[0-9a-f]{6}$/i.test(request.body?.color)
      ? request.body.color
      : "#5b8def";
    if (!name || name.length > 40) {
      response.status(400).json({ error: "Invalid profile name" });
      return;
    }
    const profile = {
      id: crypto.randomUUID(),
      name,
      avatar,
      color,
      language: ["es", "en"].includes(request.body?.language)
        ? request.body.language
        : "es",
    };
    db.prepare(
      "INSERT INTO profiles (id, name, avatar, color, language, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      profile.id,
      profile.name,
      profile.avatar,
      profile.color,
      profile.language,
      new Date().toISOString(),
    );
    response.status(201).json(profile);
  });

  app.post(
    "/api/admin/upload/rom",
    upload.single("file"),
    (request, response) => {
      if (!request.file) {
        response.status(400).json({ error: "ROM file is required" });
        return;
      }
      const title = normalizeTitle(
        request.body?.title,
        request.file.originalname,
      );
      const platformId = String(request.body?.platform || "");
      const extension = path.extname(request.file.originalname).toLowerCase();
      let platform;
      try {
        platform = platformForUpload(
          platformId,
          extension,
          config.enable_arcade,
        );
      } catch (error) {
        fs.rmSync(request.file.path, { force: true });
        response.status(400).json({ error: error.message });
        return;
      }
      const hash = sha256File(request.file.path);
      const existing = db
        .prepare("SELECT id FROM games WHERE hash = ?")
        .get(hash);
      if (existing) {
        fs.rmSync(request.file.path, { force: true });
        response
          .status(409)
          .json({ error: "This ROM is already in the library" });
        return;
      }
      const gameId = crypto.randomUUID();
      const targetDirectory = path.join(config.dataPath, "roms", platformId);
      fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
      const targetPath = path.join(targetDirectory, `${hash}${extension}`);
      fs.renameSync(request.file.path, targetPath);
      const game = {
        id: gameId,
        title,
        platform: platformId,
        core: platform.core,
        extension,
        romPath: targetPath,
        romFilename: request.file.originalname,
        biosSystem: platformId === "arcade" ? platformId : null,
        size: request.file.size,
        hash,
      };
      db.prepare(
        `INSERT INTO games
           (id, title, platform, core, extension, rom_path, rom_filename, bios_system, size, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        game.id,
        game.title,
        game.platform,
        game.core,
        game.extension,
        game.romPath,
        game.romFilename,
        game.biosSystem,
        game.size,
        game.hash,
        new Date().toISOString(),
      );
      response.status(201).json({
        ...game,
        romPath: undefined,
      });
    },
  );

  app.post(
    "/api/admin/upload/bios",
    upload.single("file"),
    (request, response) => {
      if (!request.file) {
        response.status(400).json({ error: "BIOS file is required" });
        return;
      }
      const system = String(request.body?.system || "");
      if (!["n64", "arcade"].includes(system)) {
        fs.rmSync(request.file.path, { force: true });
        response.status(400).json({ error: "Unsupported BIOS system" });
        return;
      }
      const directory = path.join(config.dataPath, "bios", system);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const manifestPath = path.join(directory, "manifest.json");
      const previousManifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        : null;
      if (
        previousManifest?.filename &&
        fs.existsSync(path.join(directory, previousManifest.filename))
      ) {
        fs.copyFileSync(
          path.join(directory, previousManifest.filename),
          path.join(directory, `${previousManifest.filename}.previous`),
        );
      }
      const filename = safeFilename(request.file.originalname);
      const targetPath = path.join(directory, filename);
      fs.renameSync(request.file.path, targetPath);
      atomicWrite(
        manifestPath,
        Buffer.from(
          JSON.stringify({
            filename,
            hash: sha256File(targetPath),
            size: request.file.size,
            updatedAt: new Date().toISOString(),
          }),
        ),
      );
      response.status(204).end();
    },
  );

  const coverUpload = upload.single("file");

  app.put(
    "/api/admin/games/:gameId/cover",
    coverUpload,
    (request, response) => {
      const game = getGame(db, request.params.gameId);
      if (!game) {
        if (request.file) fs.rmSync(request.file.path, { force: true });
        response.status(404).json({ error: "Game not found" });
        return;
      }
      if (!request.file) {
        response.status(400).json({ error: "Cover file is required" });
        return;
      }
      const buffer = fs.readFileSync(request.file.path);
      if (buffer.length > 8 * 1024 * 1024) {
        fs.rmSync(request.file.path, { force: true });
        response.status(413).json({ error: "Cover is too large" });
        return;
      }
      let mime;
      try {
        mime = validateCoverImage(buffer).mime;
      } catch (error) {
        fs.rmSync(request.file.path, { force: true });
        response.status(400).json({ error: error.message });
        return;
      }
      storeCover(
        config,
        db,
        game,
        buffer,
        mime,
        "manual",
        safeFilename(request.file.originalname),
      );
      fs.rmSync(request.file.path, { force: true });
      response.status(204).end();
    },
  );

  app.delete("/api/admin/games/:gameId/cover", (request, response) => {
    const game = getGame(db, request.params.gameId);
    if (!game) {
      response.status(404).json({ error: "Game not found" });
      return;
    }
    if (game.cover_path) fs.rmSync(game.cover_path, { force: true });
    db.prepare(
      `UPDATE games
       SET cover_path = NULL, cover_mime = NULL, cover_source = NULL,
           cover_source_name = NULL, cover_updated_at = NULL
       WHERE id = ?`,
    ).run(game.id);
    response.status(204).end();
  });

  app.get("/api/admin/covers/search", async (request, response) => {
    try {
      const results = await searchLibretroCovers(
        String(request.query.platform || ""),
        String(request.query.q || ""),
      );
      response.json(results);
    } catch (error) {
      response.status(502).json({ error: error.message });
    }
  });

  app.get("/api/admin/covers/preview", async (request, response) => {
    try {
      const buffer = await downloadLibretroCover(
        String(request.query.platform || ""),
        String(request.query.name || ""),
      );
      response.set("Content-Type", "image/png");
      response.send(buffer);
    } catch (error) {
      response.status(502).json({ error: error.message });
    }
  });

  app.post(
    "/api/admin/games/:gameId/cover/from-libretro",
    async (request, response) => {
      const game = getGame(db, request.params.gameId);
      if (!game) {
        response.status(404).json({ error: "Game not found" });
        return;
      }
      try {
        const sourceName = String(request.body?.name || "");
        const buffer = await downloadLibretroCover(game.platform, sourceName);
        storeCover(
          config,
          db,
          game,
          buffer,
          "image/png",
          "libretro",
          sourceName,
        );
        response.status(204).end();
      } catch (error) {
        response.status(502).json({ error: error.message });
      }
    },
  );

  app.get("/api/admin/storage", (_request, response) => {
    const stats = db
      .prepare(
        `SELECT
           (SELECT count(*) FROM games) AS games,
           (SELECT count(*) FROM profiles) AS profiles,
           (SELECT count(*) FROM saves) AS saves,
           COALESCE((SELECT sum(size) FROM games), 0) AS romBytes`,
      )
      .get();
    response.json(stats);
  });
}

function requireExternalSession(config, db) {
  return (request, response, next) => {
    if (request.path === "/login" && request.method === "POST") {
      next();
      return;
    }
    if (request.path === "/bootstrap" && request.method === "GET") {
      request.session = getSession(db, request);
      next();
      return;
    }
    request.session = getSession(db, request);
    if (!request.session) {
      if (!config.external_access) {
        response.status(404).end();
        return;
      }
      response.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  };
}

function requireExternalAdmin(config, db) {
  return (request, response, next) => {
    const session = getSession(db, request);
    if (
      !session ||
      !session.is_external_admin ||
      (request.method !== "GET" && !requireCsrf(request, session))
    ) {
      response.status(403).json({ error: "External admin session required" });
      return;
    }
    request.session = session;
    next();
  };
}

function requireExternalCsrf(request, response, next) {
  if (!request.session || !requireCsrf(request, request.session)) {
    response.status(403).json({ error: "Invalid request token" });
    return;
  }
  next();
}

function activeProfileId(request, response, db, mode) {
  let profileId;
  if (mode === "external") {
    profileId = request.session?.profile_id;
  } else {
    profileId =
      request.get("x-profile-id") || getCookie(request, "retro_web_profile");
  }
  if (
    !profileId ||
    !db.prepare("SELECT id FROM profiles WHERE id = ?").get(profileId)
  ) {
    response.status(400).json({ error: "Select a profile first" });
    return null;
  }
  return profileId;
}

function getGame(db, gameId) {
  return db.prepare("SELECT * FROM games WHERE id = ?").get(gameId);
}

function storeCover(config, db, game, buffer, mime, source, sourceName) {
  const coversDirectory = path.join(config.dataPath, "covers");
  fs.mkdirSync(coversDirectory, { recursive: true, mode: 0o700 });
  const targetPath = path.join(
    coversDirectory,
    `${game.id}${imageExtension(mime)}`,
  );
  if (game.cover_path && game.cover_path !== targetPath) {
    fs.rmSync(game.cover_path, { force: true });
  }
  atomicWrite(targetPath, buffer);
  db.prepare(
    `UPDATE games
     SET cover_path = ?, cover_mime = ?, cover_source = ?,
         cover_source_name = ?, cover_updated_at = ?
     WHERE id = ?`,
  ).run(
    targetPath,
    mime,
    source,
    sourceName,
    new Date().toISOString(),
    game.id,
  );
}

function readBiosManifest(dataPath, system) {
  const manifestPath = path.join(dataPath, "bios", system, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function biosUrlForGame(dataPath, game) {
  const manifest = readBiosManifest(dataPath, game.bios_system);
  if (!manifest?.filename) return null;
  return `./api/games/${game.id}/bios/${encodeURIComponent(manifest.filename)}`;
}

function getSave(db, profileId, gameId, kind, slot) {
  return db
    .prepare(
      "SELECT * FROM saves WHERE profile_id = ? AND game_id = ? AND kind = ? AND slot = ?",
    )
    .get(profileId, gameId, kind, slot);
}

function markPlayed(db, profileId, gameId) {
  db.prepare(
    `INSERT INTO progress (profile_id, game_id, favorite, last_played)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(profile_id, game_id) DO UPDATE SET last_played=excluded.last_played`,
  ).run(profileId, gameId, new Date().toISOString());
}

function validateChunkedSaveRequest(request, response, config) {
  const profileId = activeProfileId(
    request,
    response,
    request.app.locals.db,
    request.app.locals.mode,
  );
  if (!profileId) return null;
  const gameId = request.params.gameId;
  const kind = request.params.kind;
  const slot = Number(request.params.slot);
  const totalSize = Number(request.body?.totalSize);
  const totalChunks = Number(request.body?.totalChunks);
  const expectedHash = String(request.body?.hash || "");
  const ifMatch = String(request.body?.ifMatchSaveHash || "");
  if (
    !["state", "save"].includes(kind) ||
    slot < 1 ||
    slot > 9 ||
    !Number.isInteger(totalChunks) ||
    totalChunks < 1 ||
    totalChunks > 16384 ||
    !Number.isInteger(totalSize) ||
    totalSize < 1 ||
    totalSize > config.max_upload_mb * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(expectedHash)
  ) {
    response.status(400).json({ error: "Invalid chunked save request" });
    return null;
  }
  const game = getGame(request.app.locals.db, gameId);
  if (!game) {
    response.status(404).json({ error: "Game not found" });
    return null;
  }
  return {
    profileId,
    gameId,
    kind,
    slot,
    totalSize,
    totalChunks,
    expectedHash,
    ifMatchSaveHash: ifMatch,
    emulatorVersion: String(request.body?.emulatorVersion || ""),
    core: String(request.body?.core || ""),
    romHash: String(request.body?.romHash || ""),
    game,
  };
}

function commitSaveUpload(db, session, data, dataPath) {
  const previous = getSave(
    db,
    session.profileId,
    session.gameId,
    session.kind,
    session.slot,
  );
  const previousHash =
    previous?.save_hash ||
    (previous?.file_path && fs.existsSync(previous.file_path)
      ? sha256File(previous.file_path)
      : null);
  if (
    session.ifMatchSaveHash &&
    session.ifMatchSaveHash !== "none" &&
    previousHash !== session.ifMatchSaveHash
  ) {
    const error = new Error(
      "The server save changed. Refresh and resolve the conflict.",
    );
    error.status = 412;
    throw error;
  }
  if (session.ifMatchSaveHash === "none" && previous) {
    const error = new Error(
      "A server save now exists. Refresh and resolve the conflict.",
    );
    error.status = 412;
    throw error;
  }
  if (
    session.kind === "state" &&
    (session.core !== session.game.core ||
      session.romHash !== session.game.hash ||
      !session.emulatorVersion)
  ) {
    const error = new Error("Save state compatibility metadata is invalid");
    error.status = 409;
    throw error;
  }
  const targetPath = savePath(
    dataPath,
    session.profileId,
    session.gameId,
    session.kind,
    session.slot,
  );
  if (fs.existsSync(targetPath)) {
    fs.copyFileSync(targetPath, `${targetPath}.previous`);
  }
  atomicWrite(targetPath, data);
  db.prepare(
    `INSERT INTO saves (
       profile_id, game_id, core, kind, slot, file_path,
       emulator_version, core_version, rom_hash, save_hash, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, game_id, core, kind, slot)
     DO UPDATE SET
       file_path=excluded.file_path,
       emulator_version=excluded.emulator_version,
       core_version=excluded.core_version,
       rom_hash=excluded.rom_hash,
       save_hash=excluded.save_hash,
       updated_at=excluded.updated_at`,
  ).run(
    session.profileId,
    session.gameId,
    session.game.core,
    session.kind,
    session.slot,
    targetPath,
    session.kind === "state" ? session.emulatorVersion : null,
    session.kind === "state" ? session.core : null,
    session.kind === "state" ? session.romHash : null,
    session.expectedHash,
    new Date().toISOString(),
  );
  markPlayed(db, session.profileId, session.gameId);
}

function cleanupChunkedSession(sessions, uploadId) {
  const session = sessions.get(uploadId);
  if (session) fs.rmSync(session.directory, { recursive: true, force: true });
  sessions.delete(uploadId);
}

function loadEmulatorManifest() {
  const manifestPath = path.join(
    publicRoot,
    "vendor",
    "emulatorjs",
    "manifest.json",
  );
  if (!fs.existsSync(manifestPath)) {
    return { emulatorVersion: "4.2.3", cores: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { emulatorVersion: "4.2.3", cores: {} };
  }
}

export function start() {
  const config = loadConfig();
  ensureStorage(config.dataPath);
  const db = createDatabase(config.dataPath);
  const ingressApp = createRetroApp(config, db, "ingress");
  const ingressServer = ingressApp.listen(config.internalPort, "0.0.0.0");
  let externalServer;
  if (config.external_access) {
    const externalApp = createRetroApp(config, db, "external");
    const tls = resolveTls(config);
    externalServer = tls
      ? https
          .createServer(tls, externalApp)
          .listen(config.externalPort, "0.0.0.0")
      : externalApp.listen(config.externalPort, "0.0.0.0");
  }

  const shutdown = () => {
    ingressServer.close();
    externalServer?.close();
    db.close();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(
    `Retro Web listening on ingress port ${config.internalPort}${
      externalServer ? ` and external port ${config.externalPort}` : ""
    }`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start();
}
