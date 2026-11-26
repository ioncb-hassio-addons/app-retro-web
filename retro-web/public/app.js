import { detectLocale, getLocale, setLocale, t, tf } from "./i18n.js";
import {
  cacheAsset,
  clearProfileAssets,
  clearProfileAssetKinds,
  clearCurrentGameSaves,
  clearProfileSaves,
  deleteLocalSave,
  getCachedAsset,
  compatibleLocalSave,
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
  libraryPlatform: null,
  autoplaySaveSlot: 1,
  screen: "profiles",
  scrollPositions: new Map(),
  systemAvatars: [],
  pendingProfileAvatar: "🎮",
  pendingProfileAvatarFile: null,
  pendingProfileAvatarPreviewUrl: null,
};

function getViewKey() {
  if (state.screen === "library") {
    return `library:${state.profileId || "none"}:${state.libraryPlatform || "all"}`;
  }
  if (state.screen === "player") {
    return `player:${currentGameId || "none"}`;
  }
  return state.screen;
}

function rememberCurrentViewScroll(viewKey = getViewKey()) {
  state.scrollPositions.set(viewKey, window.scrollY);
}

function restoreViewScroll(viewKey = getViewKey()) {
  const scrollTop = state.scrollPositions.get(viewKey) || 0;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.scrollTo({ top: scrollTop, left: 0, behavior: "auto" });
    });
  });
}

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

function profileAvatarMarkup(profile, className = "profile-avatar") {
  if (profile?.avatar === "custom") {
    return `<span class="${className}"><img src="${escapeHtml(`./api/profiles/${profile.id}/avatar`)}" alt="${escapeHtml(profile.name)}" /></span>`;
  }
  if (/^avatar_\d{2}\.webp$/i.test(profile?.avatar || "")) {
    return `<span class="${className}"><img src="${escapeHtml(`./api/avatars/${profile.avatar}`)}" alt="${escapeHtml(profile.name)}" /></span>`;
  }
  return `<span class="${className}">${escapeHtml(profile?.avatar || "🎮")}</span>`;
}

async function loadSystemAvatars() {
  try {
    state.systemAvatars = await api("./api/avatars");
  } catch (error) {
    state.systemAvatars = [];
    console.warn("[Retro Web] Could not load system avatars", error);
  }
}

async function convertProfileAvatarToWebp(file) {
  if (!file?.type?.startsWith("image/")) {
    throw new Error(t("avatarImageRequired"));
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(t("avatarImageRequired")));
      element.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 345;
    canvas.height = 345;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("avatarImageRequired"));
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - side) / 2;
    const sourceY = (image.naturalHeight - side) / 2;
    context.drawImage(image, sourceX, sourceY, side, side, 0, 0, 345, 345);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(new Error(t("avatarImageRequired"))),
        "image/webp",
        0.92,
      );
    });
    return new File([blob], "avatar.webp", { type: "image/webp" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function systemAvatarOptions(selectedAvatar, onSelect) {
  return `
    <div class="avatar-picker">
      <button type="button" class="avatar-option${selectedAvatar === "🎮" ? " selected" : ""}" data-avatar-value="🎮" aria-label="${escapeHtml(t("defaultAvatar"))}">
        <span>🎮</span>
      </button>
      ${state.systemAvatars
        .map(
          (avatar) => `
            <button type="button" class="avatar-option${selectedAvatar === avatar ? " selected" : ""}" data-avatar-value="${escapeHtml(avatar)}" aria-label="${escapeHtml(avatar)}">
              <img src="${escapeHtml(`./api/avatars/${avatar}`)}" alt="" />
            </button>`,
        )
        .join("")}
    </div>
  `;
}

function bindProfileAvatarPicker(containerId, initialAvatar, onChange) {
  const container = document.querySelector(containerId);
  if (!container) return;
  let selectedAvatar = initialAvatar || "🎮";
  container.innerHTML = `
    <strong>${t("systemAvatars")}</strong>
    ${systemAvatarOptions(selectedAvatar)}
    <label class="avatar-upload">
      ${t("uploadCustomAvatar")}
      <input type="file" accept="image/png,image/jpeg,image/webp" />
    </label>
    <div class="avatar-preview"></div>
  `;
  container.querySelectorAll("[data-avatar-value]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedAvatar = button.dataset.avatarValue;
      container.querySelectorAll("[data-avatar-value]").forEach((option) => {
        option.classList.toggle(
          "selected",
          option.dataset.avatarValue === selectedAvatar,
        );
      });
      const preview = container.querySelector(".avatar-preview");
      if (preview) preview.innerHTML = "";
      onChange?.({ avatar: selectedAvatar, file: null });
    });
  });
  container
    .querySelector("input[type=file]")
    ?.addEventListener("change", async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      try {
        const webpFile = await convertProfileAvatarToWebp(file);
        selectedAvatar = "custom";
        container.querySelectorAll("[data-avatar-value]").forEach((option) => {
          option.classList.remove("selected");
        });
        const preview = container.querySelector(".avatar-preview");
        if (preview) {
          const objectUrl = URL.createObjectURL(webpFile);
          preview.innerHTML = `<img src="${objectUrl}" alt="${escapeHtml(t("customAvatar"))}" />`;
        }
        onChange?.({ avatar: "custom", file: webpFile });
      } catch (error) {
        toast(error.message, true);
        event.currentTarget.value = "";
      }
    });
}

