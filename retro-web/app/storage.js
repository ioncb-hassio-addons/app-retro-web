import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function ensureStorage(dataPath) {
  for (const directory of [
    "roms",
    "bios",
    "covers",
    "saves",
    "avatars",
    "profiles",
    "temp",
  ]) {
    fs.mkdirSync(path.join(dataPath, directory), {
      recursive: true,
      mode: 0o700,
    });
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
