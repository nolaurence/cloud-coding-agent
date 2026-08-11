import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CREDENTIALS_FILE = "desktop-admin.json";
const BACKUP_SUFFIX = ".backup";
interface StoredDesktopCredentials { username: string; password: string; revealed: boolean }
export interface DesktopCredentialResult { username: string; password: string; shouldReveal: boolean }

interface CredentialFileOps {
  exists(filename: string): boolean;
  read(filename: string): string;
  writeExclusive(filename: string, value: string): void;
  rename(from: string, to: string): void;
  remove(filename: string): void;
  chmod(filename: string, mode: number): void;
}

const fileOps: CredentialFileOps = {
  exists: fs.existsSync,
  read: (filename) => fs.readFileSync(filename, "utf8"),
  writeExclusive: (filename, value) => fs.writeFileSync(filename, value, { encoding: "utf8", mode: 0o600, flag: "wx" }),
  rename: fs.renameSync,
  remove: (filename) => fs.rmSync(filename, { force: true }),
  chmod: fs.chmodSync,
};

function validCredentials(value: unknown): value is StoredDesktopCredentials {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.username === "string" && /^[\w.-]{3,32}$/.test(item.username) &&
    typeof item.password === "string" && item.password.length >= 32 && typeof item.revealed === "boolean";
}

function credentialsPath(dataDirectory: string): string { return path.join(dataDirectory, CREDENTIALS_FILE); }
function readCredentials(filename: string, operations: CredentialFileOps): StoredDesktopCredentials {
  const parsed: unknown = JSON.parse(operations.read(filename));
  if (!validCredentials(parsed)) throw new Error("invalid desktop credentials file");
  return parsed;
}

export function recoverCredentialBackup(filename: string, operations: CredentialFileOps = fileOps): void {
  const backup = `${filename}${BACKUP_SUFFIX}`;
  if (!operations.exists(backup)) return;
  if (!operations.exists(filename)) operations.rename(backup, filename);
  else operations.remove(backup);
}

function writeCredentials(filename: string, credentials: StoredDesktopCredentials, replacing = false, operations: CredentialFileOps = fileOps): void {
  const temporary = `${filename}.${process.pid}.tmp`;
  const backup = `${filename}${BACKUP_SUFFIX}`;
  operations.remove(temporary);
  operations.writeExclusive(temporary, JSON.stringify(credentials));
  if (!replacing) {
    try { operations.rename(temporary, filename); } catch (error) { operations.remove(temporary); throw error; }
  } else {
    operations.remove(backup);
    operations.rename(filename, backup);
    try {
      operations.rename(temporary, filename);
    } catch (error) {
      try { operations.rename(backup, filename); } finally { operations.remove(temporary); }
      throw error;
    }
    operations.remove(backup);
  }
  if (process.platform !== "win32") operations.chmod(filename, 0o600);
}

export function loadOrCreateDesktopCredentials(dataDirectory: string): DesktopCredentialResult {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dataDirectory, 0o700);
  const filename = credentialsPath(dataDirectory);
  recoverCredentialBackup(filename);
  if (fileOps.exists(filename)) {
    const parsed = readCredentials(filename, fileOps);
    if (process.platform !== "win32") fileOps.chmod(filename, 0o600);
    return { username: parsed.username, password: parsed.password, shouldReveal: !parsed.revealed };
  }
  const credentials: StoredDesktopCredentials = { username: "desktop-admin", password: crypto.randomBytes(32).toString("base64url"), revealed: false };
  writeCredentials(filename, credentials);
  return { username: credentials.username, password: credentials.password, shouldReveal: true };
}

export function markDesktopCredentialsRevealed(dataDirectory: string): void {
  const filename = credentialsPath(dataDirectory);
  recoverCredentialBackup(filename);
  const parsed = readCredentials(filename, fileOps);
  if (!parsed.revealed) writeCredentials(filename, { ...parsed, revealed: true }, true);
}