async function openProfileAvatarDialog(profile) {
  await loadSystemAvatars();
  let selectedAvatar = profile.avatar || "🎮";
  let selectedFile = null;
  const dialog = document.createElement("dialog");
  dialog.className = "retro-dialog profile-avatar-dialog";
  dialog.innerHTML = `
    <form method="dialog">
      <h2>${escapeHtml(t("profileImage"))}</h2>
      <p>${escapeHtml(profile.name)}</p>
      <div id="existing-profile-avatar-picker">
        <strong>${t("systemAvatars")}</strong>
        ${systemAvatarOptions(selectedAvatar)}
        <label class="avatar-upload">
          ${t("uploadCustomAvatar")}
          <input type="file" accept="image/png,image/jpeg,image/webp" />
        </label>
        <div class="avatar-preview">
          ${
            selectedAvatar === "custom"
              ? `<img src="${escapeHtml(`./api/profiles/${profile.id}/avatar`)}" alt="${escapeHtml(t("customAvatar"))}" />`
              : ""
          }
        </div>
      </div>
      <div class="dialog-actions">
        <button class="secondary" value="cancel">${t("cancel")}</button>
        <button class="primary" value="save">${t("saveAvatar")}</button>
      </div>
    </form>`;
  const cleanup = () => dialog.remove();
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "save") {
      cleanup();
      return;
    }
    const form = new FormData();
    form.append("avatar", selectedAvatar);
    if (selectedFile) form.append("avatarFile", selectedFile);
    try {
      const updated = await api(`./api/admin/profiles/${profile.id}`, {
        method: "PATCH",
        body: form,
      });
      const existing = state.bootstrap.profiles.find(
        (item) => item.id === profile.id,
      );
      if (existing) Object.assign(existing, updated);
      toast(t("profileUpdated"));
      cleanup();
      renderAdmin();
    } catch (error) {
      toast(error.message, true);
      cleanup();
    }
  });
  dialog.querySelectorAll("[data-avatar-value]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedAvatar = button.dataset.avatarValue;
      selectedFile = null;
      dialog.querySelectorAll("[data-avatar-value]").forEach((option) => {
        option.classList.toggle(
          "selected",
          option.dataset.avatarValue === selectedAvatar,
        );
      });
      const preview = dialog.querySelector(".avatar-preview");
      if (preview) preview.innerHTML = "";
    });
  });
  dialog
    .querySelector("input[type=file]")
    ?.addEventListener("change", async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      try {
        selectedFile = await convertProfileAvatarToWebp(file);
        selectedAvatar = "custom";
        dialog.querySelectorAll("[data-avatar-value]").forEach((option) => {
          option.classList.remove("selected");
        });
        const preview = dialog.querySelector(".avatar-preview");
        if (preview) {
          const objectUrl = URL.createObjectURL(selectedFile);
          preview.innerHTML = `<img src="${objectUrl}" alt="${escapeHtml(t("customAvatar"))}" />`;
        }
      } catch (error) {
        toast(error.message, true);
        event.currentTarget.value = "";
      }
    });
  document.body.appendChild(dialog);
  dialog.showModal();
}

function platformLogoUrl(platform) {
  const logos = {
    arcade: "arcade",
    nes: "nes",
    snes: "snes",
    gb: "gbc",
    gba: "gba",
    n64: "n64",
  };
  const logo = logos[String(platform || "").toLowerCase()];
  return logo ? `./platforms/${logo}.webp` : null;
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
                ${profileAvatarMarkup(profile)}
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
  restoreViewScroll();
}

async function selectProfile(profileId) {
  try {
    rememberCurrentViewScroll("profiles");
    state.libraryPlatform = null;
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
      rememberCurrentViewScroll();
      if (state.screen === "library") renderLibrary();
      else renderProfiles();
    });
}

