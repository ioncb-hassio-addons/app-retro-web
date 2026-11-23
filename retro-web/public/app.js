import { detectLocale, getLocale, setLocale, t } from "./i18n.js";

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
    if (state.bootstrap.external && !state.bootstrap.authenticated) {
      renderLogin();
      return;
    }
    renderProfiles();
  } catch (error) {
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
}

function gameCard(game) {
  return `
    <button class="game-card" data-game="${escapeHtml(game.id)}">
      <div class="cover">
        ${
          game.has_cover
            ? `<img src="./api/games/${encodeURIComponent(game.id)}/cover" alt="${escapeHtml(game.title)}" loading="lazy" /><span class="cover-fallback" hidden>🕹️</span>`
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

async function launchGame(gameId) {
  try {
    const game = await api(`./api/games/${gameId}`);
    app.innerHTML = `
      <main class="player-view">
        <header class="player-toolbar">
          <strong>${escapeHtml(game.title)}</strong>
          <div class="row">
            <label class="row">${t("slot")}
              <select id="save-slot">${[1, 2, 3, 4, 5].map((slot) => `<option>${slot}</option>`).join("")}</select>
            </label>
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
    await startEmulator(game);
  } catch (error) {
    toast(error.message, true);
  }
}

let currentGameId = null;
let closingEmulator = false;
let suppressNativeSaveUpload = false;
let restoringState = false;
let restoreFailureCleanup = null;

async function startEmulator(game, loadStateUrl = null) {
  currentGameId = game.id;
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
  window.EJS_gameUrl = `./api/games/${game.id}/rom`;
  window.EJS_biosUrl = game.biosUrl || undefined;
  window.EJS_loadStateURL = loadStateUrl || undefined;
  window.EJS_startOnLoaded = Boolean(loadStateUrl);
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
    if (restoringState) {
      setTimeout(() => {
        restoreFailureCleanup?.();
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
      void uploadBinarySave("save", save).catch((error) =>
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
  await uploadBinarySave("state", save);
  toast(t("stateSaved"));
}

async function loadSaveState() {
  try {
    const game = window.EJS_currentGame;
    const buffer = await api(
      `./api/games/${currentGameId}/saves/state/${selectedSlot()}`,
      {
        headers: stateHeaders(game),
      },
    );
    restoringState = true;
    const stateUrl = URL.createObjectURL(
      new Blob([buffer], { type: "application/octet-stream" }),
    );
    const cleanup = () => {
      window.removeEventListener("error", handleRestoreFailure);
      URL.revokeObjectURL(stateUrl);
      restoreFailureCleanup = null;
      restoringState = false;
      suppressNativeSaveUpload = false;
    };
    restoreFailureCleanup = cleanup;
    window.addEventListener("error", handleRestoreFailure);
    const previousEmulator = window.EJS_emulator;
    previousEmulator?.pause?.();
    closingEmulator = true;
    suppressNativeSaveUpload = true;
    document.querySelector("#player")?.replaceChildren();
    window.EJS_emulator = undefined;
    closingEmulator = false;
    await startEmulator(game, stateUrl);
    // Keep the previous runtime paused until this page changes. Aborting it
    // during the new loader race removes #player before EmulatorJS initializes.
  } catch (error) {
    restoreFailureCleanup?.();
    toast(error.message, true);
  }
}

function handleRestoreFailure(event) {
  if (!restoringState) return;
  const message = String(event.error?.message || event.message || "");
  console.warn("[Retro Web] Restore error event", {
    message,
    type: event.type,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    restoringState,
  });
  if (!/memory access out of bounds/i.test(message)) return;
  event.preventDefault();
  restoreFailureCleanup?.();
  toast(t("stateRestoreFailed"), true);
  void exitToLibrary(false);
}

async function uploadNativeSave({ save }) {
  await uploadBinarySave("save", save);
}

async function loadNativeSave() {
  try {
    const buffer = await api(`./api/games/${currentGameId}/saves/save/1`, {
      headers: { "x-profile-id": state.profileId },
    });
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
  await uploadBinarySave("save", save);
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
    await loadLibrary();
    closingEmulator = false;
    suppressNativeSaveUpload = false;
  }
}

async function uploadBinarySave(kind, save) {
  if (!save || save.byteLength === 0) return;
  const slot = kind === "save" ? 1 : selectedSlot();
  await api(`./api/games/${currentGameId}/saves/${kind}/${slot}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-profile-id": state.profileId,
      ...(kind === "state" ? stateHeaders(window.EJS_currentGame) : {}),
    },
    body: save,
  });
}

function stateHeaders(game) {
  return {
    "x-profile-id": state.profileId,
    "x-retro-core": game?.core || "",
    "x-retro-emulator-version": "4.2.3",
    "x-retro-rom-hash": game?.hash || "",
  };
}

boot();
