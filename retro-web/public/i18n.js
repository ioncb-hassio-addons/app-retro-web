import es from "./i18n/es.json" with { type: "json" };
import en from "./i18n/en.json" with { type: "json" };

const dictionaries = { es, en };

let active = "es";

export function setLocale(language) {
  active = language === "en" ? "en" : "es";
  document.documentElement.lang = active;
}

export function getLocale() {
  return active;
}

export function detectLocale() {
  return navigator.language?.toLowerCase().startsWith("es") ? "es" : "en";
}

export function t(key) {
  return dictionaries[active]?.[key] || dictionaries.en[key] || key;
}

export function tf(key, values = {}) {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    t(key),
  );
}
