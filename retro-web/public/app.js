import { detectLocale, getLocale, setLocale, t } from "./i18n.js";
import {
  cacheAsset,
  clearProfileAssets,
  clearProfileSaves,
  getCachedAsset,
  getLocalSave,
  getRememberedProfileContext,
  getStorageUsage,
  listLocalSaves,
  putLocalSave,
  rememberProfileContext,
} from "./local-store.js";

const app = document.querySelector("#app");
const toastElement = document.querySelector("#toast");

const state = {
  bootstrap: null,
  csrf: null,
  profileId: null,
  games: [],
  platforms: [],
  language: detectLocale(),
  pendingCoverFile: null,
  pendingLibretroCover: null,
  coverPreviewUrl: null,
  screen: "profiles",
};

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.csrf) headers.set("x-retro-csrf", state.csrf);
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      message = data.error || message;
    } catch {
      // Keep the HTTP status when the response has no JSON body.
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") || "";
  return type.includes("application/json")
    ? response.json()
    : response.arrayBuffer();
}

function toast(message, isError = false) {
  toastElement.textContent = message;
  toastElement.className = `toast visible${isError ? " error" : ""}`;
  clearTimeout(toastElement.timeout);
  toastElement.timeout = setTimeout(() => {
    toastElement.className = "toast";
  }, 4000);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function boot() {
  try {
    setLocale(state.language);
    const loadingMessage = document.querySelector("#loading-message");
    if (loadingMessage) loadingMessage.textContent = t("loading");
    state.bootstrap = await api("./api/bootstrap");
    state.csrf = state.bootstrap.csrf;
    state.profileId = state.bootstrap.profileId || null;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.warn("[Retro Web] Service worker registration failed", error);
      });
    }
    if (state.bootstrap.external && !state.bootstrap.authenticated) {
      renderLogin();
      return;
    }
    if (await restorePendingLocalState()) return;
    renderProfiles();
  } catch (error) {
    const localContext = await getRememberedProfileContext().catch(() => null);
    if (localContext?.bootstrap?.external === false) {
      state.bootstrap = localContext.bootstrap;
      state.profileId = localContext.profileId;
      state.games = localContext.games;
      state.platforms = [];
      state.language = localContext.language || state.language;
      setLocale(state.language);
      toast(t("offlineMode"), true);
      renderLibrary();
      return;
    }
    renderError(error.message);
  }
}

function renderError(message) {
  app.innerHTML = `
    <div class="loading-card">
      <span class="gamepad">⚠️</span>
      <h1>${t("initError")}</h1>
      <p>${escapeHtml(message)}</p>
    </div>`;
}

function renderLogin() {
  app.innerHTML = `
    <main class="login-card">
      <div class="brand"><span>🎮</span><strong>Retro Web</strong></div>
      <h1>${t("privateAccess")}</h1>
      <p class="muted">${t("privateAccessHelp")}</p>
      <form id="login-form">
        <label>${t("username")}<input name="username" autocomplete="username" required /></label>
        <label>${t("password")}<input name="password" type="password" autocomplete="current-password" required /></label>
        <button class="primary" type="submit">${t("login")}</button>
      </form>
    </main>`;
  document
    .querySelector("#login-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      try {
        const result = await api("./api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        });
        state.csrf = result.csrf;
        state.bootstrap = await api("./api/bootstrap");
        renderProfiles();
      } catch (error) {
        toast(error.message, true);
      }
    });
}

function renderProfiles() {
  state.screen = "profiles";
  for (const url of coverBlobUrls) URL.revokeObjectURL(url);
  coverBlobUrls.clear();
  app.innerHTML = `
    <main class="content">
      <section class="hero">
        <span class="chip">${state.bootstrap.external ? t("externalAccess") : t("ingressAdmin")}</span>
        <div class="profile-language">${languageSelector()}</div>
        <h1>${t("whoPlays")}</h1>
        <p>${t("profileHelp")}</p>
      </section>
      <section class="profiles">
        ${state.bootstrap.profiles
          .map(
            (profile) => `
              <button class="profile-card" data-profile="${escapeHtml(profile.id)}"
                style="--profile-color:${escapeHtml(profile.color)}">
                <span class="profile-avatar">${escapeHtml(profile.avatar)}</span>
                <strong>${escapeHtml(profile.name)}</strong>
              </button>`,
          )
          .join("")}
      </section>
    </main>`;
  document.querySelectorAll("[data-profile]").forEach((button) => {
    button.addEventListener("click", () =>
      selectProfile(button.dataset.profile),
    );
  });
  bindLanguageSelector();
}

