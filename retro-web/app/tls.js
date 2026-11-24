import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { spawnSync } from "node:child_process";

const allowedCertificateName = /^[A-Za-z0-9._-]{1,160}$/;

export function resolveTls(config) {
  if (!config.external_access) return null;
  if (config.ssl) return loadHomeAssistantCertificate(config);
  return loadOrCreateSelfSignedCertificate(config);
}

export function loadHomeAssistantCertificate(config) {
  const certName = safeFileName(config.certfile, "fullchain.pem");
  const keyName = safeFileName(config.keyfile, "privkey.pem");
  const certPath = path.join("/ssl", certName);
  const keyPath = path.join("/ssl", keyName);
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error(
      `TLS certificate files not found: ${certPath} and ${keyPath}`,
    );
  }
  try {
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    validateCertificatePair(cert, key);
    return {
      cert,
      key,
      source: "home_assistant",
      certPath,
      keyPath,
    };
  } catch (error) {
    throw new Error(`Invalid Home Assistant TLS certificate: ${error.message}`);
  }
}

export function loadOrCreateSelfSignedCertificate(config) {
  const tlsDirectory = path.join(config.dataPath, "tls");
  fs.mkdirSync(tlsDirectory, { recursive: true, mode: 0o700 });
  const certPath = path.join(tlsDirectory, "selfsigned-cert.pem");
  const keyPath = path.join(tlsDirectory, "selfsigned-key.pem");
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      validateCertificatePair(
        fs.readFileSync(certPath),
        fs.readFileSync(keyPath),
      );
      return {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
        source: "self_signed",
        certPath,
        keyPath,
      };
    } catch {
      fs.rmSync(certPath, { force: true });
      fs.rmSync(keyPath, { force: true });
    }
  }
  generateSelfSignedCertificate({
    certPath,
    keyPath,
    commonName:
      safeDnsName(config.tls_self_signed_common_name) || "retro-web.local",
    days: Number(config.tls_self_signed_days || 365),
  });
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
    source: "self_signed",
    certPath,
    keyPath,
  };
}

function generateSelfSignedCertificate({
  certPath,
  keyPath,
  commonName,
  days,
}) {
  const configPath = `${certPath}.openssl.cnf`;
  fs.writeFileSync(
    configPath,
    [
      "[req]",
      "distinguished_name=req_distinguished_name",
      "x509_extensions=v3_req",
      "prompt=no",
      "[req_distinguished_name]",
      `CN=${commonName}`,
      "[v3_req]",
      "basicConstraints=CA:TRUE",
      "keyUsage=digitalSignature,keyEncipherment,keyAgreement",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=@alt_names`,
      "[alt_names]",
      "DNS.1=localhost",
      "DNS.2=retro-web",
      "DNS.3=retro-web.local",
      "IP.1=127.0.0.1",
    ].join("\n"),
  );
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      String(days),
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-config",
      configPath,
    ],
    { encoding: "utf8" },
  );
  fs.rmSync(configPath, { force: true });
  if (result.status !== 0) {
    throw new Error(
      `Could not generate self-signed TLS certificate: ${result.stderr || "openssl failed"}`,
    );
  }
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);
}

function validateCertificatePair(cert, key) {
  const certificate = new crypto.X509Certificate(cert);
  const now = Date.now();
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (Number.isNaN(validFrom) || Number.isNaN(validTo)) {
    throw new Error("certificate validity dates are invalid");
  }
  if (now < validFrom || now > validTo) {
    throw new Error("certificate is expired or not yet valid");
  }
  const privateKey = crypto.createPrivateKey(key);
  const publicKey = crypto.createPublicKey(cert);
  const keyDer = crypto.createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("hex");
  const certDer = publicKey
    .export({ format: "der", type: "spki" })
    .toString("hex");
  if (keyDer !== certDer) {
    throw new Error("certificate and private key do not match");
  }
  const secureContext = tls.createSecureContext({
    cert,
    key,
  });
  if (!secureContext) throw new Error("TLS context is invalid");
}

function safeFileName(value, fallback) {
  const name = String(value || fallback).trim();
  if (
    !allowedCertificateName.test(name) ||
    name.includes("..") ||
    name.includes("/")
  ) {
    throw new Error(`Invalid SSL filename: ${name}`);
  }
  return name;
}

function safeDnsName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(name)) return null;
  if (name.includes("..")) return null;
  return name;
}
