import fs from "node:fs";

const defaults = {
  log_level: "info",
  external_access: false,
  external_username: "",
  external_password: "",
  allow_external_rom_upload: false,
  external_admin_password: "",
  session_timeout_hours: 12,
  max_upload_mb: 4096,
  profile_limit: 8,
  enable_arcade: true,
};

export function loadConfig(optionsPath = "/data/options.json") {
  let options = {};
  if (fs.existsSync(optionsPath)) {
    options = JSON.parse(fs.readFileSync(optionsPath, "utf8"));
  }

  const config = {
    ...defaults,
    ...options,
    dataPath: process.env.RETRO_WEB_DATA_PATH || "/data",
    internalPort: Number(process.env.RETRO_WEB_INTERNAL_PORT || 8099),
    externalPort: Number(process.env.RETRO_WEB_EXTERNAL_PORT || 8098),
  };

  config.max_upload_mb = Number(config.max_upload_mb);
  config.profile_limit = Number(config.profile_limit);
  config.session_timeout_hours = Number(config.session_timeout_hours);

  if (
    config.external_access &&
    (!config.external_username || !config.external_password)
  ) {
    throw new Error(
      "External access requires external_username and external_password",
    );
  }

  if (config.allow_external_rom_upload && !config.external_admin_password) {
    throw new Error("External ROM uploads require external_admin_password");
  }

  if (config.allow_external_rom_upload && !config.external_access) {
    throw new Error(
      "External ROM uploads cannot be enabled while external access is off",
    );
  }

  return config;
}
