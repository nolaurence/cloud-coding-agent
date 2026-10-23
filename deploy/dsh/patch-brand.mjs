// 去掉 DSH 前端的品牌露出：左上角的 logotype，以及首页 hero 的鱼形标志和标题文案。
// 入参可选，默认按全局安装位置解析；每处替换都必须恰好命中一次，版本变动时直接报错而不是半改。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const globalRoot = process.env.DSH_GLOBAL_ROOT
  ? path.resolve(process.env.DSH_GLOBAL_ROOT)
  : path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@deepseek-ai");
const packageRoot = path.join(globalRoot, "dsh", "node_modules", "@deepseek-ai");

const patchBrand = path.join(packageRoot, "dsh-client-ui-brand-official", "lib", "client.js");
const patchConversation = path.join(packageRoot, "dsh-client-ui-conversation", "lib", "client.js");

const edits = [
  {
    file: patchBrand,
    label: "侧栏标志",
    from: "return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FishLogo, { size });",
    to: "return null;",
  },
  {
    file: patchBrand,
    label: "侧栏字标",
    from: "return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.BrandWordmark, { includeMark: false });",
    to: "return null;",
  },
  {
    file: patchConversation,
    label: "hero 标题(中文)",
    from: '"hero.headline": "探索未至之境"',
    to: '"hero.headline": ""',
  },
  {
    file: patchConversation,
    label: "hero 角标(中文)",
    from: '"hero.preview": "预览版"',
    to: '"hero.preview": ""',
  },
  {
    file: patchConversation,
    label: "hero 标题(英文)",
    from: '"hero.headline": "Into the Unknown"',
    to: '"hero.headline": ""',
  },
  {
    file: patchConversation,
    label: "hero 角标(英文)",
    from: '"hero.preview": "Preview"',
    to: '"hero.preview": ""',
  },
  {
    file: patchConversation,
    label: "hero 标志",
    from: ", { fallback: (0, react_jsx_runtime.jsx)(HeroFish, { hovering }) })",
    to: ", { fallback: null })",
  },
];

const cache = new Map();
const changed = new Set();

for (const edit of edits) {
  if (!cache.has(edit.file)) cache.set(edit.file, fs.readFileSync(edit.file, "utf8"));
  const source = cache.get(edit.file);
  if (!source.includes(edit.from)) {
    if (source.includes(edit.to) && edit.to !== "") {
      console.log(`${edit.label}: 已打过补丁`);
      continue;
    }
    throw new Error(`${edit.label}: 未找到待替换内容，DSH 前端版本可能已变化`);
  }
  const next = source.replace(edit.from, edit.to);
  cache.set(edit.file, next);
  changed.add(edit.file);
  console.log(`${edit.label}: 已去除`);
}

for (const file of changed) {
  fs.writeFileSync(file, cache.get(file));
}

console.log(changed.size === 0 ? "品牌露出: 无需改动" : `品牌露出: 已更新 ${changed.size} 个文件`);
