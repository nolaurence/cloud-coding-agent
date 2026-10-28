import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import { chromium } from 'playwright-core'

const base = path.resolve('apps/web')
const css = fs.readFileSync(path.join(base, 'src/index.css'), 'utf8')
const compiler = await compile(css, { base, onDependency() {} })
const scanner = new Scanner({
  sources: [{ base: path.join(base, 'src'), pattern: '**/*', negated: false }],
})
const built = compiler.build(scanner.scan())
const styles = typeof built === 'string' ? built : built.code

const icon = (glyph, cls = '') => `<span class="flex size-4 shrink-0 items-center justify-center text-label-3 ${cls}">${glyph}</span>`

const sidebar = `
<aside class="flex h-full w-[280px] shrink-0 flex-col border-r-[0.5px] border-line-3 bg-panel px-3 py-1.5">
  <div class="flex h-[60px] shrink-0 items-center gap-2 pl-1 pr-0">
    <div class="size-6 shrink-0 rounded-[7px] bg-black dark:bg-white"></div>
    <span class="min-w-0 flex-1 truncate text-[18px] font-semibold leading-6 tracking-[0.04em] text-label-1">Kloud Coding Agent</span>
    <button class="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-label-2 hover:bg-hover">◧</button>
  </div>
  <div class="flex shrink-0 flex-col gap-1 pb-3">
    <button class="flex h-[38px] w-full items-center justify-center gap-1.5 rounded-[12px] border-[0.5px] border-line-3 bg-elevated px-3 text-[14px] font-medium leading-[22px] text-label-1">✎ 新聊天</button>
    <button class="flex min-h-9 w-full items-center gap-2 rounded-[12px] px-2 py-[7px] text-left text-[14px] leading-[22px] text-label-1 hover:bg-hover">
      <span class="flex size-4 shrink-0 items-center justify-center text-label-3">▣</span>创建工作区
    </button>
  </div>
  <div class="min-h-0 flex-1 overflow-y-auto pb-4">
    <div class="flex h-8 items-center px-2 text-[12px] font-medium leading-5 text-label-3">项目</div>
    <div class="flex h-[34px] items-center gap-1.5 rounded-[12px] px-2 text-[14px] leading-5 text-label-1 hover:bg-hover">
      <span class="flex size-3.5 shrink-0 items-center justify-center text-[var(--ds-label-caption)]">▱</span>
      <span class="min-w-0 flex-1 truncate">cloud-coding-agent</span>
    </div>
    <a class="flex h-8 items-center gap-1.5 rounded-[12px] bg-hover px-2 pr-8 text-[14px] leading-5 text-label-1">
      <span class="flex size-3.5 shrink-0 items-center justify-center text-label-3">▤</span>
      <span class="min-w-0 flex-1 truncate">对话流与侧边栏样式对齐 harness</span>
    </a>
    <a class="flex h-8 items-center gap-1.5 rounded-[12px] px-2 pr-8 text-[14px] leading-5 text-label-1 hover:bg-hover">
      <span class="flex size-3.5 shrink-0 items-center justify-center text-[var(--ds-link)]">◌</span>
      <span class="min-w-0 flex-1 truncate">正在运行的会话示例</span>
    </a>
    <a class="flex h-8 items-center gap-1.5 rounded-[12px] px-2 pr-8 text-[14px] leading-5 text-label-1 hover:bg-hover">
      <span class="flex size-3.5 shrink-0 items-center justify-center text-label-3">▤</span>
      <span class="min-w-0 flex-1 truncate">修复工作区上传失败的问题</span>
    </a>
    <a class="flex h-8 items-center gap-1.5 rounded-[12px] px-2 pr-8 text-[14px] leading-5 text-label-1 hover:bg-hover">
      <span class="flex size-3.5 shrink-0 items-center justify-center text-label-3">▤</span>
      <span class="min-w-0 flex-1 truncate">给右侧面板加上图片预览</span>
    </a>
    <div class="mt-2">
      <div class="flex h-8 items-center gap-1.5 px-2 text-[12px] font-medium leading-5 text-label-3">▤ 共享会话</div>
      <a class="flex h-8 items-center gap-1.5 rounded-[12px] px-2 text-[14px] leading-5 text-label-1 hover:bg-hover">
        <span class="flex size-3.5 shrink-0 items-center justify-center text-label-3">◉</span>
        <span class="min-w-0 flex-1 truncate">团队共享的排查记录</span>
      </a>
    </div>
  </div>
  <div class="shrink-0 pb-0.5 pt-1">
    <div class="flex h-9 items-center gap-2 rounded-[12px] px-2 text-[14px] leading-5 text-label-1 hover:bg-hover">
      <span class="flex size-4 shrink-0 items-center justify-center text-label-3">◔</span>
      <span class="min-w-0 flex-1 truncate">nolaurence</span>
      <button class="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-label-3 hover:bg-hover">⏻</button>
    </div>
  </div>
</aside>`

