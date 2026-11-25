import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { platforms } from "./platforms.js";
import { titleFromFilename } from "./titles.js";
import {
  downloadLibretroCover,
  imageExtension,
  validateCoverImage,
} from "./covers.js";
import { createLogger } from "./logger.js";

const crcTable = createCrcTable();

const datUrls = {
  nes: "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/Nintendo - Nintendo Entertainment System.dat",
  snes: "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/Nintendo - Super Nintendo Entertainment System.dat",
  gb: "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/Nintendo - Game Boy.dat",
  gba: "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/Nintendo - Game Boy Advance.dat",
  n64: "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/Nintendo - Nintendo 64.dat",
  arcade:
    "https://raw.githubusercontent.com/libretro/libretro-database/master/dat/FBNeo - Arcade Games.dat",
};

export function createIndexWorker({ config, db }) {
  let running = null;
  let status = readLatestRun(db);
  const logger = createLogger(config);

  return {
    getStatus,
    runNow,
  };

  function getStatus() {
    return {
      running: Boolean(running),
      lastRun: status,
    };
  }

  async function runNow() {
    if (running) {
      logger.warning("Indexing is already running");
      const error = new Error("Indexing is already running");
      error.status = 409;
      throw error;
    }
    running = indexFiles();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  async function indexFiles() {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    logger.info("ROM and BIOS indexing started");
    const run = db
      .prepare(
        `INSERT INTO index_runs
         (started_at,status,new_files,changed_files,deleted_files,error_files)
         VALUES (?, 'running',0,0,0,0)`,
      )
      .run(startedAt);
    const counters = {
      newFiles: 0,
      changedFiles: 0,
      deletedFiles: 0,
      errors: 0,
    };
    const errors = [];
    try {
      logger.info("Scanning ROM directory");
      await scanRoms(counters, errors);
      logger.info("Scanning BIOS directory");
      await scanBios(counters, errors);
      logger.info("Looking for missing covers");
      await indexMissingCovers();
      const durationMs = Date.now() - startedMs;
      db.prepare(
        `UPDATE index_runs
         SET finished_at=?,duration_ms=?,status='completed',
             new_files=?,changed_files=?,deleted_files=?,
             error_files=?,errors=?
         WHERE id=?`,
      ).run(
        new Date().toISOString(),
        durationMs,
        counters.newFiles,
        counters.changedFiles,
        counters.deletedFiles,
        counters.errors,
        JSON.stringify(errors),
        Number(run.lastInsertRowid),
      );
      status = readLatestRun(db);
      logger.info("Indexing completed", {
        durationMs,
        newFiles: counters.newFiles,
        changedFiles: counters.changedFiles,
        deletedFiles: counters.deletedFiles,
        errors: counters.errors,
      });
      return status;
    } catch (error) {
      const durationMs = Date.now() - startedMs;
      db.prepare(
        `UPDATE index_runs
         SET finished_at=?,duration_ms=?,status='failed',
             new_files=?,changed_files=?,deleted_files=?,
             error_files=?,errors=?
         WHERE id=?`,
      ).run(
        new Date().toISOString(),
        durationMs,
        counters.newFiles,
        counters.changedFiles,
        counters.deletedFiles,
        counters.errors + 1,
        JSON.stringify([...errors, error.message]),
        Number(run.lastInsertRowid),
      );
      status = readLatestRun(db);
      logger.error("Indexing failed", {
        durationMs,
        errorFiles: counters.errors + 1,
        error: error.message,
      });
      throw error;
    }
  }

  async function scanRoms(counters, errors) {
    const romRoot = path.join(config.dataPath, "roms");
    fs.mkdirSync(romRoot, { recursive: true, mode: 0o700 });
    const discovered = new Set();
    for (const platform of fs.readdirSync(romRoot, { withFileTypes: true })) {
      if (!platform.isDirectory()) continue;
      const platformId = platform.name;
      const definition = platforms[platformId];
      if (!definition) continue;
      logger.debug("Indexing ROM platform", { platform: platformId });
      const platformRoot = path.join(romRoot, platformId);
      const files = fs
        .readdirSync(platformRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile());
      for (const entry of files) {
        const extension = path.extname(entry.name).toLowerCase();
        if (!definition.extensions.includes(extension)) continue;
        const filePath = path.join(platformRoot, entry.name);
        const key = `rom:${platformId}:${entry.name}`;
        discovered.add(key);
        try {
          await indexRomFile(
            platformId,
            definition,
            entry.name,
            filePath,
            counters,
          );
        } catch (error) {
          counters.errors += 1;
          errors.push(`${filePath}: ${error.message}`);
          logger.error("Could not index ROM", {
            platform: platformId,
            file: entry.name,
            error: error.message,
          });
        }
      }
    }
    markDeletedKind("rom", discovered, counters);
  }

  async function scanBios(counters, errors) {
    const biosRoot = path.join(config.dataPath, "bios");
    fs.mkdirSync(biosRoot, { recursive: true, mode: 0o700 });
    const discovered = new Set();
    for (const platform of fs.readdirSync(biosRoot, { withFileTypes: true })) {
      if (!platform.isDirectory()) continue;
      const platformId = platform.name;
      logger.debug("Indexing BIOS platform", { platform: platformId });
      const platformRoot = path.join(biosRoot, platformId);
      const files = fs
        .readdirSync(platformRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name !== "manifest.json");
      const latestFiles = [];
      for (const entry of files) {
        const filePath = path.join(platformRoot, entry.name);
        const key = `bios:${platformId}:${entry.name}`;
        discovered.add(key);
        try {
          const result = await indexSingleFile(
            "bios",
            platformId,
            entry.name,
            filePath,
            counters,
          );
          latestFiles.push({
            ...result,
            filename: entry.name,
            sha256: sha256File(filePath),
          });
        } catch (error) {
          counters.errors += 1;
          errors.push(`${filePath}: ${error.message}`);
          logger.error("Could not index BIOS", {
            platform: platformId,
            file: entry.name,
            error: error.message,
          });
        }
      }
      if (latestFiles.length) {
        const latest = latestFiles.sort(
          (left, right) => right.mtimeMs - left.mtimeMs,
        )[0];
        fs.writeFileSync(
          path.join(platformRoot, "manifest.json"),
          JSON.stringify(
            {
              filename: latest.filename,
              hash: latest.sha256,
              sha1: latest.sha1,
              crc32: latest.crc32,
              size: latest.size,
              updatedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
      } else {
        fs.rmSync(path.join(platformRoot, "manifest.json"), { force: true });
      }
    }
    markDeletedKind("bios", discovered, counters);
  }

  async function indexRomFile(
    platformId,
    definition,
    filename,
    filePath,
    counters,
  ) {
    const existing = db
      .prepare(
        `SELECT * FROM indexed_files
         WHERE kind='rom' AND platform=? AND relative_path=?`,
      )
      .get(platformId, filename);
    const stat = fs.statSync(filePath);
    if (
      existing &&
      existing.deleted_at === null &&
      existing.size === stat.size &&
      existing.mtime_ms === stat.mtimeMs
    ) {
      return;
    }
    const hashes = await hashFile(filePath);
    if (existing && existing.sha1 === hashes.sha1) {
      db.prepare(
        `UPDATE indexed_files
         SET size=?,mtime_ms=?,sha1=?,crc32=?,modified_at=?,
             deleted_at=NULL,last_indexed_at=?
         WHERE id=?`,
      ).run(
        stat.size,
        stat.mtimeMs,
        hashes.sha1,
        hashes.crc32,
        statToIso(stat),
        new Date().toISOString(),
        existing.id,
      );
      updateGameFile({
        platformId,
        definition,
        filename,
        filePath,
        stat,
        hashes,
        version: existing.version,
      });
      return;
    }
    const version = existing ? existing.version + 1 : 1;
    if (existing) {
      db.prepare(
        `UPDATE indexed_files
         SET size=?,mtime_ms=?,sha1=?,crc32=?,version=?,
             modified_at=?,deleted_at=NULL,last_indexed_at=?
         WHERE id=?`,
      ).run(
        stat.size,
        stat.mtimeMs,
        hashes.sha1,
        hashes.crc32,
        version,
        statToIso(stat),
        new Date().toISOString(),
        existing.id,
      );
      counters.changedFiles += 1;
      logger.info("ROM updated", {
        platform: platformId,
        file: filename,
        version,
        sha1: hashes.sha1,
      });
    } else {
      db.prepare(
        `INSERT INTO indexed_files
         (kind,platform,relative_path,filename,size,mtime_ms,sha1,crc32,
          version,created_at,modified_at,last_indexed_at)
         VALUES ('rom',?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        platformId,
        filename,
        filename,
        stat.size,
        stat.mtimeMs,
        hashes.sha1,
        hashes.crc32,
        1,
        statToIso(stat),
        statToIso(stat),
        new Date().toISOString(),
      );
      counters.newFiles += 1;
      logger.info("New ROM indexed", {
        platform: platformId,
        file: filename,
        sha1: hashes.sha1,
      });
    }
    updateGameFile({
      platformId,
      definition,
      filename,
      filePath,
      stat,
      hashes,
      version,
    });
  }

  async function indexSingleFile(
    kind,
    platformId,
    filename,
    filePath,
    counters,
  ) {
    const existing = db
      .prepare(
        `SELECT * FROM indexed_files
         WHERE kind=? AND platform=? AND relative_path=?`,
      )
      .get(kind, platformId, filename);
    const stat = fs.statSync(filePath);
    if (
      existing &&
      existing.deleted_at === null &&
      existing.size === stat.size &&
      existing.mtime_ms === stat.mtimeMs
    ) {
      return {
        ...existing,
        mtimeMs: existing.mtime_ms,
        sha1: existing.sha1,
        crc32: existing.crc32,
      };
    }
    const hashes = await hashFile(filePath);
    if (existing && existing.sha1 === hashes.sha1) {
      db.prepare(
        `UPDATE indexed_files
         SET size=?,mtime_ms=?,sha1=?,crc32=?,modified_at=?,
             deleted_at=NULL,last_indexed_at=?
         WHERE id=?`,
      ).run(
        stat.size,
        stat.mtimeMs,
        hashes.sha1,
        hashes.crc32,
        statToIso(stat),
        new Date().toISOString(),
        existing.id,
      );
      return { ...existing, ...hashes, size: stat.size, mtimeMs: stat.mtimeMs };
    }
    const version = existing ? existing.version + 1 : 1;
    if (existing) {
      db.prepare(
        `UPDATE indexed_files
         SET size=?,mtime_ms=?,sha1=?,crc32=?,version=?,
             modified_at=?,deleted_at=NULL,last_indexed_at=?
         WHERE id=?`,
      ).run(
        stat.size,
        stat.mtimeMs,
        hashes.sha1,
        hashes.crc32,
        version,
        statToIso(stat),
        new Date().toISOString(),
        existing.id,
      );
      counters.changedFiles += 1;
      logger.info("BIOS updated", {
        platform: platformId,
        file: filename,
        version,
        sha1: hashes.sha1,
      });
    } else {
      db.prepare(
        `INSERT INTO indexed_files
         (kind,platform,relative_path,filename,size,mtime_ms,sha1,crc32,
          version,created_at,modified_at,last_indexed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        kind,
        platformId,
        filename,
        filename,
        stat.size,
        stat.mtimeMs,
        hashes.sha1,
        hashes.crc32,
        1,
        statToIso(stat),
        statToIso(stat),
        new Date().toISOString(),
      );
      counters.newFiles += 1;
      logger.info("New BIOS indexed", {
        platform: platformId,
        file: filename,
        sha1: hashes.sha1,
      });
    }
    return { ...hashes, size: stat.size, mtimeMs: stat.mtimeMs };
  }

  function updateGameFile({
    platformId,
    definition,
    filename,
    filePath,
    stat,
    hashes,
    version,
  }) {
    const existingGame = db
      .prepare("SELECT id FROM games WHERE rom_path=?")
      .get(filePath);
    if (existingGame) {
      db.prepare(
        `UPDATE games
         SET title=COALESCE(title,title),
             platform=?,core=?,extension=?,rom_filename=?,
             sha1=?,crc32=?,version=?,modified_at=?,
             deleted_at=NULL,size=?,hash=?
         WHERE id=?`,
      ).run(
        platformId,
        definition.core,
        path.extname(filename).toLowerCase(),
        filename,
        hashes.sha1,
        hashes.crc32,
        version,
        statToIso(stat),
        stat.size,
        hashes.sha256,
        existingGame.id,
      );
      return;
    }
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO games
       (id,title,platform,core,extension,rom_path,rom_filename,
        sha1,crc32,version,modified_at,deleted_at,bios_system,size,hash,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      titleFromFilename(filename),
      platformId,
      definition.core,
      path.extname(filename).toLowerCase(),
      filePath,
      filename,
      hashes.sha1,
      hashes.crc32,
      version,
      statToIso(stat),
      null,
      platformId === "arcade" ? "arcade" : null,
      stat.size,
      hashes.sha256,
      statToIso(stat),
    );
  }

  function markDeletedKind(kind, discovered, counters) {
    const rows = db
      .prepare(
        "SELECT * FROM indexed_files WHERE kind=? AND deleted_at IS NULL",
      )
      .all(kind);
    for (const row of rows) {
      const key = `${kind}:${row.platform}:${row.relative_path}`;
      if (discovered.has(key)) continue;
      db.prepare("UPDATE indexed_files SET deleted_at=? WHERE id=?").run(
        new Date().toISOString(),
        row.id,
      );
      if (kind === "rom") {
        db.prepare("UPDATE games SET deleted_at=? WHERE rom_path=?").run(
          new Date().toISOString(),
          path.join(config.dataPath, "roms", row.platform, row.relative_path),
        );
      }
      counters.deletedFiles += 1;
      logger.info("File deleted", {
        kind,
        platform: row.platform,
        file: row.filename,
      });
    }
  }

  async function indexMissingCovers() {
    if (config.enable_cover_indexing === false) return;
    const rows = db
      .prepare(
        `SELECT * FROM games
         WHERE deleted_at IS NULL
           AND (cover_path IS NULL OR cover_path='')
           AND (cover_attempted_at IS NULL
                OR cover_attempted_at <= ?)`,
      )
      .all(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    logger.debug("Pending covers", { count: rows.length });
    const batchSize = 2;
    for (let index = 0; index < rows.length; index += batchSize) {
      await Promise.all(
        rows
          .slice(index, index + batchSize)
          .map((game) => resolveAndStoreCover(game).catch(() => null)),
      );
    }
  }

  async function resolveAndStoreCover(game) {
    db.prepare("UPDATE games SET cover_attempted_at=? WHERE id=?").run(
      new Date().toISOString(),
      game.id,
    );
    const filename = path.basename(game.rom_filename || game.rom_path);
    const stem = path.basename(filename, path.extname(filename));
    let officialName = null;
    try {
      officialName = await findOfficialName(
        game.platform,
        game.sha1,
        game.crc32,
      );
    } catch {
      officialName = null;
    }
    const candidates = buildCoverCandidates(stem, officialName);
    for (const candidate of candidates) {
      try {
        const buffer = await downloadLibretroCover(
          game.platform,
          `${candidate}.png`,
        );
        const coverInfo = validateCoverImage(buffer);
        const coverDirectory = path.join(
          config.dataPath,
          "covers",
          game.platform,
        );
        fs.mkdirSync(coverDirectory, { recursive: true, mode: 0o700 });
        const coverPath = path.join(
          coverDirectory,
          `${game.hash}${imageExtension(coverInfo.mime)}`,
        );
        fs.writeFileSync(coverPath, buffer, { mode: 0o600 });
        db.prepare(
          `UPDATE games
           SET cover_path=?,cover_mime=?,cover_source=?,
               cover_source_name=?,cover_updated_at=?
           WHERE id=?`,
        ).run(
          coverPath,
          coverInfo.mime,
          "libretro",
          candidate,
          new Date().toISOString(),
          game.id,
        );
        logger.info("Cover found", {
          platform: game.platform,
          game: game.title,
          sourceName: candidate,
        });
        return;
      } catch {
        logger.debug("Cover attempt failed", {
          platform: game.platform,
          game: game.title,
          candidate,
        });
        continue;
      }
    }
    logger.warning("Cover not found", {
      platform: game.platform,
      game: game.title,
    });
  }
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

export async function hashFile(filePath) {
  const sha1 = crypto.createHash("sha1");
  const sha256 = crypto.createHash("sha256");
  let crc = 0xffffffff;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      sha1.update(chunk);
      sha256.update(chunk);
      crc = crc32Update(crc, chunk);
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return {
    sha1: sha1.digest("hex"),
    sha256: sha256.digest("hex"),
    crc32: ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0"),
  };
}

export function crc32Buffer(buffer) {
  let crc = 0xffffffff;
  crc = crc32Update(crc, buffer);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export function buildCoverCandidates(fullName, officialName = null) {
  const candidates = [];
  if (officialName) candidates.push(officialName);
  const stem = String(fullName || "").trim();
  if (stem && !candidates.includes(stem)) candidates.push(stem);
  const words = stem.split(/\s+/).filter(Boolean);
  for (let count = words.length - 1; count >= 1; count -= 1) {
    const candidate = words.slice(0, count).join(" ");
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

async function findOfficialName(platform, sha1, crc32) {
  const url = datUrls[platform];
  if (!url) return null;
  const response = await fetchWithTimeout(url);
  if (!response.ok) return null;
  const text = await response.text();
  const sha1Normalized = String(sha1 || "").toLowerCase();
  const crcNormalized = String(crc32 || "")
    .replace(/^0x/, "")
    .toLowerCase();
  const blocks = text.match(/game\s*\([\s\S]*?\n\)/gi) || [];
  for (const block of blocks) {
    const name = block.match(/(?:^|\n)\s*name\s+"([^"]+)"/i);
    const shaMatches = [...block.matchAll(/sha1\s+([0-9a-f]+)/gi)].map(
      (match) => match[1].toLowerCase(),
    );
    const crcMatches = [...block.matchAll(/crc\s+([0-9a-f]+)/gi)].map((match) =>
      match[1].toLowerCase(),
    );
    if (
      (sha1Normalized && shaMatches.includes(sha1Normalized)) ||
      (crcNormalized && crcMatches.includes(crcNormalized))
    ) {
      return name?.[1] || null;
    }
  }
  return null;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Retro-Web-Home-Assistant-App/1.0" },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function readLatestRun(db) {
  return (
    db.prepare("SELECT * FROM index_runs ORDER BY id DESC LIMIT 1").get() ||
    null
  );
}

function statToIso(stat) {
  return new Date(stat.mtimeMs).toISOString();
}

function crc32Update(crc, buffer) {
  let value = crc;
  for (const byte of buffer) {
    value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  }
  return value;
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