async function renderLibrary() {
  state.screen = "library";
  const profile = currentProfile();
  const adminActions = state.bootstrap.external
    ? state.bootstrap.externalAdminEnabled
      ? `<button class="secondary" id="admin-button">${t("administer")}</button>`
      : ""
    : `<button class="secondary" id="admin-button">${t("administer")}</button>`;
  let continueGames = [];
  if (state.profileId) {
    try {
      const localSaves = await listLocalSaves(state.profileId);
      const recentByGame = new Map();
      for (const save of localSaves) {
        const existing = recentByGame.get(save.gameId);
        if (!existing || save.updatedAt > existing.updatedAt) {
          recentByGame.set(save.gameId, save);
        }
      }
      continueGames = [...recentByGame.values()]
        .map((save) => state.games.find((game) => game.id === save.gameId))
        .filter(Boolean)
        .sort((left, right) => {
          const leftSave = recentByGame.get(left.id)?.updatedAt || 0;
          const rightSave = recentByGame.get(right.id)?.updatedAt || 0;
          return rightSave - leftSave;
        });
    } catch (error) {
      console.warn("[Retro Web] Could not read recent local games", error);
    }
  }
  const recentlyAdded = [...state.games]
    .sort(
      (left, right) =>
        new Date(right.created_at).getTime() -
        new Date(left.created_at).getTime(),
    )
    .slice(0, 20);
  const platformCounts = new Map();
  for (const game of state.games) {
    platformCounts.set(
      game.platform,
      (platformCounts.get(game.platform) || 0) + 1,
    );
  }
  const platformLabels = new Map(
    state.platforms.map((platform) => [platform.id, platform.label]),
  );
  const selectedPlatform = state.libraryPlatform;
  const selectedGames = selectedPlatform
    ? state.games.filter((game) => game.platform === selectedPlatform)
    : [];
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span>🎮</span><strong>Retro Web</strong></div>
      <div class="topbar-actions">
        ${languageSelector()}
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
      <nav class="breadcrumb-navigation" aria-label="${t("profiles")}">
        <button type="button" class="breadcrumb-link" id="back-profiles-library">${t("profiles")}</button>
        <span class="breadcrumb-separator" aria-hidden="true">/</span>
        <span class="breadcrumb-current">${escapeHtml(profile?.name || t("profile"))}</span>
        <span class="breadcrumb-separator" aria-hidden="true">/</span>
        ${
          selectedPlatform
            ? `<button type="button" class="breadcrumb-link" id="back-library">${t("library")}</button>
               <span class="breadcrumb-separator" aria-hidden="true">/</span>
               <span class="breadcrumb-current">${escapeHtml(platformLabels.get(selectedPlatform) || selectedPlatform.toUpperCase())}</span>`
            : `<span class="breadcrumb-current">${t("library")}</span>`
        }
      </nav>
      ${
        selectedPlatform
          ? `
            <h2 class="section-title">${escapeHtml(platformLabels.get(selectedPlatform) || selectedPlatform.toUpperCase())}</h2>
            ${
              selectedGames.length
                ? `<section class="game-grid">${selectedGames.map(gameCard).join("")}</section>`
                : `<section class="empty-state"><h2>${t("noGames")}</h2></section>`
            }`
          : `
            ${
              continueGames.length
                ? `<h2 class="section-title">${t("continuePlaying")}</h2>
                   <section class="game-grid">${continueGames.map(gameCard).join("")}</section>`
                : ""
            }
            ${
              platformCounts.size
                ? `<h2 class="section-title">${t("platforms")}</h2>
                   <section class="platform-grid">${[
                     ...platformCounts.entries(),
                   ]
                     .map(
                       ([platform, count]) => `
                     <button class="platform-card" data-platform="${escapeHtml(platform)}">
                       <img class="platform-card-logo" src="${escapeHtml(platformLogoUrl(platform))}" alt="${escapeHtml(platformLabels.get(platform) || platform.toUpperCase())}" loading="lazy" />
                       <div class="platform-card-info">
                         <strong>${escapeHtml(platformLabels.get(platform) || platform.toUpperCase())}</strong>
                         <span>${tf(count === 1 ? "gameCount" : "gamesCount", { count })}</span>
                       </div>
                     </button>`,
                     )
                     .join("")}</section>`
                : ""
            }
            ${
              recentlyAdded.length
                ? `<h2 class="section-title">${t("recentlyAdded")}</h2>
                   <section class="game-grid">${recentlyAdded.map(gameCard).join("")}</section>`
                : ""
            }
            ${
              !state.games.length
                ? `<section class="empty-state"><h2>${t("noGames")}</h2><p class="muted">${t("noGamesHelp")}</p></section>`
                : ""
            }`
      }
    </main>`;
  document
    .querySelector("#back-profiles-library")
    ?.addEventListener("click", () => {
      rememberCurrentViewScroll();
      renderProfiles();
    });
  document.querySelector("#admin-button")?.addEventListener("click", openAdmin);
  document.querySelector("#logout-button")?.addEventListener("click", logout);
  document.querySelectorAll("[data-game]").forEach((button) => {
    button.addEventListener("click", () => launchGame(button.dataset.game));
  });
  document.querySelectorAll("[data-platform]").forEach((button) => {
    button.addEventListener("click", () => {
      rememberCurrentViewScroll();
      state.libraryPlatform = button.dataset.platform;
      void renderLibrary();
    });
  });
  document.querySelector("#back-library")?.addEventListener("click", () => {
    rememberCurrentViewScroll();
    state.libraryPlatform = null;
    void renderLibrary();
  });
  document.querySelectorAll(".cover img").forEach((image) => {
    image.addEventListener("error", () => {
      image.hidden = true;
      image.nextElementSibling.hidden = false;
    });
  });
  bindLanguageSelector();
  void hydrateCachedCovers();
  restoreViewScroll();
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
  rememberCurrentViewScroll();
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

async function renderAdmin() {
  state.screen = "admin";
  await loadSystemAvatars();
  state.pendingProfileAvatar = "🎮";
  state.pendingProfileAvatarFile = null;
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
            <div id="new-profile-avatar-picker"></div>
            <label>${t("color")}<input name="color" type="color" value="#5b8def" /></label>
            <button class="primary" type="submit">${t("createProfile")}</button>
          </form>
        </section>
        <section class="panel profile-admin-list-panel">
          <h2>${t("profiles")}</h2>
          <div class="profile-admin-list">
            ${state.bootstrap.profiles
              .map(
                (profile) => `
                  <div class="profile-admin-card" style="--profile-color:${escapeHtml(profile.color)}">
                    ${profileAvatarMarkup(profile, "profile-avatar")}
                    <strong>${escapeHtml(profile.name)}</strong>
                    <button type="button" class="secondary" data-edit-profile-avatar="${escapeHtml(profile.id)}">${t("changeProfileImage")}</button>
                  </div>`,
              )
              .join("")}
          </div>
        </section>
        <section class="panel system-avatar-admin-panel">
          <h2>${t("systemAvatars")}</h2>
          <p class="muted">${t("systemAvatarsHelp")}</p>
          <form id="system-avatar-form">
            <label>${t("systemAvatarFile")}
              <input name="file" type="file" accept="image/webp" required />
            </label>
            <label>${t("systemAvatarFilename")}
              <input name="filename" value="avatar_02.webp" pattern="avatar_[0-9]{2}\\.webp" maxlength="13" required />
            </label>
            <button class="primary" type="submit">${t("uploadSystemAvatar")}</button>
          </form>
          <div class="system-avatar-admin-list">
            ${state.systemAvatars
              .map(
                (avatar) => `
                  <div class="system-avatar-admin-card">
                    <img src="${escapeHtml(`./api/avatars/${avatar}`)}" alt="" />
                    <strong>${escapeHtml(avatar)}</strong>
                    <button type="button" class="danger" data-delete-system-avatar="${escapeHtml(avatar)}">${t("delete")}</button>
                  </div>`,
              )
              .join("")}
          </div>
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
        <section class="panel">
          <h2>Indexación de archivos</h2>
          <p class="muted">Coloca las ROMs en <code>/data/roms/&lt;plataforma&gt;/</code> y las BIOS en <code>/data/bios/&lt;plataforma&gt;/</code>. Después ejecuta la indexación.</p>
          <button class="primary" id="reindex-now" type="button">${t("reindexNow")}</button>
          <div id="index-status" class="muted" style="margin-top:1rem">${t("reindexNever")}</div>
        </section>
      </div>
    </main>`;
  bindProfileAvatarPicker(
    "#new-profile-avatar-picker",
    "🎮",
    ({ avatar, file }) => {
      state.pendingProfileAvatar = avatar;
      state.pendingProfileAvatarFile = file;
    },
  );
  document.querySelectorAll("[data-edit-profile-avatar]").forEach((button) => {
    button.addEventListener("click", () => {
      const profile = state.bootstrap.profiles.find(
        (item) => item.id === button.dataset.editProfileAvatar,
      );
      if (profile) void openProfileAvatarDialog(profile);
    });
  });
  document.querySelector("#back-button").addEventListener("click", async () => {
    rememberCurrentViewScroll("admin");
    state.bootstrap.profiles = await api("./api/profiles");
    if (!state.bootstrap.external)
      state.platforms = await api("./api/admin/platforms");
    loadLibrary();
  });
  document
    .querySelector("#profile-form")
    .addEventListener("submit", createProfile);
  document
    .querySelector("#system-avatar-form")
    ?.addEventListener("submit", uploadSystemAvatar);
  document.querySelectorAll("[data-delete-system-avatar]").forEach((button) => {
    button.addEventListener("click", () =>
      deleteSystemAvatar(button.dataset.deleteSystemAvatar),
    );
  });
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
  document
    .querySelector("#reindex-now")
    ?.addEventListener("click", runManualReindex);
  void refreshIndexStatus();
  restoreViewScroll();
}

