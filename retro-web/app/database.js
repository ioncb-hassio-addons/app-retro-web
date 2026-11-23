import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function createDatabase(dataPath) {
  fs.mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataPath, "app.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      color TEXT NOT NULL,
      language TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      platform TEXT NOT NULL,
      core TEXT NOT NULL,
      extension TEXT NOT NULL,
      rom_path TEXT NOT NULL UNIQUE,
      bios_system TEXT,
      size INTEGER NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS progress (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      favorite INTEGER NOT NULL DEFAULT 0,
      last_played TEXT,
      PRIMARY KEY (profile_id, game_id)
    );

    CREATE TABLE IF NOT EXISTS saves (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      core TEXT NOT NULL,
      kind TEXT NOT NULL,
      slot INTEGER NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      emulator_version TEXT,
      core_version TEXT,
      rom_hash TEXT,
      save_hash TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, game_id, core, kind, slot)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
      is_external_admin INTEGER NOT NULL DEFAULT 0,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  ensureColumn(db, "profiles", "language", "TEXT");
  ensureColumn(db, "games", "cover_path", "TEXT");
  ensureColumn(db, "games", "cover_mime", "TEXT");
  ensureColumn(db, "games", "cover_source", "TEXT");
  ensureColumn(db, "games", "cover_source_name", "TEXT");
  ensureColumn(db, "games", "cover_updated_at", "TEXT");
  ensureColumn(db, "saves", "emulator_version", "TEXT");
  ensureColumn(db, "saves", "core_version", "TEXT");
  ensureColumn(db, "saves", "rom_hash", "TEXT");
  ensureColumn(db, "saves", "save_hash", "TEXT");

  const profileCount = db
    .prepare("SELECT count(*) AS count FROM profiles")
    .get().count;
  if (profileCount === 0) {
    db.prepare(
      "INSERT INTO profiles (id, name, avatar, color, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      crypto.randomUUID(),
      "Player 1",
      "🎮",
      "#ff3b6b",
      new Date().toISOString(),
    );
  }

  return db;
}

export function listProfiles(db) {
  return db
    .prepare(
      "SELECT id, name, avatar, color, language FROM profiles ORDER BY created_at",
    )
    .all();
}

export function listGames(db, profileId) {
  return db
    .prepare(
      `SELECT games.id, games.title, games.platform, games.core,
              games.bios_system, games.size, games.created_at,
              CASE WHEN games.cover_path IS NOT NULL THEN 1 ELSE 0 END AS has_cover,
              games.cover_source, games.cover_source_name,
            CASE
              WHEN games.bios_system = 'arcade' THEN 1
              ELSE 0
            END AS bios_required,
              COALESCE(progress.favorite, 0) AS favorite,
              progress.last_played
       FROM games
       LEFT JOIN progress
         ON progress.game_id = games.id AND progress.profile_id = ?
       ORDER BY progress.last_played IS NULL, progress.last_played DESC, games.title`,
    )
    .all(profileId);
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
