import fs from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("用法: node patch-helper.mjs <helper.js>");
const source = fs.readFileSync(file, "utf8");
const needle = 'mkdtemp("/tmp/dsh-ssh-")';
const legacy = 'mkdtemp(process.env.DSH_SSH_TMPDIR ?? "/tmp/dsh-ssh-")';
const replacement = 'mkdtemp(join(process.env.DSH_SSH_TMPDIR ?? "/tmp", "dsh-ssh-"))';
if (source.includes(replacement)) {
  console.log("helper 已应用 DSH_SSH_TMPDIR 补丁");
  process.exit(0);
}
if (!source.includes(needle) && !source.includes(legacy)) {
  throw new Error("未找到 helper 的 mkdtemp 调用，版本可能已变化");
}
const patched = source.includes(legacy)
  ? source.replace(legacy, replacement)
  : source.replace(needle, replacement);
fs.writeFileSync(file, patched);
console.log("helper 已应用 DSH_SSH_TMPDIR 补丁");