async function refreshIndexStatus() {
  const statusElement = document.querySelector("#index-status");
  if (!statusElement) return;
  try {
    const status = await api("./api/admin/index/status");
    if (status.running) {
      statusElement.textContent = t("reindexing");
      return;
    }
    const lastRun = status.lastRun;
    if (!lastRun) {
      statusElement.textContent = t("reindexNever");
      return;
    }
    const duration =
      lastRun.duration_ms == null ? "" : ` · ${lastRun.duration_ms} ms`;
    statusElement.textContent = `${new Date(lastRun.started_at).toLocaleString()} · ${lastRun.status}${duration} · ${tf(
      "reindexFiles",
      {
        newFiles: lastRun.new_files,
        changedFiles: lastRun.changed_files,
        errors: lastRun.error_files,
      },
    )}`;
  } catch (error) {
    statusElement.textContent = error.message;
  }
}

async function runManualReindex() {
  const button = document.querySelector("#reindex-now");
  if (button) {
    button.disabled = true;
    button.textContent = t("reindexing");
  }
  try {
    await api("./api/admin/index/run", { method: "POST" });
    toast(t("reindexEnqueued"));
    await refreshIndexStatus();
  } catch (error) {
    toast(error.status === 409 ? t("reindexRunning") : error.message, true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = t("reindexNow");
    }
  }
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
  const form = new FormData();
  form.append("name", formElement.elements.name.value);
  form.append("color", formElement.elements.color.value);
  form.append("language", state.language);
  form.append("avatar", state.pendingProfileAvatar || "🎮");
  if (state.pendingProfileAvatarFile) {
    form.append("avatarFile", state.pendingProfileAvatarFile);
  }
  try {
    const profile = await api("./api/admin/profiles", {
      method: "POST",
      body: form,
    });
    state.bootstrap.profiles.push(profile);
    toast(t("profileCreated"));
    formElement.reset();
    state.pendingProfileAvatar = "🎮";
    state.pendingProfileAvatarFile = null;
    bindProfileAvatarPicker(
      "#new-profile-avatar-picker",
      "🎮",
      ({ avatar, file }) => {
        state.pendingProfileAvatar = avatar;
        state.pendingProfileAvatarFile = file;
      },
    );
    await renderAdmin();
  } catch (error) {
    toast(error.message, true);
  }
}

