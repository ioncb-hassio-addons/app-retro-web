const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  notice: 35,
  warning: 40,
  error: 50,
  fatal: 60,
};

const LABELS = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO",
  notice: "NOTICE",
  warning: "WARNING",
  error: "ERROR",
  fatal: "FATAL",
};

export function createLogger(config = {}) {
  const configuredLevel = String(config.log_level || "info").toLowerCase();
  const threshold = LEVELS[configuredLevel] ?? LEVELS.info;

  function write(level, message, details = null) {
    if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
    const timestamp = formatLogTimestamp();
    let output = `[${timestamp}] ${LABELS[level]}: ${String(message)}`;
    if (details !== null && details !== undefined) {
      output += ` ${formatDetails(details)}`;
    }
    if (level === "warning") {
      console.warn(output);
    } else if (level === "error" || level === "fatal") {
      console.error(output);
    } else {
      console.log(output);
    }
  }

  return {
    trace: (message, details) => write("trace", message, details),
    debug: (message, details) => write("debug", message, details),
    info: (message, details) => write("info", message, details),
    notice: (message, details) => write("notice", message, details),
    warning: (message, details) => write("warning", message, details),
    error: (message, details) => write("error", message, details),
    fatal: (message, details) => write("fatal", message, details),
  };
}

function formatDetails(details) {
  if (typeof details === "string") return details;
  if (details instanceof Error) return details.stack || details.message;
  if (typeof details === "object") {
    return Object.entries(details)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(" ");
  }
  return String(details);
}

function formatValue(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function formatLogTimestamp(date = new Date()) {
  const configuredTimezone = String(process.env.TZ || "").trim();
  if (configuredTimezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: configuredTimezone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date);
      const values = Object.fromEntries(
        parts
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, part.value]),
      );
      return [values.hour, values.minute, values.second].join(":");
    } catch {
      // Fall back to the container's system timezone for invalid TZ values.
    }
  }
  return [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
}
