export const platforms = {
  nes: {
    label: "Nintendo Entertainment System",
    core: "fceumm",
    extensions: [".nes", ".fds", ".unf", ".unif"],
  },
  snes: {
    label: "Super Nintendo",
    core: "snes9x",
    extensions: [".sfc", ".smc", ".swc"],
  },
  gb: {
    label: "Game Boy / Color",
    core: "gambatte",
    extensions: [".gb", ".gbc"],
  },
  gba: {
    label: "Game Boy Advance",
    core: "mgba",
    extensions: [".gba"],
  },
  n64: {
    label: "Nintendo 64",
    core: "mupen64plus_next",
    extensions: [".z64", ".n64", ".v64"],
  },
  arcade: {
    label: "Arcade",
    core: "fbneo",
    extensions: [".zip", ".7z"],
  },
};

export function platformForUpload(platform, extension, enableArcade) {
  const definition = platforms[platform];
  if (!definition) throw new Error("Unknown platform");
  if (platform === "arcade" && !enableArcade) {
    throw new Error("Arcade is disabled in the app configuration");
  }
  if (!definition.extensions.includes(extension.toLowerCase())) {
    throw new Error(`Unsupported file extension for ${definition.label}`);
  }
  return definition;
}