async function uploadSystemAvatar(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api("./api/admin/avatars", {
      method: "POST",
      body: form,
    });
    toast(t("systemAvatarUploaded"));
    await renderAdmin();
  } catch (error) {
    toast(error.message, true);
  }
}

async function deleteSystemAvatar(filename) {
  const choice = await showConfirmDialog({
    title: t("deleteSystemAvatar"),
    message: tf("deleteSystemAvatarConfirm", { filename }),
    primary: t("yes"),
    secondary: t("no"),
  });
  if (choice !== "primary") return;
  try {
    await api(`./api/admin/avatars/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    });
    toast(t("systemAvatarDeleted"));
    await renderAdmin();
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
    if (navigator.onLine) {
      void api(`./api/games/${gameId}/progress`, {
        method: "POST",
      }).catch((error) =>
        console.warn("[Retro Web] Could not update recent activity", error),
      );
    }
    rememberCurrentViewScroll();
    state.screen = "player";
    currentGameId = game.id;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
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
        try {
          if (emulatorError) {
            await destroyEmulatorInstance();
            await loadLibrary();
            return;
          }
          if (!isEmulatorStarted()) {
            await teardownEmulatorForAssetReset();
            await loadLibrary();
            return;
          }
          const choice = await showConfirmDialog({
            title: t("confirmExit"),
            message: escapeHtml(
              "Guarda el estado actual antes de volver a la biblioteca.",
            ),
            primary: t("saveAndExit"),
            secondary: t("exitGame"),
            cancel: t("cancel"),
          });
          if (choice === "cancel" || !choice) return;
          if (choice === "primary") {
            exitButton.textContent = t("saving");
            await saveAutoStateForExit();
          }
          await destroyEmulatorInstance();
          await loadLibrary();
        } catch (error) {
          toast(error.message, true);
        } finally {
          const currentButton = document.querySelector("#exit-player");
          if (currentButton) currentButton.disabled = false;
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
let emulatorError = false;
let initialStateApplied = false;
let assetsCacheCleared = false;
let emulatorHasStarted = false;
const runtimeBlobUrls = new Set();
const coverBlobUrls = new Set();

function showConfirmDialog({
  title,
  message,
  details = [],
  actions = [],
  primary,
  secondary,
  cancel,
}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "retro-dialog";
    dialog.innerHTML = `
      <form method="dialog">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        ${
          details.length
            ? `<dl class="dialog-details">${details
                .map(
                  ([label, value]) =>
                    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
                )
                .join("")}</dl>`
            : ""
        }
        <div class="dialog-actions">
          ${
            actions.length
              ? `<div class="dialog-action-grid">${actions
                  .map(
                    (action) =>
                      `<button class="secondary" value="${escapeHtml(action.id)}"${action.disabled ? " disabled" : ""}>${escapeHtml(action.label)}</button>`,
                  )
                  .join("")}</div>`
              : ""
          }
          ${
            primary
              ? `<button class="primary" value="primary">${escapeHtml(primary)}</button>`
              : ""
          }
          ${
            secondary
              ? `<button class="secondary" value="secondary">${escapeHtml(secondary)}</button>`
              : ""
          }
          ${
            cancel
              ? `<button class="danger" value="cancel">${escapeHtml(cancel)}</button>`
              : ""
          }
        </div>
      </form>`;
    const cleanup = () => {
      dialog.remove();
    };
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue || "cancel");
      cleanup();
    });
    dialog.addEventListener("cancel", () => {
      dialog.returnValue = "cancel";
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

async function startEmulator(game, restoreState = null) {
  await releaseRuntimeBlobUrls();
  currentGameId = game.id;
  initialStateApplied = false;
  emulatorError = false;
  emulatorHasStarted = false;
  const romFilename =
    game.romFilename ||
    (game.platform === "arcade" ? null : `game${game.extension || ""}`);
  const romUrl =
    game.platform === "arcade" && romFilename
      ? `${await resolveCachedAsset(
          "rom",
          game.hash,
          `./api/games/${game.id}/rom`,
          game.hash,
        )}#${encodeURIComponent(romFilename)}`
      : await resolveCachedAsset(
          "rom",
          game.hash,
          `./api/games/${game.id}/rom`,
          game.hash,
        );
  let biosUrl = undefined;
  if (game.biosUrl) {
    const biosFilename = decodeURIComponent(
      game.biosUrl.split("/").pop().split("#")[0].split("?")[0],
    );
    biosUrl =
      game.platform === "arcade"
        ? `${await resolveCachedAsset(
            "bios",
            game.biosHash || game.biosUrl,
            game.biosUrl,
            game.biosHash,
          )}#${encodeURIComponent(biosFilename)}`
        : await resolveCachedAsset(
            "bios",
            game.biosHash || game.biosUrl,
            game.biosUrl,
            game.biosHash,
          );
  }
  assetsCacheCleared = false;
  window.EJS_currentGame = game;
  window.EJS_player = "#player";
  window.EJS_core = game.core;
  window.EJS_gameName =
    game.platform === "arcade" && romFilename ? romFilename : game.title;
  window.EJS_color = "#ff3b6b";
  window.EJS_backgroundImage = game.hasCover
    ? new URL(`./api/games/${game.id}/cover`, location.href).href
    : undefined;
  window.EJS_backgroundBlur = true;
  window.EJS_backgroundColor = "#050609";
  window.EJS_gameID = `${state.profileId}-${game.id}-${game.core}`;
  window.EJS_gameUrl = romUrl;
  window.EJS_biosUrl = biosUrl;
  window.EJS_dontExtractBIOS = game.platform === "arcade";
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
    emulatorHasStarted = true;
    void loadNativeSave();
    if (!restoreState) {
      void prepareInitialState(game);
    }
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
      if (event === "error" || data?.error === true) {
        emulatorError = true;
      }
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

async function prepareInitialState(game) {
  const slot = state.autoplaySaveSlot;
  let local = null;
  try {
    local = await getLocalSave(state.profileId, game.id, "state", slot);
    if (compatibleLocalSave(local, game)) {
      const buffer = await local.blob.arrayBuffer();
      await applySaveStateToRunningInstance(buffer);
      return;
    }
  } catch (error) {
    console.warn("[Retro Web] Could not read the local state", error);
    if (error.message === t("stateLoadFailed")) {
      await deleteLocalSave(state.profileId, game.id, "state", slot).catch(
        () => {},
      );
    }
  }

  let remote = null;
  try {
    remote = await api(`./api/games/${game.id}/saves/state/${slot}/meta`, {
      headers: stateHeaders(game),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    if (error.status !== 404) {
      console.warn("[Retro Web] Server state lookup failed", error);
    }
    return;
  }

  const localUpdatedAt = local?.updatedAt
    ? Date.parse(new Date(local.updatedAt).toISOString())
    : null;
  const remoteUpdatedAt = remote?.updatedAt
    ? Date.parse(remote.updatedAt)
    : null;
  const compatibleLocal = compatibleLocalSave(local, game);
  if (compatibleLocal) {
    if (remote?.hash && local?.hash && remote.hash === local.hash) {
      return;
    }
    if (
      localUpdatedAt !== null &&
      remoteUpdatedAt !== null &&
      remoteUpdatedAt <= localUpdatedAt
    ) {
      return;
    }
  } else if (localUpdatedAt !== null && remoteUpdatedAt !== null) {
    if (remoteUpdatedAt <= localUpdatedAt) return;
  }
  if (!remote) {
    return;
  }

  const emulator = window.EJS_emulator;
  emulator?.pause?.(true);
  const choice = await showConfirmDialog({
    title: t("foundServerState"),
    message: escapeHtml(
      "La partida permanecerá en el servidor hasta que elijas qué hacer.",
    ),
    primary: t("loadServerState"),
    secondary: t("startFromScratch"),
    cancel: t("cancel"),
  });
  if (choice === "cancel" || !choice) {
    emulator?.play?.(true);
    return;
  }
  if (choice === "secondary") {
    emulator?.play?.(true);
    return;
  }
  try {
    const buffer = await fetchServerSave("state", slot, game);
    await putLocalSave(state.profileId, game, "state", slot, buffer);
    await applySaveStateToRunningInstance(buffer);
  } catch (error) {
    console.warn("[Retro Web] Could not load the server state", error);
    emulator?.play?.(true);
  }
}

async function saveAutoStateForExit() {
  if (!isEmulatorStarted()) {
    throw new Error(t("stateBeforeStart"));
  }
  const emulator = window.EJS_emulator;
  const manager = emulator?.gameManager;
  if (!manager) throw new Error("El emulador no está disponible");
  const save = await manager.getState();
  if (!save || save.byteLength === 0) {
    throw new Error("No se pudo crear el estado de la partida");
  }
  await putLocalSave(
    state.profileId,
    window.EJS_currentGame,
    "state",
    state.autoplaySaveSlot,
    save,
  );
}

async function destroyEmulatorInstance() {
  closingEmulator = true;
  suppressNativeSaveUpload = true;
  const emulator = window.EJS_emulator;
  try {
    emulator?.pause?.(true);
  } catch (error) {
    console.warn("[Retro Web] Could not pause the emulator", error);
  }
  try {
    emulator?.callEvent?.("exit");
  } catch (error) {
    console.warn("[Retro Web] Could not emit emulator exit", error);
  }
  document.querySelector("#player")?.replaceChildren();
  window.EJS_emulator = undefined;
  window.EJS_player = undefined;
  window.EJS_currentGame = undefined;
  window.EJS_loadStateURL = undefined;
  await releaseRuntimeBlobUrls();
  closingEmulator = false;
  suppressNativeSaveUpload = false;
  emulatorError = false;
  emulatorHasStarted = false;
}

async function teardownEmulatorForAssetReset() {
  closingEmulator = true;
  suppressNativeSaveUpload = true;
  const emulator = window.EJS_emulator;
  try {
    emulator?.pause?.(true);
  } catch (error) {
    console.warn("[Retro Web] Could not pause the emulator", error);
  }
  try {
    emulator?.gameManager?.toggleMainLoop?.(0);
  } catch (error) {
    console.warn("[Retro Web] Could not stop the emulator loop", error);
  }
  try {
    const module = emulator?.gameManager?.Module;
    if (typeof module?.abort === "function") {
      module.abort();
    }
  } catch (error) {
    console.warn("[Retro Web] Could not abort the emulator module", error);
  }
  document.querySelector("#player")?.replaceChildren();
  window.EJS_emulator = undefined;
  window.EJS_player = undefined;
  window.EJS_currentGame = undefined;
  window.EJS_loadStateURL = undefined;
  await releaseRuntimeBlobUrls();
  closingEmulator = false;
  suppressNativeSaveUpload = false;
  emulatorError = false;
}

async function applySaveStateToRunningInstance(buffer) {
  if (initialStateApplied) return;
  const emulator = window.EJS_emulator;
  const manager = emulator?.gameManager;
  if (!manager) throw new Error("El emulador no está disponible");
  if (!isEmulatorStarted()) {
    throw new Error(t("stateBeforeStart"));
  }
  if (
    typeof manager.supportsStates === "function" &&
    !manager.supportsStates()
  ) {
    throw new Error(t("stateUnsupported"));
  }
  const state = new Uint8Array(buffer);
  if (!state.byteLength) throw new Error("El estado guardado está vacío");
  try {
    manager.loadState(state);
    initialStateApplied = true;
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    emulator.play?.(true);
    toast(t("stateLoaded"));
  } catch (error) {
    console.error("[Retro Web] State load failed", error);
    emulator?.play?.(true);
    throw new Error(t("stateLoadFailed"));
  }
}

function selectedSlot() {
  return Number(document.querySelector("#save-slot")?.value || 1);
}

function isEmulatorStarted() {
  return emulatorHasStarted;
}

async function uploadSaveState({ state: save }) {
  if (!isEmulatorStarted()) {
    toast(t("stateBeforeStart"), true);
    return;
  }
  await saveLocally("state", save);
  toast(t("stateSavedLocal"));
}

async function loadSaveState() {
  try {
    if (!isEmulatorStarted()) {
      toast(t("stateBeforeStart"), true);
      return;
    }
    const local = await getLocalSave(
      state.profileId,
      currentGameId,
      "state",
      selectedSlot(),
    );
    const game = window.EJS_currentGame;
    const compatibleLocal = compatibleLocalSave(local, window.EJS_currentGame);
    let stateBuffer;
    if (!compatibleLocal) {
      const buffer = await fetchServerSave(
        "state",
        selectedSlot(),
        window.EJS_currentGame,
      );
      await putLocalSave(
        state.profileId,
        window.EJS_currentGame,
        "state",
        selectedSlot(),
        buffer,
      );
      stateBuffer = buffer;
    } else {
      stateBuffer = await local.blob.arrayBuffer();
    }
    initialStateApplied = false;
    await applySaveStateToRunningInstance(stateBuffer);
  } catch (error) {
    if (error.message === t("stateLoadFailed")) {
      await deleteLocalSave(
        state.profileId,
        currentGameId,
        "state",
        selectedSlot(),
      ).catch(() => {});
    }
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
  if (remote) {
    const choice = await showConfirmDialog({
      title: t("syncConflict"),
      message: t("replaceServerSave"),
      details: [
        [t("serverSave"), remote.updatedAt],
        [t("localSave"), new Date(local.updatedAt).toISOString()],
        [
          "Tipo",
          local.kind === "state"
            ? "State"
            : getLocale() === "en"
              ? "Native save"
              : "Guardado nativo",
        ],
        ["Slot", String(local.slot)],
      ],
      primary: t("replaceServerSaveAction"),
      cancel: t("cancel"),
    });
    if (choice !== "primary") return false;
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
    const currentGameSaves = currentGameId
      ? await listLocalSaves(state.profileId, currentGameId)
      : [];
    const currentGameSaveBytes = currentGameSaves.reduce(
      (total, save) => total + (save.size || save.blob?.size || 0),
      0,
    );
    const actions = [
      {
        id: "roms",
        label: t("clearRomsAction"),
        disabled: usage.romAssets === 0,
      },
      {
        id: "bios",
        label: t("clearBiosAction"),
        disabled: usage.biosAssets === 0,
      },
      {
        id: "save",
        label: t("clearCurrentSaveAction"),
        disabled: !currentGameId || currentGameSaveBytes === 0,
      },
      {
        id: "saves",
        label: t("clearSavesAction"),
        disabled: usage.saves === 0,
      },
    ];
    const choice = await showConfirmDialog({
      title: t("localStorage"),
      message: t("cachedResourcesCurrently"),
      details: [
        [t("roms"), formatBytes(usage.romAssets)],
        [t("bios"), formatBytes(usage.biosAssets)],
        [t("currentSave"), formatBytes(currentGameSaveBytes)],
        [t("localSaves"), formatBytes(usage.saves)],
        [t("totalLocalStorage"), formatBytes(usage.total)],
      ],
      actions,
      cancel: t("cancel"),
    });
    if (!choice || choice === "cancel") return;

    let confirmationMessage = "";
    if (choice === "roms") {
      confirmationMessage = t("clearRomsConfirm");
    } else if (choice === "bios") {
      confirmationMessage = t("clearBiosConfirm");
    } else if (choice === "save") {
      confirmationMessage = t("clearCurrentSaveConfirm");
    } else if (choice === "saves") {
      confirmationMessage = t("clearSavesConfirm");
    }

    const confirmed = await showConfirmDialog({
      title: t("confirmAction"),
      message: confirmationMessage,
      primary: t("yes"),
      cancel: t("no"),
    });
    if (confirmed !== "primary") return;

    if (choice === "roms") {
      await clearProfileAssetKinds(state.profileId, ["rom"]);
      await releaseRuntimeBlobUrls();
      assetsCacheCleared = true;
      if (isEmulatorStarted()) {
        await teardownEmulatorForAssetReset();
        await loadLibrary();
      }
      toast(t("localAssetsCleared"));
    } else if (choice === "bios") {
      await clearProfileAssetKinds(state.profileId, ["bios"]);
      await releaseRuntimeBlobUrls();
      assetsCacheCleared = true;
      try {
        await Promise.all(
          ["retro-web-emulator-v3", "retro-web-emulator-v2"].map((name) =>
            caches.delete(name),
          ),
        );
      } catch (error) {
        console.warn("[Retro Web] Emulator asset cache clear failed", error);
      }
      if (isEmulatorStarted()) {
        await teardownEmulatorForAssetReset();
        await loadLibrary();
      }
      toast(t("localAssetsCleared"));
    } else if (choice === "save") {
      await clearCurrentGameSaves(state.profileId, currentGameId);
      toast(t("localSavesCleared"));
    } else if (choice === "saves") {
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

async function resolveCachedAsset(kind, identifier, url, expectedHash = null) {
  const cached = await getCachedAsset(state.profileId, kind, identifier);
  if (
    !assetsCacheCleared &&
    cached?.blob &&
    (!expectedHash || cached.hash === expectedHash)
  ) {
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
    const images = [...document.querySelectorAll("[data-cover-game]")].filter(
      (image) => image.dataset.coverGame === game.id,
    );
    if (!images.length || !cached?.blob) continue;
    const objectUrl = URL.createObjectURL(cached.blob);
    coverBlobUrls.add(objectUrl);
    for (const image of images) {
      image.src = objectUrl;
      image.hidden = false;
      if (image.nextElementSibling) {
        image.nextElementSibling.hidden = true;
      }
    }
  }
}

async function releaseRuntimeBlobUrls() {
  for (const url of runtimeBlobUrls) URL.revokeObjectURL(url);
  runtimeBlobUrls.clear();
}

boot();
