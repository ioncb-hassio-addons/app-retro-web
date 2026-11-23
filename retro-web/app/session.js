import crypto from "node:crypto";

const cookieName = "retro_web_session";

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createSession(db, timeoutHours, isExternalAdmin = false) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + timeoutHours * 60 * 60 * 1000;
  db.prepare(
    "INSERT INTO sessions (token_hash, profile_id, is_external_admin, csrf_token, expires_at) VALUES (?, NULL, ?, ?, ?)",
  ).run(tokenHash(token), isExternalAdmin ? 1 : 0, csrfToken, expiresAt);
  return { cookieName, token, csrfToken, expiresAt };
}

export function getSession(db, request) {
  const token = parseCookies(request.headers.cookie)[cookieName];
  if (!token) return null;
  const session = db
    .prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .get(tokenHash(token), Date.now());
  return session || null;
}

export function selectProfile(db, session, profileId) {
  const profile = db
    .prepare("SELECT id FROM profiles WHERE id = ?")
    .get(profileId);
  if (!profile) throw new Error("Profile not found");
  db.prepare("UPDATE sessions SET profile_id = ? WHERE token_hash = ?").run(
    profileId,
    session.token_hash,
  );
}

export function getCookie(request, name) {
  return parseCookies(request.headers.cookie)[name] || null;
}

export function deleteSession(db, request) {
  const token = parseCookies(request.headers.cookie)[cookieName];
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
}

export function requireCsrf(request, session) {
  return (
    request.get("x-retro-csrf") === session.csrf_token && sameOrigin(request)
  );
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name]) => name)
      .map(([name, ...value]) => [name, value.join("=")]),
  );
}

function sameOrigin(request) {
  const origin = request.get("origin");
  if (!origin) return true;
  try {
    const requestHost = request.get("x-forwarded-host") || request.get("host");
    return new URL(origin).host === requestHost;
  } catch {
    return false;
  }
}
