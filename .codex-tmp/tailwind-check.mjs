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
const candidates = scanner.scan()
const out = compiler.build(candidates)
const code = typeof out === 'string' ? out : out.code

const probes = [
  ['.bg-panel', '--ds-panel'],
  ['.bg-bubble', '--ds-bubble'],
  ['.bg-hover', '--ds-hover'],
  ['.bg-elevated', '--ds-elevated'],
  ['.text-label-1', '--ds-label-1'],
  ['.text-label-2', '--ds-label-2'],
  ['.text-label-3', '--ds-label-3'],
  ['.text-label-caption', '--ds-label-caption'],
  ['.border-line-3', '--ds-line-3'],
  ['.text-shimmer', 'ds-text-shimmer'],
  ['clamp(680px', null],
  ['.rounded-\\[20px\\]', null],
  ['.border-\\[0\\.5px\\]', null],
  ['.text-\\[13px\\]', null],
  ['.size-4', null],
]
let missing = 0
for (const [needle, token] of probes) {
  const found = code.includes(needle)
  const tokenFound = token === null ? true : code.includes(token)
  if (!found || !tokenFound) missing += 1
  console.log(`${found && tokenFound ? 'OK  ' : 'MISS'} ${needle}${token === null ? '' : ` (${token})`}`)
}
const varBlock = /\.bg-panel\s*\{[^}]*\}/.exec(code)
const labelBlock = /\.text-label-2\s*\{[^}]*\}/.exec(code)
const bubbleBlock = /\.bg-bubble\s*\{[^}]*\}/.exec(code)
console.log('bytes', code.length, 'candidates', candidates.length, 'missing', missing)
console.log(varBlock?.[0].replace(/\s+/g, ' '))
console.log(labelBlock?.[0].replace(/\s+/g, ' '))
console.log(bubbleBlock?.[0].replace(/\s+/g, ' '))