const chat = `
<main class="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
  <header class="shrink-0">
    <div class="flex min-h-[56px] items-center gap-2 px-5 py-2.5">
      <div class="min-w-0 flex-1">
        <div class="truncate text-[14px] leading-5 text-label-1">对话流与侧边栏样式对齐 harness</div>
        <div class="mt-0.5 flex items-center gap-1 text-[12px] leading-[18px] text-label-3">
          <span>▱</span><span class="truncate">cloud-coding-agent</span>
        </div>
      </div>
      <button class="flex size-8 items-center justify-center rounded-[8px] text-label-2 hover:bg-hover">⇧</button>
      <button class="flex size-8 items-center justify-center rounded-[8px] text-label-2 hover:bg-hover">◫</button>
    </div>
  </header>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex w-full max-w-[min(100%,calc(clamp(680px,64%,920px)+32px))] flex-col gap-4 px-4 pt-4">
      <article class="assistant-message flex min-w-0 flex-col gap-4">
        <div class="min-w-0">
          <div class="group/think flex h-6 w-full min-w-0 items-center gap-1.5 text-left">
            <span class="relative flex size-4 shrink-0 items-center justify-center text-label-3">◎</span>
            <span class="shrink-0 text-[13px] leading-6 text-label-2">思考</span>
            <span class="mx-2 size-0.5 shrink-0 rounded-full bg-label-caption"></span>
            <span class="min-w-0 flex-1 truncate text-[13px] leading-6 text-label-3">先读 ui-chat 的 ChatView.module.css，再对齐 MessageItem 的气泡与行高。</span>
          </div>
          <div class="markdown-compact min-w-0 pb-1 pl-[22px] pt-1">
            <div class="markdown-body">
              <p>harness 的展开行是 24px 行高，正文 13/20，第三层级文字。</p>
            </div>
          </div>
        </div>
        <div class="markdown-body">
          <p>对话流与左侧栏已经按 harness 的令牌重排，主要改动如下。</p>
          <ul>
            <li>消息列宽 <code>clamp(680px, 64%, 920px)</code>，行间距 16px。</li>
            <li>用户气泡 20px 圆角、<code>10px 16px</code> 内边距。</li>
            <li>思考 / 工具行共用 24px 的紧凑展开行。</li>
          </ul>
          <pre><code>npm run typecheck
npm run build</code></pre>
          <p>细节见 <a>ChatView.tsx</a> 与 <b>index.css</b> 里的 <code>--ds-*</code> 令牌。</p>
        </div>
        <div class="-ml-1.5 flex h-7 items-center gap-2 text-label-3">
          <button class="flex size-7 items-center justify-center rounded-[8px] text-label-3 hover:bg-hover">⧉</button>
          <span class="text-[13px] leading-6 tabular-nums">20:41</span>
        </div>
      </article>

      <article class="group/user flex flex-col items-end gap-1.5">
        <div class="flex min-w-0 max-w-[min(82%,525px)] flex-col items-end gap-2">
          <div class="chat-bubble max-w-full rounded-[20px] bg-bubble px-4 py-[10px] text-[14px] leading-[22px] text-label-1">
            <div class="markdown-body">
              <p>对话流样式（除去 sender）和左侧侧边栏样式抄一下</p>
            </div>
          </div>
        </div>
        <div class="flex h-7 items-center gap-2 text-label-3">
          <span class="text-[13px] leading-6 tabular-nums">20:43</span>
          <button class="flex size-7 items-center justify-center rounded-[8px] text-label-3 hover:bg-hover">⧉</button>
        </div>
      </article>

      <div class="flex min-w-0 flex-col gap-2">
        <button class="group/tool-group flex h-6 w-full items-center gap-1.5 text-left">
          ${icon('▤')}
          <span class="min-w-0 flex-1 truncate text-[13px] leading-6 text-label-2 group-hover/tool-group:text-label-1">运行了 3 条命令，以及读取了 2 个文件</span>
        </button>
        <button class="group/subagent flex h-6 w-full min-w-0 items-center gap-1.5 text-left">
          ${icon('◍')}
          <span class="flex min-w-0 flex-1 items-baseline gap-1.5 text-[13px] leading-6">
            <span class="shrink-0 text-label-2">Explore</span>
            <span class="min-w-0 flex-1 truncate text-label-3">梳理 ui-chat 的对话流样式</span>
          </span>
          <span class="text-[12px] leading-5 text-label-3">32 秒 · 9 次工具调用</span>
          <span class="flex h-4 items-center gap-1 text-[12px] leading-5 text-label-3">已完成 ✓</span>
        </button>
        <button class="group/tool flex h-6 w-full items-center gap-1.5 text-left">
          ${icon('▸', 'invisible')}
          <span class="min-w-0 flex-1 truncate text-[13px] leading-6 text-label-3">读取 packages/client/ui-chat/src/client/chat/ChatView.module.css</span>
          <span class="size-3 text-label-caption">⌄</span>
        </button>
      </div>

      <article class="assistant-message flex min-w-0 flex-col gap-4">
        <div class="markdown-body">
          <p>左侧栏换成了 280px 宽、12px 内边距、36px 圆角行的版本，会话行 32px。</p>
        </div>
      </article>

      <button class="flex h-6 w-fit items-center gap-1 text-[13px] leading-6 text-label-2">工作了 1 分 12 秒 ›</button>
      <div class="flex h-6 items-center text-[13px] leading-6 tabular-nums text-label-3">
        <span class="text-shimmer text-label-2">正在工作 12 秒</span>
      </div>
    </div>
  </div>
</main>`

const html = (dark) => `<!doctype html>
<html lang="zh-CN" class="${dark ? 'dark' : ''}">
<head>
<meta charset="utf-8" />
<style>${styles}</style>
<style>
  html, body { height: 100%; margin: 0; }
  body { overflow: hidden; }
  .app { display: flex; height: 100vh; background: var(--background); }
</style>
</head>
<body>
  <div class="app">
    ${sidebar}
    ${chat}
  </div>
</body>
</html>`

const outDir = path.join(os.tmpdir(), 'dsh-style-preview')
fs.mkdirSync(outDir, { recursive: true })
for (const dark of [false, true]) {
  const file = path.join(outDir, dark ? 'preview-dark.html' : 'preview-light.html')
  fs.writeFileSync(file, html(dark), 'utf8')
  console.log(file)
}
