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

for (const needle of [
  'max-w-\\[min\\(82\\%,525px\\)\\]',
  'text-\\[var\\(--ds-link\\)\\]',
  'mask-image:linear-gradient',
  'text-label-caption\\/60',
  'bg-label-caption',
  'border-line-2',
  '\\[&_\\.markdown-body\\]',
  'text-\\[16px\\]',
  'max-w-\\[min\\(100\\%,calc\\(clamp\\(680px,64\\%,920px\\)',
  'h-\\[38px\\]',
  'rounded-\\[12px\\]',
]) {
  console.log((new RegExp(needle).test(text) ? 'OK   ' : 'MISS ') + needle)
}
