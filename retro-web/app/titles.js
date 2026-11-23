export function titleFromFilename(filename) {
  const base = String(filename || "")
    .replace(/\.[^/.]+$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\.(?=[A-Za-z0-9])/g, " ")
    .replace(/(?<=\S)-(?=\S)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return base.slice(0, 160) || "Untitled game";
}

export function normalizeTitle(title, filename) {
  const normalized = String(title || "")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || titleFromFilename(filename)).slice(0, 160);
}