async function selectProfile(profileId) {
  try {
    await api("./api/profiles/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId }),
    });
    state.profileId = profileId;
    const profile = state.bootstrap.profiles.find(
      (item) => item.id === profileId,
    );
    if (profile?.language) {
      state.language = profile.language;
      setLocale(state.language);
    }
    await loadLibrary();
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadLibrary() {
  try {
    state.games = await api("./api/games", {
      headers: { "x-profile-id": state.profileId },
    });
    if (!state.bootstrap.external) {
      state.platforms = await api("./api/admin/platforms");
    }
    await rememberProfileContext({
      profileId: state.profileId,
      bootstrap: state.bootstrap,
      games: state.games,
      language: state.language,
    });
    renderLibrary();
  } catch (error) {
    toast(error.message, true);
    renderProfiles();
  }
}

function currentProfile() {
  return state.bootstrap.profiles.find(
    (profile) => profile.id === state.profileId,
  );
}

function languageSelector() {
  return `
    <label class="language-selector">
      <span>${t("language")}</span>
      <select id="language-select" aria-label="${t("language")}">
        <option value="es"${getLocale() === "es" ? " selected" : ""}>${t("spanish")}</option>
        <option value="en"${getLocale() === "en" ? " selected" : ""}>${t("english")}</option>
      </select>
    </label>`;
}

function bindLanguageSelector() {
  document
    .querySelector("#language-select")
    ?.addEventListener("change", async (event) => {
      const language = event.currentTarget.value;
      state.language = language;
      setLocale(language);
      if (state.profileId) {
        try {
          await api(`./api/profiles/${state.profileId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ language }),
          });
          const profile = state.bootstrap.profiles.find(
            (item) => item.id === state.profileId,
          );
          if (profile) profile.language = language;
          toast(t("languageSaved"));
        } catch (error) {
          toast(error.message, true);
        }
      }
      if (state.screen === "library") renderLibrary();
      else renderProfiles();
    });
}

function renderLibrary() {
  state.screen = "library";
  const profile = currentProfile();
  const adminActions = state.bootstrap.external
    ? state.bootstrap.externalAdminEnabled
      ? `<button class="secondary" id="admin-button">${t("administer")}</button>`
      : ""
    : `<button class="secondary" id="admin-button">${t("administer")}</button>`;
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span>🎮</span><strong>Retro Web</strong></div>
      <div class="topbar-actions">
        ${languageSelector()}
        <button class="secondary" id="profiles-button">${t("profiles")}</button>
        ${adminActions}
        ${state.bootstrap.external ? `<button class="secondary" id="logout-button">${t("logout")}</button>` : ""}
      </div>
    </header>
    <main class="content">
      <section class="hero">
        <span class="chip">${escapeHtml(profile?.name || t("profile"))}</span>
        ${navigator.onLine ? "" : `<span class="chip">${t("offlineModeShort")}</span>`}
        <h1>${t("continueAdventure")}</h1>
        <p>${t("libraryHelp")}</p>
      </section>
      <h2 class="section-title">${t("library")}</h2>
      ${
        state.games.length
          ? `<section class="game-grid">${state.games.map(gameCard).join("")}</section>`
          : `<section class="empty-state"><h2>${t("noGames")}</h2><p class="muted">${t("noGamesHelp")}</p></section>`
      }
    </main>`;
  document
    .querySelector("#profiles-button")
    .addEventListener("click", renderProfiles);
  document.querySelector("#admin-button")?.addEventListener("click", openAdmin);
  document.querySelector("#logout-button")?.addEventListener("click", logout);
  document.querySelectorAll("[data-game]").forEach((button) => {
    button.addEventListener("click", () => launchGame(button.dataset.game));
  });
  document.querySelectorAll(".cover img").forEach((image) => {
    image.addEventListener("error", () => {
      image.hidden = true;
      image.nextElementSibling.hidden = false;
    });
  });
  bindLanguageSelector();
  void hydrateCachedCovers();
}

function gameCard(game) {
  return `
    <button class="game-card" data-game="${escapeHtml(game.id)}">
      <div class="cover">
        ${
          game.has_cover
            ? `<img data-cover-game="${escapeHtml(game.id)}" alt="${escapeHtml(game.title)}" loading="lazy" hidden /><span class="cover-fallback">🕹️</span>`
            : '<span class="cover-fallback">🕹️</span>'
        }
      </div>
      <div class="game-card-body">
        <h3>${escapeHtml(game.title)}</h3>
        <span class="chip">${escapeHtml(game.platform.toUpperCase())}</span>
        ${game.bios_required ? `<p class="muted">${game.bios_system}: ${t("biosRequired")}</p>` : ""}
      </div>
    </button>`;
}

async function logout() {
  await api("./api/logout", { method: "POST" });
  state.csrf = null;
  state.profileId = null;
  state.bootstrap = await api("./api/bootstrap");
  renderLogin();
}

async function openAdmin() {
  if (state.bootstrap.external) {
    const password = prompt(t("externalAdminPassword"));
    if (password === null) return;
    try {
      await api("./api/external-admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      state.platforms = await api("./api/admin/platforms");
    } catch (error) {
      toast(error.message, true);
      return;
    }
  }
  renderAdmin();
}

function renderAdmin() {
  state.screen = "admin";
  for (const url of coverBlobUrls) URL.revokeObjectURL(url);
  coverBlobUrls.clear();
  state.pendingCoverFile = null;
  state.pendingLibretroCover = null;
  revokeCoverPreview();
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span>⚙️</span><strong>${t("administration")}</strong></div>
      <button class="secondary" id="back-button">${t("back")}</button>
    </header>
    <main class="content">
      <div class="admin-grid">
        <section class="panel">
          <h2>${t("newProfile")}</h2>
          <form id="profile-form">
            <label>${t("name")}<input name="name" maxlength="40" required /></label>
            <label>${t("avatar")}<input name="avatar" value="🎮" maxlength="12" /></label>
            <label>${t("color")}<input name="color" type="color" value="#5b8def" /></label>
            <button class="primary" type="submit">${t("createProfile")}</button>
          </form>
        </section>
        <section class="panel">
          <h2>${t("addRom")}</h2>
          <form id="rom-form">
            <label>${t("title")}<input id="rom-title" name="title" maxlength="160" /><span class="field-help">${t("titleAutoHelp")}</span></label>
            <label>${t("platform")}<select id="rom-platform" name="platform" required>
              ${state.platforms
                .filter((platform) => !platform.disabled)
                .map(
                  (platform) =>
                    `<option value="${platform.id}">${escapeHtml(platform.label)}</option>`,
                )
                .join("")}
            </select></label>
            <label>${t("romFile")}<input id="rom-file" name="file" type="file" required /></label>
            <div class="cover-upload">
              <strong>${t("coverOptional")}</strong>
              <label>${t("chooseCover")}<input id="cover-file" type="file" accept="image/png,image/jpeg,image/webp" /></label>
              <div id="cover-preview" class="cover-preview"><span>🕹️</span></div>
              <button class="secondary" id="clear-cover-button" type="button" hidden>${t("clearCover")}</button>
            </div>
            <div class="cover-search">
              <label>${t("searchCover")}<input id="cover-query" type="search" /></label>
              <button class="secondary" id="cover-search-button" type="button">${t("search")}</button>
              <div id="cover-results" class="cover-results"></div>
            </div>
            <button class="primary" type="submit">${t("uploadRom")}</button>
          </form>
        </section>
        <section class="panel">
          <h2>${t("addBios")}</h2>
          <p class="muted">${t("biosLegalHelp")}</p>
          <form id="bios-form">
            <label>${t("system")}<select name="system"><option value="n64">Nintendo 64</option><option value="arcade">Arcade</option></select></label>
            <label>${t("biosFile")}<input name="file" type="file" required /></label>
            <button class="primary" type="submit">${t("uploadBios")}</button>
          </form>
        </section>
      </div>
    </main>`;
  document.querySelector("#back-button").addEventListener("click", async () => {
    state.bootstrap.profiles = await api("./api/profiles");
    if (!state.bootstrap.external)
      state.platforms = await api("./api/admin/platforms");
    loadLibrary();
  });
  document
    .querySelector("#profile-form")
    .addEventListener("submit", createProfile);
  document.querySelector("#rom-form").addEventListener("submit", uploadRom);
  document.querySelector("#bios-form").addEventListener("submit", uploadBios);
  document
    .querySelector("#rom-file")
    .addEventListener("change", autoFillRomTitle);
  document
    .querySelector("#cover-file")
    .addEventListener("change", previewManualCover);
  document
    .querySelector("#cover-search-button")
    .addEventListener("click", searchCovers);
  document
    .querySelector("#clear-cover-button")
    .addEventListener("click", clearPendingCover);
}

function autoFillRomTitle(event) {
  const titleInput = document.querySelector("#rom-title");
  if (!titleInput || titleInput.value.trim()) return;
  titleInput.value = titleFromFilename(event.currentTarget.files?.[0]?.name);
}

function titleFromFilename(filename) {
  return String(filename || "")
    .replace(/\.[^/.]+$/, "")
    .replaceAll("_", " ")
    .replace(/\.(?=[A-Za-z0-9])/g, " ")
    .replace(/(?<=\S)-(?=\S)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function previewManualCover(event) {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  state.pendingCoverFile = file;
  state.pendingLibretroCover = null;
  setCoverPreview(URL.createObjectURL(file));
}

function setCoverPreview(url) {
  revokeCoverPreview();
  state.coverPreviewUrl = url;
  const preview = document.querySelector("#cover-preview");
  if (!preview) return;
  preview.innerHTML = `<img src="${url}" alt="${t("coverPreview")}" />`;
  document.querySelector("#clear-cover-button").hidden = false;
}

function revokeCoverPreview() {
  if (
    state.coverPreviewUrl?.startsWith("blob:") &&
    typeof URL.revokeObjectURL === "function"
  ) {
    URL.revokeObjectURL(state.coverPreviewUrl);
  }
  state.coverPreviewUrl = null;
}

function clearPendingCover() {
  state.pendingCoverFile = null;
  state.pendingLibretroCover = null;
  revokeCoverPreview();
  const file = document.querySelector("#cover-file");
  if (file) file.value = "";
  const preview = document.querySelector("#cover-preview");
  if (preview) preview.innerHTML = "<span>🕹️</span>";
  const clearButton = document.querySelector("#clear-cover-button");
  if (clearButton) clearButton.hidden = true;
}

async function searchCovers() {
  const queryInput = document.querySelector("#cover-query");
  const query =
    queryInput.value.trim() ||
    document.querySelector("#rom-title")?.value.trim() ||
    "";
  const platform = document.querySelector("#rom-platform")?.value;
  const resultsElement = document.querySelector("#cover-results");
  const button = document.querySelector("#cover-search-button");
  if (!query || !platform) {
    toast(t("coverSearch"), true);
    return;
  }
  button.disabled = true;
  button.textContent = t("searching");
  try {
    const results = await api(
      `./api/admin/covers/search?platform=${encodeURIComponent(platform)}&q=${encodeURIComponent(query)}`,
    );
    resultsElement.innerHTML = results.length
      ? results
          .map(
            (result) => `
              <button class="cover-result" type="button" data-cover-name="${escapeHtml(result.name)}">
                <img src="./api/admin/covers/preview?platform=${encodeURIComponent(platform)}&name=${encodeURIComponent(result.name)}" alt="${escapeHtml(result.name)}" loading="lazy" />
                <span>${escapeHtml(result.name)}</span>
              </button>`,
          )
          .join("")
      : `<p class="muted">${t("noCovers")}</p>`;
    resultsElement.querySelectorAll("[data-cover-name]").forEach((button) => {
      button.addEventListener("click", () => {
        state.pendingLibretroCover = button.dataset.coverName;
        state.pendingCoverFile = null;
        const file = document.querySelector("#cover-file");
        if (file) file.value = "";
        const selected = button.querySelector("img");
        setCoverPreview(selected.src);
        toast(t("selectedCover"));
      });
    });
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = t("search");
  }
}

async function createProfile(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const values = Object.fromEntries(new FormData(formElement));
  values.language = state.language;
  try {
    await api("./api/admin/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    });
    toast(t("profileCreated"));
    formElement.reset();
  } catch (error) {
    toast(error.message, true);
  }
}

async function uploadRom(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const game = await api("./api/admin/upload/rom", {
      method: "POST",
      body: form,
    });
    try {
      if (state.pendingCoverFile) {
        const coverForm = new FormData();
        coverForm.append("file", state.pendingCoverFile);
        await api(`./api/admin/games/${game.id}/cover`, {
          method: "PUT",
          body: coverForm,
        });
      } else if (state.pendingLibretroCover) {
        await api(`./api/admin/games/${game.id}/cover/from-libretro`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: state.pendingLibretroCover }),
        });
      }
    } catch (error) {
      toast(`${t("romAdded")}. ${error.message}`, true);
      formElement.reset();
      clearPendingCover();
      return;
    }
    toast(t("romAdded"));
    formElement.reset();
    clearPendingCover();
  } catch (error) {
    toast(error.message, true);
  }
}

async function uploadBios(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api("./api/admin/upload/bios", {
      method: "POST",
      body: form,
    });
    toast(t("biosUpdated"));
    formElement.reset();
  } catch (error) {
    toast(error.message, true);
  }
}

async function launchGame(gameId, restoreState = null) {
  try {
    let game;
    try {
      game = await api(`./api/games/${gameId}`);
    } catch (error) {
      if (navigator.onLine) throw error;
      game = state.games.find((item) => item.id === gameId);
      if (!game) throw error;
    }
    app.innerHTML = `
      <main class="player-view">
        <header class="player-toolbar">
          <strong>${escapeHtml(game.title)}</strong>
          <div class="row">
            <label class="row">${t("slot")}
              <select id="save-slot">${[1, 2, 3, 4, 5].map((slot) => `<option>${slot}</option>`).join("")}</select>
            </label>
            <button class="secondary" id="sync-saves">${t("syncSaves")}</button>
            <button class="secondary" id="local-storage">${t("localStorage")}</button>
            <button class="secondary" id="exit-player">${t("logout")}</button>
          </div>
        </header>
        <div class="player-stage"><div id="player"></div></div>
      </main>`;
    document
      .querySelector("#exit-player")
      .addEventListener("click", async () => {
        const exitButton = document.querySelector("#exit-player");
        exitButton.disabled = true;
        exitButton.textContent = t("saving");
        try {
          await stopEmulator();
        } catch (error) {
          toast(error.message, true);
        }
      });
    document
      .querySelector("#sync-saves")
      .addEventListener("click", syncCurrentSaves);
    document
      .querySelector("#local-storage")
      .addEventListener("click", manageLocalStorage);
    await startEmulator(game, restoreState);
  } catch (error) {
    toast(error.message, true);
  }
}

let currentGameId = null;
let closingEmulator = false;
let suppressNativeSaveUpload = false;
const runtimeBlobUrls = new Set();
const coverBlobUrls = new Set();

async function startEmulator(game, restoreState = null) {
  await releaseRuntimeBlobUrls();
  currentGameId = game.id;
  const romUrl = await resolveCachedAsset(
    "rom",
    game.hash,
    `./api/games/${game.id}/rom`,
    game.hash,
  );
  const biosUrl = game.biosUrl
    ? await resolveCachedAsset(
        "bios",
        game.biosHash || game.biosUrl,
        game.biosUrl,
        game.biosHash,
      )
    : undefined;
  window.EJS_currentGame = game;
  window.EJS_player = "#player";
  window.EJS_core = game.core;
  window.EJS_gameName = game.title;
  window.EJS_color = "#ff3b6b";
  window.EJS_backgroundImage = game.hasCover
    ? new URL(`./api/games/${game.id}/cover`, location.href).href
    : undefined;
  window.EJS_backgroundBlur = true;
  window.EJS_backgroundColor = "#050609";
  window.EJS_gameID = `${state.profileId}-${game.id}-${game.core}`;
  window.EJS_gameUrl = romUrl;
  window.EJS_biosUrl = biosUrl;
  window.EJS_loadStateURL = restoreState?.url || undefined;
  window.EJS_startOnLoaded = Boolean(restoreState?.url);
  window.EJS_pathtodata = new URL(
    "./vendor/emulatorjs/data/",
    location.href,
  ).href;
  window.EJS_threads = false;
  window.EJS_disableDatabases = true;
  window.EJS_disableLocalStorage = true;
  window.EJS_language = getLocale() === "en" ? "en-US" : "es-ES";
  window.EJS_startButtonName =
    getLocale() === "en" ? "START GAME" : "INICIAR JUEGO";
  window.EJS_onSaveState = uploadSaveState;
  window.EJS_onLoadState = loadSaveState;
  window.EJS_onSaveSave = uploadNativeSave;
  window.EJS_onLoadSave = loadNativeSave;
  window.EJS_onGameStart = () => {
    void loadNativeSave();
    if (restoreState) {
      setTimeout(() => {
        URL.revokeObjectURL(restoreState.url);
        toast(t("stateLoaded"));
      }, 1000);
    }
  };
  window.EJS_ready = () => {
    const emulator = window.EJS_emulator;
    const callEvent = emulator.callEvent.bind(emulator);
    emulator.callEvent = (event, data) => {
      const isExit = event === "exit";
      if (isExit) suppressNativeSaveUpload = true;
      const result = callEvent(event, data);
      if (isExit && !closingEmulator) {
        queueMicrotask(() => {
          void exitToLibrary(false);
        });
      }
      return result;
    };
    emulator.on("saveSaveFiles", (save) => {
      if (suppressNativeSaveUpload) return;
      void saveLocally("save", save).catch((error) =>
        toast(error.message, true),
      );
    });
  };
  const script = document.createElement("script");
  script.src = "./vendor/emulatorjs/data/loader.js";
  script.async = false;
  document.head.appendChild(script);
}

function selectedSlot() {
  return Number(document.querySelector("#save-slot")?.value || 1);
}

async function uploadSaveState({ state: save }) {
  await saveLocally("state", save);
  toast(t("stateSavedLocal"));
}

async function loadSaveState() {
  try {
    const local = await getLocalSave(
      state.profileId,
      currentGameId,
      "state",
      selectedSlot(),
    );
    const compatibleLocal = compatibleLocalSave(local, window.EJS_currentGame);
    if (!compatibleLocal) {
      const buffer = await fetchServerSave(
        "state",
        selectedSlot(),
        window.EJS_currentGame,
      );
      sessionStorage.setItem(
        "retro-web-pending-state",
        JSON.stringify({
          gameId: currentGameId,
          slot: selectedSlot(),
          source: "server",
        }),
      );
      await putLocalSave(
        state.profileId,
        window.EJS_currentGame,
        "state",
        selectedSlot(),
        buffer,
      );
    } else {
      sessionStorage.setItem(
        "retro-web-pending-state",
        JSON.stringify({
          gameId: currentGameId,
          slot: selectedSlot(),
          source: "local",
        }),
      );
    }
    location.reload();
  } catch (error) {
    toast(error.message, true);
  }
}

async function restorePendingLocalState() {
  const pendingValue = sessionStorage.getItem("retro-web-pending-state");
  if (!pendingValue || !state.profileId) return false;
  let pending;
  try {
    pending = JSON.parse(pendingValue);
  } catch {
    sessionStorage.removeItem("retro-web-pending-state");
    return false;
  }
  const save = await getLocalSave(
    state.profileId,
    pending.gameId,
    "state",
    pending.slot,
  );
  if (!save?.blob) {
    sessionStorage.removeItem("retro-web-pending-state");
    return false;
  }
  sessionStorage.removeItem("retro-web-pending-state");
  await launchGame(pending.gameId, {
    url: URL.createObjectURL(save.blob),
  });
  return true;
}

async function uploadNativeSave({ save }) {
  await saveLocally("save", save);
}

async function fetchServerSave(kind, slot, game) {
  const headers =
    kind === "state" ? stateHeaders(game) : { "x-profile-id": state.profileId };
  setPlayerBusy(true, t("syncingFromServer"));
  try {
    const meta = await api(
      `./api/games/${currentGameId}/saves/${kind}/${slot}/meta`,
      { headers },
    );
    const chunkSize = 1024 * 1024;
    const totalChunks = Math.ceil(meta.size / chunkSize);
    const chunks = [];
    for (let index = 0; index < totalChunks; index += 1) {
      chunks.push(
        await api(
          `./api/games/${currentGameId}/saves/${kind}/${slot}/chunk/${index}`,
          { headers },
        ),
      );
    }
    return new Blob(chunks).arrayBuffer();
  } finally {
    setPlayerBusy(false);
  }
}

function setPlayerBusy(busy, message = "") {
  const stage = document.querySelector(".player-stage");
  if (!stage) return;
  let overlay = stage.querySelector(".sync-overlay");
  if (!busy) {
    overlay?.remove();
    stage.removeAttribute("aria-busy");
    document
      .querySelectorAll(".player-toolbar button, .player-toolbar select")
      .forEach((element) => {
        element.disabled = false;
      });
    const emulatorControls = document.querySelector("#player .ejs_game");
    if (emulatorControls) emulatorControls.style.pointerEvents = "";
    return;
  }
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "sync-overlay";
    overlay.innerHTML = `
      <div class="sync-card">
        <span class="sync-spinner" aria-hidden="true"></span>
        <strong>${escapeHtml(message)}</strong>
      </div>`;
    stage.appendChild(overlay);
  } else {
    overlay.querySelector("strong").textContent = message;
  }
  stage.setAttribute("aria-busy", "true");
  document
    .querySelectorAll(".player-toolbar button, .player-toolbar select")
    .forEach((element) => {
      element.disabled = true;
    });
  const emulatorControls = document.querySelector("#player .ejs_game");
  if (emulatorControls) emulatorControls.style.pointerEvents = "none";
}

async function loadNativeSave() {
  try {
    const local = await getLocalSave(state.profileId, currentGameId, "save", 1);
    const compatibleLocal = compatibleLocalSave(local, window.EJS_currentGame);
    const buffer = compatibleLocal
      ? await local.blob.arrayBuffer()
      : await fetchServerSave("save", 1, window.EJS_currentGame);
    const manager = window.EJS_emulator?.gameManager;
    if (!manager) return;
    const savePath = manager.getSaveFilePath();
    const parts = savePath.split("/");
    let current = "";
    for (const part of parts.slice(0, -1)) {
      if (!part) continue;
      current += `/${part}`;
      if (!manager.FS.analyzePath(current).exists) manager.FS.mkdir(current);
    }
    if (manager.FS.analyzePath(savePath).exists) manager.FS.unlink(savePath);
    manager.FS.writeFile(savePath, new Uint8Array(buffer));
    manager.loadSaveFiles();
  } catch (error) {
    if (error.status !== 404) toast(error.message, true);
  }
}

async function flushNativeSave() {
  const manager = window.EJS_emulator?.gameManager;
  if (!manager) return;
  const save = await manager.getSaveFile();
  if (!save || save.byteLength === 0) return;
  await saveLocally("save", save);
}

async function stopEmulator() {
  await exitToLibrary(true);
}

async function exitToLibrary(saveNativeSave) {
  if (closingEmulator) return;
  closingEmulator = true;
  suppressNativeSaveUpload = true;
  try {
    if (saveNativeSave) await flushNativeSave();
  } catch (error) {
    toast(error.message, true);
  } finally {
    const emulator = window.EJS_emulator;
    emulator?.pause?.();
    if (saveNativeSave) emulator?.callEvent?.("exit");
    document.querySelector("#player")?.replaceChildren();
    window.EJS_emulator = undefined;
    window.EJS_player = undefined;
    window.EJS_currentGame = undefined;
    await releaseRuntimeBlobUrls();
    await loadLibrary();
    closingEmulator = false;
    suppressNativeSaveUpload = false;
  }
}

async function saveLocally(kind, save) {
  if (!save || save.byteLength === 0) return;
  const slot = kind === "save" ? 1 : selectedSlot();
  await putLocalSave(state.profileId, window.EJS_currentGame, kind, slot, save);
}

async function syncCurrentSaves() {
  const button = document.querySelector("#sync-saves");
  if (button) button.disabled = true;
  setPlayerBusy(true, t("syncingSaves"));
  try {
    const localSaves = await listLocalSaves(state.profileId, currentGameId);
    if (!localSaves.length) {
      toast(t("noLocalSaves"), true);
      return;
    }
    let uploaded = 0;
    for (const local of localSaves) {
      if (await uploadLocalSaveIfConfirmed(local, window.EJS_currentGame)) {
        uploaded += 1;
      }
    }
    toast(uploaded ? `${t("syncComplete")}: ${uploaded}` : t("syncNotNeeded"));
  } catch (error) {
    toast(error.message, true);
  } finally {
    setPlayerBusy(false);
    if (button) button.disabled = false;
  }
}

async function uploadLocalSaveIfConfirmed(local, game) {
  let remote;
  try {
    remote = await api(
      `./api/games/${currentGameId}/saves/${local.kind}/${local.slot}/meta`,
      {
        headers:
          local.kind === "state"
            ? stateHeaders(game)
            : { "x-profile-id": state.profileId },
      },
    );
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (remote?.hash === local.hash) return false;
  if (
    remote &&
    !window.confirm(
      [
        t("syncConflict"),
        `${t("serverSave")}: ${remote.updatedAt}`,
        `${t("localSave")}: ${new Date(local.updatedAt).toISOString()}`,
        t("replaceServerSave"),
      ].join("\n"),
    )
  ) {
    return false;
  }
  await uploadChunkedSave(local, game, remote?.hash || "none");
  return true;
}

async function uploadChunkedSave(local, game, ifMatchSaveHash) {
  const chunkSize = 1024 * 1024;
  const buffer = await local.blob.arrayBuffer();
  const totalChunks = Math.ceil(buffer.byteLength / chunkSize);
  const base = `./api/games/${currentGameId}/saves/${local.kind}/${local.slot}/chunked`;
  const start = await api(`${base}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      totalSize: buffer.byteLength,
      totalChunks,
      hash: local.hash,
      ifMatchSaveHash,
      emulatorVersion: game?.emulatorVersion || "4.2.3",
      core: game?.core || "",
      romHash: game?.hash || "",
    }),
  });
  for (let index = 0; index < totalChunks; index += 1) {
    const from = index * chunkSize;
    const chunk = buffer.slice(
      from,
      Math.min(from + chunkSize, buffer.byteLength),
    );
    await api(`${base}/${start.uploadId}/${index}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: chunk,
    });
  }
  await api(`${base}/${start.uploadId}/finish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

async function manageLocalStorage() {
  try {
    const usage = await getStorageUsage(state.profileId);
    const message = [
      `${t("localAssets")}: ${formatBytes(usage.assets)}`,
      `${t("localSaves")}: ${formatBytes(usage.saves)}`,
      `${t("totalLocalStorage")}: ${formatBytes(usage.total)}`,
      "",
      t("clearLocalAssetsQuestion"),
    ].join("\n");
    if (window.confirm(message)) {
      await clearProfileAssets(state.profileId);
      await releaseRuntimeBlobUrls();
      toast(t("localAssetsCleared"));
    }
    if (usage.saves && window.confirm(t("clearLocalSavesQuestion"))) {
      await clearProfileSaves(state.profileId);
      toast(t("localSavesCleared"));
    }
  } catch (error) {
    toast(error.message, true);
  }
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function stateHeaders(game) {
  return {
    "x-profile-id": state.profileId,
    "x-retro-core": game?.core || "",
    "x-retro-emulator-version": game?.emulatorVersion || "4.2.3",
    "x-retro-rom-hash": game?.hash || "",
  };
}

function compatibleLocalSave(save, game) {
  return (
    save?.blob &&
    save.core === game?.core &&
    save.romHash === game?.hash &&
    save.emulatorVersion === game?.emulatorVersion
  );
}

async function resolveCachedAsset(kind, identifier, url, expectedHash = null) {
  const cached = await getCachedAsset(state.profileId, kind, identifier);
  if (cached?.blob && (!expectedHash || cached.hash === expectedHash)) {
    const objectUrl = URL.createObjectURL(cached.blob);
    runtimeBlobUrls.add(objectUrl);
    return objectUrl;
  }

  const arrayBuffer = await api(url, {
    headers: { "x-profile-id": state.profileId },
  });
  const blob = new Blob([arrayBuffer], { type: "application/octet-stream" });
  const record = await cacheAsset(
    state.profileId,
    kind,
    identifier,
    { expectedHash },
    blob,
  );
  if (expectedHash && record.hash !== expectedHash) {
    throw new Error("Downloaded resource does not match its expected hash");
  }
  const objectUrl = URL.createObjectURL(blob);
  runtimeBlobUrls.add(objectUrl);
  return objectUrl;
}

async function hydrateCachedCovers() {
  for (const url of coverBlobUrls) URL.revokeObjectURL(url);
  coverBlobUrls.clear();
  for (const game of state.games.filter((item) => item.has_cover)) {
    const identifier = `${game.id}:${game.cover_updated_at || "current"}`;
    let cached = await getCachedAsset(state.profileId, "cover", identifier);
    if (!cached?.blob && navigator.onLine) {
      try {
        const buffer = await api(`./api/games/${game.id}/cover`, {
          headers: { "x-profile-id": state.profileId },
        });
        cached = await cacheAsset(
          state.profileId,
          "cover",
          identifier,
          {},
          new Blob([buffer]),
        );
      } catch (error) {
        console.warn("[Retro Web] Cover cache failed", error);
      }
    }
    const image = document.querySelector(`[data-cover-game="${game.id}"]`);
    if (!image || !cached?.blob) continue;
    const objectUrl = URL.createObjectURL(cached.blob);
    coverBlobUrls.add(objectUrl);
    image.src = objectUrl;
    image.hidden = false;
    image.nextElementSibling.hidden = true;
  }
}

async function releaseRuntimeBlobUrls() {
  for (const url of runtimeBlobUrls) URL.revokeObjectURL(url);
  runtimeBlobUrls.clear();
}

boot();
