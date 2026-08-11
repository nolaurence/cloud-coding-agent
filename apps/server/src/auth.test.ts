import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("admin roles and invite registration persist without storing invite plaintext", async (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cca-auth-"));
  const originalDataDirectory = process.env.CCA_DATA_DIR;
  const originalAdminUsername = process.env.ADMIN_USERNAME;
  const originalAdminPassword = process.env.ADMIN_PASSWORD;
  const originalInvitePolicy = process.env.REGISTRATION_INVITE_REQUIRED;
  process.env.CCA_DATA_DIR = dataDirectory;
  process.env.ADMIN_USERNAME = "bootstrap-admin";
  process.env.ADMIN_PASSWORD = "bootstrap-secret";

  const db = await import("./db.js");
  const auth = await import("./auth.js");
  t.after(async () => {
    if (db.usingDatabase()) await db.closeDb();
    if (originalDataDirectory === undefined) delete process.env.CCA_DATA_DIR;
    else process.env.CCA_DATA_DIR = originalDataDirectory;
    if (originalAdminUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = originalAdminUsername;
    if (originalAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalAdminPassword;
    if (originalInvitePolicy === undefined) delete process.env.REGISTRATION_INVITE_REQUIRED;
    else process.env.REGISTRATION_INVITE_REQUIRED = originalInvitePolicy;
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  await auth.initAuth();
  assert.deepEqual(auth.getPublicRegistrationPolicy(), { inviteRequired: false });
  assert.deepEqual(
    auth.listUsers().map(({ username, role, protected: isProtected }) => ({
      username,
      role,
      protected: isProtected,
    })),
    [{ username: "bootstrap-admin", role: "admin", protected: true }],
  );

  const member = auth.registerUser("member-one", "secret12");
  const memberToken = auth.issueToken(member);
  auth.setUserRole("bootstrap-admin", member.username, "admin");
  assert.equal(auth.verifyToken(memberToken)?.role, "admin");
  assert.throws(
    () => auth.setUserRole(member.username, member.username, "user"),
    /不能修改自己的角色/,
  );
  assert.throws(
    () => auth.setUserRole("bootstrap-admin", "bootstrap-admin", "user"),
    /受保护/,
  );
  auth.setUserRole("bootstrap-admin", member.username, "user");
  assert.equal(auth.verifyToken(memberToken)?.role, "user");

  const createdInvite = auth.createInvite("bootstrap-admin");
  assert.match(createdInvite.code, /^[A-Za-z\d_-]{40,}$/);
  assert.ok(!createdInvite.hint.includes(createdInvite.code));
  auth.setInviteRequired(true);
  assert.throws(() => auth.registerUser("no-invite", "secret12"), /邀请码/);
  assert.throws(() => auth.registerUser("bad-invite", "secret12", "not-valid"), /邀请码/);
  auth.registerUser("invited-one", "secret12", createdInvite.code);
  auth.registerUser("invited-two", "secret12", `  ${createdInvite.code}  `);

  const registrationFile = path.join(dataDirectory, "registration.json");
  const persistedJson = fs.readFileSync(registrationFile, "utf8");
  assert.ok(!persistedJson.includes(createdInvite.code));
  assert.match(persistedJson, /"codeHash": "[a-f\d]{64}"/);

  auth.revokeInvite(createdInvite.id);
  assert.equal(auth.getAdminRegistrationState().invites.length, 0);
  assert.throws(
    () => auth.registerUser("revoked-code", "secret12", createdInvite.code),
    /邀请码/,
  );

  await auth.initAuth();
  assert.equal(auth.getPublicRegistrationPolicy().inviteRequired, true);
  assert.equal(auth.verifyUser("invited-one", "secret12")?.role, "user");

  auth.setInviteRequired(false);
  process.env.REGISTRATION_INVITE_REQUIRED = "true";
  await auth.initAuth();
  assert.equal(auth.getPublicRegistrationPolicy().inviteRequired, true);
  assert.equal(JSON.parse(fs.readFileSync(registrationFile, "utf8")).inviteRequired, true);
  delete process.env.REGISTRATION_INVITE_REQUIRED;

  const databaseFile = path.join(dataDirectory, "auth.db");
  await db.initDb(`sqlite:${databaseFile.replaceAll(path.sep, "/")}`);
  await auth.initAuth();
  const registrationRows = await db.query<{ data: string }>(
    "SELECT data FROM registration_settings WHERE id = 1",
  );
  assert.equal(registrationRows.rows.length, 1);
  assert.ok(!registrationRows.rows[0]!.data.includes(createdInvite.code));

  auth.setInviteRequired(false);
  auth.setUserRole("bootstrap-admin", "member-one", "admin");
  await db.flushDbWrites();
  await db.closeDb();

  await db.initDb(`sqlite:${databaseFile.replaceAll(path.sep, "/")}`);
  await auth.initAuth();
  assert.equal(auth.getPublicRegistrationPolicy().inviteRequired, false);
  assert.equal(auth.listUsers().find((user) => user.username === "member-one")?.role, "admin");
});

test("desktop bootstrap forces invite-only registration", async () => {
  const original = process.env.REGISTRATION_INVITE_REQUIRED;
  process.env.REGISTRATION_INVITE_REQUIRED = "true";
  try {
    const auth = await import("./auth.js");
    assert.equal(auth.applyRegistrationEnvironment({ inviteRequired: false, invites: [] }).inviteRequired, true);
    assert.equal(auth.applyRegistrationEnvironment({ inviteRequired: true, invites: [] }).inviteRequired, true);
    assert.throws(() => auth.setInviteRequired(false), /强制使用邀请码/);
  } finally {
    if (original === undefined) delete process.env.REGISTRATION_INVITE_REQUIRED;
    else process.env.REGISTRATION_INVITE_REQUIRED = original;
  }
});
