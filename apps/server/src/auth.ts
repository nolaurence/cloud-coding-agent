import crypto from "node:crypto";
import fs from "node:fs";
import type {
  AdminRegistrationState,
  AdminUser,
  CreatedInvite,
  InviteSummary,
  RegistrationPolicy,
  UserRole,
} from "@cca/protocol";
import { REGISTRATION_FILE, SECRET_FILE, USERS_FILE } from "./env.js";
import { databaseDialect, enqueueWrite, query, transaction, upsert, usingDatabase } from "./db.js";

export type Role = UserRole;

export interface User {
  username: string;
  role: Role;
  passwordHash: string;
  salt: string;
  createdAt: number;
}

export interface TokenPayload {
  username: string;
  role: Role;
  exp: number;
}

interface StoredInvite extends InviteSummary {
  codeHash: string;
  revokedAt?: number;
}

interface RegistrationSettings {
  inviteRequired: boolean;
  invites: StoredInvite[];
}

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REGISTRATION_SETTINGS_ID = 1;

let users: User[] = [];
let registrationSettings: RegistrationSettings = { inviteRequired: false, invites: [] };
let bootstrapAdminUsername = "admin";
let secret: Buffer;

function loadSecret(): Buffer {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      return Buffer.from(fs.readFileSync(SECRET_FILE, "utf8").trim(), "hex");
    }
  } catch {
    // fall through
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, generated.toString("hex"), { mode: 0o600 });
  return generated;
}

function loadUsers(): User[] {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) as User[];
    }
  } catch {
    // fall through
  }
  return [];
}

function saveUsers() {
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), "utf8");
  fs.renameSync(tmp, USERS_FILE);
}

function normalizeRegistrationSettings(value: unknown): RegistrationSettings {
  if (!value || typeof value !== "object") {
    return { inviteRequired: false, invites: [] };
  }

  const data = value as Record<string, unknown>;
  const invites: StoredInvite[] = [];
  if (Array.isArray(data.invites)) {
    for (const candidate of data.invites) {
      if (!candidate || typeof candidate !== "object") continue;
      const invite = candidate as Record<string, unknown>;
      if (
        typeof invite.id !== "string" ||
        typeof invite.codeHash !== "string" ||
        !/^[a-f\d]{64}$/i.test(invite.codeHash) ||
        typeof invite.hint !== "string" ||
        typeof invite.createdBy !== "string" ||
        typeof invite.createdAt !== "number" ||
        !Number.isFinite(invite.createdAt)
      ) {
        continue;
      }
      invites.push({
        id: invite.id,
        codeHash: invite.codeHash.toLowerCase(),
        hint: invite.hint,
        createdBy: invite.createdBy,
        createdAt: invite.createdAt,
        ...(typeof invite.revokedAt === "number" && Number.isFinite(invite.revokedAt)
          ? { revokedAt: invite.revokedAt }
          : {}),
      });
    }
  }

  return {
    inviteRequired: data.inviteRequired === true,
    invites,
  };
}

function parseRegistrationSettings(value: unknown): RegistrationSettings {
  try {
    if (Buffer.isBuffer(value)) {
      return normalizeRegistrationSettings(JSON.parse(value.toString("utf8")));
    }
    if (typeof value === "string") {
      return normalizeRegistrationSettings(JSON.parse(value));
    }
    return normalizeRegistrationSettings(value);
  } catch {
    return { inviteRequired: false, invites: [] };
  }
}

function loadRegistrationSettings(): RegistrationSettings {
  try {
    if (fs.existsSync(REGISTRATION_FILE)) {
      return parseRegistrationSettings(fs.readFileSync(REGISTRATION_FILE, "utf8"));
    }
  } catch {
    // fall through
  }
  return { inviteRequired: false, invites: [] };
}

