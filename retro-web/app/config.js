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
  ssl: false,
  certfile: "fullchain.pem",
  keyfile: "privkey.pem",
  tls_self_signed_days: 365,
  tls_self_signed_common_name: "",
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
  config.tls_self_signed_days = Number(
    config.tls_self_signed_days,
  );

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

  if (config.ssl && config.external_access) {
    if (
      typeof config.certfile !== "string" ||
      typeof config.keyfile !== "string"
    ) {
      throw new Error("SSL certificate and key names are required");
    }
  }

  return config;
}
