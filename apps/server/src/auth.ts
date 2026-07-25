import crypto from "node:crypto";
import fs from "node:fs";
import { SECRET_FILE, USERS_FILE } from "./env.js";
import { query, usingPostgres } from "./db.js";

export type Role = "admin" | "user";

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

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let users: User[] = [];
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

function persistUser(user: User) {
  void query(
    `INSERT INTO users (username, role, password_hash, salt, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt`,
    [user.username, user.role, user.passwordHash, user.salt, user.createdAt],
  ).catch((err) => console.error("[cca] db write failed", err));
}

function saveUser(user: User) {
  if (usingPostgres()) persistUser(user);
  else saveUsers();
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function sign(data: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

export async function initAuth() {
  secret = loadSecret();
  if (usingPostgres()) {
    const rows = await query("SELECT username, role, password_hash, salt, created_at FROM users");
    users = rows.rows.map((r) => ({
      username: r.username as string,
      role: r.role as Role,
      passwordHash: r.password_hash as string,
      salt: r.salt as string,
      createdAt: Number(r.created_at),
    }));
    if (users.length === 0) {
      const jsonUsers = loadUsers();
      if (jsonUsers.length > 0) {
        console.log("[cca] migrating users -> postgres");
        for (const u of jsonUsers) {
          await query(
            `INSERT INTO users (username, role, password_hash, salt, created_at)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (username) DO NOTHING`,
            [u.username, u.role, u.passwordHash, u.salt, u.createdAt],
          );
        }
        users = jsonUsers;
      }
    }
  } else {
    users = loadUsers();
  }

  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const existing = users.find((u) => u.username === adminUsername);
  if (!existing) {
    const salt = crypto.randomBytes(16).toString("hex");
    const admin: User = {
      username: adminUsername,
      role: "admin",
      passwordHash: hashPassword(adminPassword, salt),
      salt,
      createdAt: Date.now(),
    };
    users.push(admin);
    saveUser(admin);
    console.log(`[cca] admin account created: ${adminUsername}`);
  } else if (existing.role !== "admin") {
    existing.role = "admin";
    saveUser(existing);
  }
  if (!process.env.ADMIN_PASSWORD) {
    console.warn("[cca] ADMIN_PASSWORD 未设置,管理员使用默认密码 admin123,请尽快通过环境变量修改");
  }
}

export function registerUser(username: string, password: string): User {
  const name = username.trim();
  if (!/^[\w.-]{3,32}$/.test(name)) {
    throw new Error("用户名需为 3-32 位字母、数字、点、中划线或下划线");
  }
  if (password.length < 6) {
    throw new Error("密码至少 6 位");
  }
  if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    throw new Error("用户名已存在");
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
  const user = users.find((u) => u.username.toLowerCase() === username.trim().toLowerCase());
  if (!user) return null;
  const hash = hashPassword(password, user.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(user.passwordHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
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
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    if (!users.some((u) => u.username === payload.username)) return null;
    return payload;
  } catch {
    return null;
  }
}