function saveRegistrationFile() {
  const tmp = `${REGISTRATION_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registrationSettings, null, 2), "utf8");
  fs.renameSync(tmp, REGISTRATION_FILE);
}

function persistUser(user: User) {
  enqueueWrite(() =>
    upsert({
      table: "users",
      values: {
        username: user.username,
        role: user.role,
        password_hash: user.passwordHash,
        salt: user.salt,
        created_at: user.createdAt,
      },
      conflictColumns: ["username"],
      updateColumns: ["role", "password_hash", "salt"],
    }),
  );
}

function saveUser(user: User) {
  if (usingDatabase()) persistUser(user);
  else saveUsers();
}

function registrationData(): string {
  return JSON.stringify(registrationSettings);
}

function persistRegistrationSettings() {
  enqueueWrite(() =>
    upsert({
      table: "registration_settings",
      values: { id: REGISTRATION_SETTINGS_ID, data: registrationData() },
      conflictColumns: ["id"],
      updateColumns: ["data"],
    }),
  );
}

async function persistRegistrationSettingsNow() {
  await upsert({
    table: "registration_settings",
    values: { id: REGISTRATION_SETTINGS_ID, data: registrationData() },
    conflictColumns: ["id"],
    updateColumns: ["data"],
  });
}

function saveRegistrationSettings() {
  if (usingDatabase()) persistRegistrationSettings();
  else saveRegistrationFile();
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function hashInviteCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function sign(data: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function findUser(username: string): User | undefined {
  const normalized = username.trim().toLowerCase();
  return users.find((user) => user.username.toLowerCase() === normalized);
}

function isProtectedUser(user: User): boolean {
  return user.username.toLowerCase() === bootstrapAdminUsername.toLowerCase();
}

function toAdminUser(user: User): AdminUser {
  return {
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    protected: isProtectedUser(user),
  };
}

function toInviteSummary(invite: StoredInvite): InviteSummary {
  return {
    id: invite.id,
    hint: invite.hint,
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
  };
}

function inviteMatches(code: string): boolean {
  const candidate = Buffer.from(hashInviteCode(code), "hex");
  return registrationSettings.invites.some((invite) => {
    if (invite.revokedAt !== undefined) return false;
    const expected = Buffer.from(invite.codeHash, "hex");
    return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
  });
}

export async function initAuth() {
  secret = loadSecret();
  if (usingDatabase()) {
    const rows = await query<{
      username: string;
      role: Role;
      password_hash: string;
      salt: string;
      created_at: number | string;
    }>("SELECT username, role, password_hash, salt, created_at FROM users");
    users = rows.rows.map((row) => ({
      username: row.username,
      role: row.role,
      passwordHash: row.password_hash,
      salt: row.salt,
      createdAt: Number(row.created_at),
    }));
    if (users.length === 0) {
      const jsonUsers = loadUsers();
      if (jsonUsers.length > 0) {
        console.log(`[cca] migrating users -> ${databaseDialect()}`);
        await transaction(async (txQuery) => {
          for (const user of jsonUsers) {
            await upsert(
              {
                table: "users",
                values: {
                  username: user.username,
                  role: user.role,
                  password_hash: user.passwordHash,
                  salt: user.salt,
                  created_at: user.createdAt,
                },
                conflictColumns: ["username"],
              },
              txQuery,
            );
          }
        });
        users = jsonUsers;
      }
    }

    const registrationRows = await query<{ data: unknown }>(
      "SELECT data FROM registration_settings WHERE id = ?",
      [REGISTRATION_SETTINGS_ID],
    );
    if (registrationRows.rows[0]) {
      registrationSettings = parseRegistrationSettings(registrationRows.rows[0].data);
    } else {
      registrationSettings = loadRegistrationSettings();
      if (fs.existsSync(REGISTRATION_FILE)) {
        console.log(`[cca] migrating registration settings -> ${databaseDialect()}`);
      }
      await persistRegistrationSettingsNow();
    }
  } else {
    users = loadUsers();
    registrationSettings = loadRegistrationSettings();
  }

  const configuredAdminUsername = process.env.ADMIN_USERNAME?.trim() || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const existing = findUser(configuredAdminUsername);
  bootstrapAdminUsername = existing?.username ?? configuredAdminUsername;
  if (!existing) {
    const salt = crypto.randomBytes(16).toString("hex");
    const admin: User = {
      username: configuredAdminUsername,
      role: "admin",
      passwordHash: hashPassword(adminPassword, salt),
      salt,
      createdAt: Date.now(),
    };
    users.push(admin);
    saveUser(admin);
    console.log(`[cca] admin account created: ${configuredAdminUsername}`);
  } else if (existing.role !== "admin") {
    existing.role = "admin";
    saveUser(existing);
  }
  if (!process.env.ADMIN_PASSWORD) {
    console.warn("[cca] ADMIN_PASSWORD 未设置,管理员使用默认密码 admin123,请尽快通过环境变量修改");
  }
}

export function listUsers(): AdminUser[] {
  return users
    .map(toAdminUser)
    .sort((left, right) => left.createdAt - right.createdAt || left.username.localeCompare(right.username));
}

export function setUserRole(
  actorUsername: string,
  targetUsername: string,
  role: Role,
): AdminUser {
  if (role !== "admin" && role !== "user") throw new Error("用户角色无效");

  const actor = findUser(actorUsername);
  if (!actor || actor.role !== "admin") throw new Error("仅管理员可以修改用户角色");
  const target = findUser(targetUsername);
  if (!target) throw new Error("用户不存在");
  if (isProtectedUser(target)) throw new Error("受保护的初始管理员账号不能修改");
  if (actor.username === target.username) throw new Error("不能修改自己的角色");
  if (target.role === role) return toAdminUser(target);
  if (target.role === "admin" && role === "user") {
    const adminCount = users.filter((user) => user.role === "admin").length;
    if (adminCount <= 1) throw new Error("系统至少需要保留一名管理员");
  }

  target.role = role;
  saveUser(target);
  return toAdminUser(target);
}

export function getPublicRegistrationPolicy(): RegistrationPolicy {
  return { inviteRequired: registrationSettings.inviteRequired };
}

export function getAdminRegistrationState(): AdminRegistrationState {
  return {
    inviteRequired: registrationSettings.inviteRequired,
    invites: registrationSettings.invites
      .filter((invite) => invite.revokedAt === undefined)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(toInviteSummary),
  };
}

export function setInviteRequired(inviteRequired: boolean): RegistrationPolicy {
  if (typeof inviteRequired !== "boolean") throw new Error("邀请码注册设置无效");
  if (registrationSettings.inviteRequired !== inviteRequired) {
    registrationSettings.inviteRequired = inviteRequired;
    saveRegistrationSettings();
  }
  return getPublicRegistrationPolicy();
}

export function createInvite(createdBy: string): CreatedInvite {
  const actor = findUser(createdBy);
  if (!actor || actor.role !== "admin") throw new Error("仅管理员可以创建邀请码");

  const code = crypto.randomBytes(32).toString("base64url");
  const invite: StoredInvite = {
    id: crypto.randomUUID(),
    codeHash: hashInviteCode(code),
    hint: `${code.slice(0, 4)}...${code.slice(-4)}`,
    createdBy: actor.username,
    createdAt: Date.now(),
  };
  registrationSettings.invites.push(invite);
  saveRegistrationSettings();
  return { ...toInviteSummary(invite), code };
}

export function revokeInvite(id: string): InviteSummary {
  const invite = registrationSettings.invites.find(
    (candidate) => candidate.id === id && candidate.revokedAt === undefined,
  );
  if (!invite) throw new Error("邀请码不存在或已撤销");
  invite.revokedAt = Date.now();
  saveRegistrationSettings();
  return toInviteSummary(invite);
}

export function registerUser(username: string, password: string, inviteCode?: string): User {
  const name = username.trim();
  if (!/^[\w.-]{3,32}$/.test(name)) {
    throw new Error("用户名需为 3-32 位字母、数字、点、中划线或下划线");
  }
  if (password.length < 6) {
    throw new Error("密码至少 6 位");
  }
  if (users.some((user) => user.username.toLowerCase() === name.toLowerCase())) {
    throw new Error("用户名已存在");
  }
  if (
    registrationSettings.inviteRequired &&
    (typeof inviteCode !== "string" || !inviteMatches(inviteCode.trim()))
  ) {
    throw new Error("邀请码无效或已撤销");
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const user: User = {
    username: name,
    role: "user",
    passwordHash: hashPassword(password, salt),
    salt,
    createdAt: Date.now(),
  };
  users.push(user);
  saveUser(user);
  return user;
}

export function verifyUser(username: string, password: string): User | null {
  const user = findUser(username);
  if (!user) return null;
  const hash = hashPassword(password, user.salt);
  const candidate = Buffer.from(hash, "hex");
  const expected = Buffer.from(user.passwordHash, "hex");
  if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
    return null;
  }
  return user;
}

export function issueToken(user: User): string {
  const payload: TokenPayload = {
    username: user.username,
    role: user.role,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(body);
  const candidateBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    candidateBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(candidateBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<TokenPayload>;
    if (
      typeof payload.username !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp < Date.now()
    ) {
      return null;
    }
    const user = users.find((candidate) => candidate.username === payload.username);
    if (!user) return null;
    return { username: user.username, role: user.role, exp: payload.exp };
  } catch {
    return null;
  }
}
