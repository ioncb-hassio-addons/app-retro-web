export const coverPlaylists = {
  nes: "Nintendo_-_Nintendo_Entertainment_System",
  snes: "Nintendo_-_Super_Nintendo_Entertainment_System",
  gb: "Nintendo_-_Game_Boy",
  gba: "Nintendo_-_Game_Boy_Advance",
  n64: "Nintendo_-_Nintendo_64",
  arcade: "FBNeo_-_Arcade_Games",
};

const indexCache = new Map();

export function detectImageMime(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function validateCoverImage(buffer) {
  const mime = detectImageMime(buffer);
  if (!mime) throw new Error("Unsupported cover image");
  const dimensions = readImageDimensions(buffer, mime);
  if (
    !dimensions ||
    dimensions.width < 16 ||
    dimensions.height < 16 ||
    dimensions.width > 5000 ||
    dimensions.height > 5000 ||
    dimensions.width * dimensions.height > 20_000_000
  ) {
    throw new Error("Invalid or oversized cover dimensions");
  }
  return { mime, ...dimensions };
}

export function imageExtension(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  throw new Error("Unsupported image type");
}

export async function searchLibretroCovers(platform, query) {
  const playlist = coverPlaylists[platform];
  if (!playlist)
    throw new Error("Cover search is not available for this platform");
  const term = String(query || "").trim();
  if (term.length < 2 || term.length > 120) {
    throw new Error("Search term must contain between 2 and 120 characters");
  }

  const files = await listCoverFiles(platform, playlist);
  const names = [];
  const normalizedTerm = normalizeCoverSearch(term);
  for (const file of files) {
    const name = file.name;
    if (
      normalizeCoverSearch(name).includes(normalizedTerm) &&
      !names.includes(name)
    ) {
      names.push(name);
    }
    if (names.length >= 12) break;
  }
  return names.map((name) => ({ name, source: "libretro" }));
}

export async function downloadLibretroCover(platform, name) {
  const playlist = coverPlaylists[platform];
  if (!playlist)
    throw new Error("Cover search is not available for this platform");
  if (
    !String(name).endsWith(".png") ||
    String(name).includes("/") ||
    String(name).includes("\\")
  ) {
    throw new Error("Invalid Libretro cover name");
  }

  const url = new URL(
    `https://raw.githubusercontent.com/libretro-thumbnails/${playlist}/master/Named_Boxarts/${encodeURIComponent(name)}`,
  );
  if (url.hostname !== "raw.githubusercontent.com") {
    throw new Error("Unapproved cover host");
  }
  const response = await fetchWithTimeout(url);
  if (!response.ok)
    throw new Error(`Thumbnail provider returned ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > 8 * 1024 * 1024) {
    throw new Error("Cover exceeds maximum size");
  }
  if (validateCoverImage(buffer).mime !== "image/png") {
    throw new Error("Invalid Libretro cover image");
  }
  return buffer;
}

async function listCoverFiles(platform, playlist) {
  const cached = indexCache.get(platform);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.files;

  const url = new URL(
    `https://api.github.com/repos/libretro-thumbnails/${playlist}/contents/Named_Boxarts?per_page=1000`,
  );
  if (url.hostname !== "api.github.com")
    throw new Error("Unapproved cover host");
  const response = await fetchWithTimeout(url, {
    Accept: "application/vnd.github+json",
  });
  if (!response.ok) {
    throw new Error(`Thumbnail provider returned ${response.status}`);
  }
  const entries = JSON.parse(await limitedText(response, 20 * 1024 * 1024));
  if (!Array.isArray(entries))
    throw new Error("Invalid thumbnail provider index");
  const files = entries.filter(
    (entry) => entry.type === "file" && entry.name?.endsWith(".png"),
  );
  indexCache.set(platform, { at: Date.now(), files });
  return files;
}

async function fetchWithTimeout(input, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(input, {
      redirect: "error",
      signal: controller.signal,
      headers: {
        "user-agent": "Retro-Web-Home-Assistant-App/1.0",
        ...extraHeaders,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function limitedText(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error("Thumbnail index is too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeCoverSearch(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function readImageDimensions(buffer, mime) {
  if (mime === "image/png" && buffer.length >= 24) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (mime === "image/webp" && buffer.length >= 30) {
    if (buffer.subarray(12, 16).toString() === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    if (
      buffer.subarray(12, 16).toString() === "VP8 " &&
      buffer[23] === 0x9d &&
      buffer[24] === 0x01 &&
      buffer[25] === 0x2a
    ) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2) break;
      offset += segmentLength + 2;
    }
  }
  return null;
}
