import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function ensureStorage(dataPath) {
  for (const directory of [
    "roms",
    "bios",
    "covers",
    "saves",
    "avatars/system",
    "avatars/custom",
    "profiles",
    "temp",
  ]) {
    fs.mkdirSync(path.join(dataPath, directory), {
      recursive: true,
      mode: 0o700,
    });
  }
  seedDefaultSystemAvatars(dataPath);
}

export function seedDefaultSystemAvatars(dataPath) {
  const systemDirectory = path.join(dataPath, "avatars", "system");
  fs.mkdirSync(systemDirectory, { recursive: true, mode: 0o700 });
  const existingAvatars = fs
    .readdirSync(systemDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /^avatar_\d{2}\.webp$/i.test(entry.name),
    );
  if (existingAvatars.length > 0) return;

  const appRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const defaultsDirectory = path.join(appRoot, "app", "default-avatars");
  if (!fs.existsSync(defaultsDirectory)) return;

  for (const entry of fs
    .readdirSync(defaultsDirectory, { withFileTypes: true })
    .filter((item) => item.isFile() && /^avatar_\d{2}\.webp$/i.test(item.name))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    fs.copyFileSync(
      path.join(defaultsDirectory, entry.name),
      path.join(systemDirectory, entry.name),
      fs.constants.COPYFILE_EXCL,
    );
  }
}

export function safeFilename(input) {
  const normalized = path
    .basename(String(input || ""))
    .replace(/[^A-Za-z0-9._ -]/g, "_");
  return normalized.slice(0, 160) || "file.bin";
}

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function savePath(dataPath, profileId, gameId, kind, slot) {
  const directory = path.join(dataPath, "profiles", profileId, gameId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, `${kind}-${slot}.bin`);
}

export function atomicWrite(targetPath, data) {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, data, { mode: 0o600 });
  fs.renameSync(temporaryPath, targetPath);
}

export function secureCompare(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left)).digest();
  const rightHash = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}
