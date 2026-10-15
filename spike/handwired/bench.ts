// pageText's control pick: foxpaw's JavaScript against the handwired program,
// on snapshots that capture.mjs read from real pages.
//   bun spike/handwired/bench.ts <snapshots.json>
import {readFileSync} from 'node:fs'
import {pageText} from '../../node_modules/foxpaw/dist/text.js'
import {buildPick, SLOTS} from './rank-circuit.ts'

const HANDWIRED = process.env.HANDWIRED ?? `${process.env.HOME}/ext/handwired-src/repo`
const {compileChunks} = await import(`${HANDWIRED}/src/json-search/generated-js.ts`)

// ---- foxpaw 0.1.15 text.js, copied: items(), rank() and the room loop of pageText().
const MAX_CONTROLS = 40, FOLD_RUN = 5, SHORT = 40
const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'spinbutton'])
type Item = {fold: any[]} | {control: any}
function items(page: any): Item[] {
  const out: Item[] = []; const seen = new Set<string>(); let run: any[] = []
  const flush = () => { if (run.length >= FOLD_RUN) out.push({fold: run}); else for (const c of run) out.push({control: c}); run = [] }
  for (const c of page.controls) {
    if (c.role === 'link' && c.href && !/^\s*(?:#|javascript:)/i.test(c.href)) {
      const key = JSON.stringify([c.frameId, c.label, c.href]); if (seen.has(key)) continue; seen.add(key)
    }
    if (c.role !== 'link' || c.form !== undefined || c.dialog || c.label.length > SHORT) { flush(); out.push({control: c}); continue }
    const last = run.at(-1)
    if (last && ((c.row && c.row === last.row) || c.section !== last.section || c.frameId !== last.frameId)) flush()
    run.push(c)
  }
  flush(); return out
}
const rank = (item: any) => 'fold' in item ? 2 : item.control.submit ? -1
  : FIELDS.has(item.control.role) || item.control.dialog ? 0 : item.control.offscreen ? 3 : 1
const costOf = (item: any) => 'fold' in item ? Math.ceil(item.fold.length / 4) : 1
function pickJs(all: Item[], max = MAX_CONTROLS): Set<Item> {
  let room = max
  return new Set(all.map((item, i) => [item, i] as const).toSorted((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([item]) => item).filter((item) => { const cost = costOf(item); if (cost > room) return false; room -= cost; return true }))
}
// ----

const time = (fn: () => void, minMs = 300) => {
  for (let k = 0; k < 3; k++) fn()
  let n = 0; const t = performance.now()
  while (performance.now() - t < minMs) { fn(); n++ }
  return (performance.now() - t) / n
}
const us = (ms: number) => `${(ms * 1000).toFixed(ms < 0.01 ? 2 : 0)} µs`

const data = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
let t = performance.now()
const built = buildPick(SLOTS)
const buildMs = performance.now() - t
t = performance.now()
const program = built.circuit.compileTensorProgram(built.picked)
const evaluate = built.circuit.createTensorProgramEvaluator(program)
const compileMs = performance.now() - t
t = performance.now()
const {chunks} = compileChunks(program)
const positions = built.picked.map((w: number) => program.wireOrder.indexOf(w))
const values = new Float32Array(program.valueCount)
const generated = (source: Float32Array) => { values.set(source); for (const c of chunks) c(values); return positions.map((p: number) => values[p]) }
const codegenMs = performance.now() - t
const live = program.valueCount - program.sourceSize
console.log(`program: ${SLOTS} slots, ${built.circuit.operations.length} built operations, ${live} live, ${program.layers.length} layers; build ${buildMs.toFixed(0)} ms, compile ${compileMs.toFixed(0)} ms, codegen ${codegenMs.toFixed(0)} ms`)
console.log('Second of two passes over the pages, so every path is warm.')
console.log('| page | controls | items | kept | items(), JS (stays in JS) | pick, JS | pick, handwired executor | pick, handwired generated JS | whole pageText, JS | same picks |')
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
const source = new Float32Array(program.sourceSize)
let allSame = true
const rows: string[] = []
for (const pass of [1, 2]) {
rows.length = 0
for (const p of data.pages) {
  if (!p.snapshot) continue
  const page = {...p.snapshot, controls: p.snapshot.controls.map((c: any) => ({...c, id: `0:${c.node}`, frameId: 0}))}
  const all = items(page)
  const js = pickJs(all)
  built.write(source, MAX_CONTROLS, all.map((item) => ({bucket: rank(item), cost: costOf(item)})))
  const viaExec = Array.from(evaluate(source))
  const viaGen = generated(source)
  const same = all.every((item, i) => (js.has(item) ? 1 : 0) === viaExec[i] && viaExec[i] === viaGen[i])
  allSame &&= same
  const jsMs = time(() => pickJs(all))
  const itemsMs = time(() => items(page))
  const execMs = time(() => { built.write(source, MAX_CONTROLS, all.map((item) => ({bucket: rank(item), cost: costOf(item)}))); evaluate(source) })
  const genMs = time(() => { built.write(source, MAX_CONTROLS, all.map((item) => ({bucket: rank(item), cost: costOf(item)}))); generated(source) })
  const textMs = time(() => pageText(page))
  const host = p.url.replace(/^https?:\/\//, '').replace(/^127\.0\.0\.1:\d+/, 'local').slice(0, 48)
  rows.push(`| ${host} | ${page.controls.length} | ${all.length} | ${js.size} | ${us(itemsMs)} | ${us(jsMs)} | ${us(execMs)} | ${us(genMs)} | ${us(textMs)} | ${same} |`)
}
}
for (const r of rows) console.log(r)
console.log(`all picks equal: ${allSame}`)
