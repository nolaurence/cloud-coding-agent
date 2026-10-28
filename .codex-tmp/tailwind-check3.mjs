import fs from 'node:fs'
import path from 'node:path'
import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'

const base = path.resolve('apps/web')
const css = fs.readFileSync(path.join(base, 'src/index.css'), 'utf8')
const compiler = await compile(css, { base, onDependency() {} })
const scanner = new Scanner({
  sources: [{ base: path.join(base, 'src'), pattern: '**/*', negated: false }],
})
const built = compiler.build(scanner.scan())
const text = typeof built === 'string' ? built : built.code

const probes = [
  '.rounded-\\[12px\\]',
  '.h-\\[38px\\]',
  '.text-\\[16px\\]',
  '.max-w-\\[min\\(82\\%,525px\\)\\]',
  '.max-w-\\[min\\(100\\%,calc\\(clamp\\(680px,64\\%,920px\\)+32px\\)\\)\\]',
  'color: var(--ds-link)',
  'mask-image: linear-gradient(to bottom',
  '.text-label-caption\\/60',
  'markdown-body',
  'clamp(680px, 64%, 920px)',
  'corner',
]
for (const needle of probes) {
  console.log((text.includes(needle) ? 'OK   ' : 'MISS ') + needle)
}
const idx = text.indexOf('clamp(680px')
console.log('--- context ---')
console.log(text.slice(idx - 160, idx + 120).replace(/\n+/g, '\n'))
