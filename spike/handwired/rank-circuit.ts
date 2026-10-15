// foxpaw pageText's control pick (text.js 0.1.15: items, rank, the room loop)
// as one handwired numeric program. The string work (dedupe, folds, rows)
// stays in JavaScript; the program gets, per item slot, its rank bucket and
// its cost, and returns which slots are kept.
//
// JS: sort the items by (rank, index), then keep each one whose cost fits the
// room left. The circuit form: no sort. Walk the buckets in rank order, and in
// each bucket the slots in page order, carrying the room. That is the same
// order as the stable sort, so the same picks.
const HANDWIRED = process.env.HANDWIRED ?? `${process.env.HOME}/ext/handwired-src/repo`
const core = await import(`${HANDWIRED}/src/runtime/numeric-ui-core.ts`)
const {Circuit, emitCompare} = core

export const BUCKETS = [-1, 0, 1, 2, 3] as const
/** Not a slot: a bucket that no pass reads. */
export const EMPTY = 4
/** readFrame keeps at most 300 controls, so pageText has at most 300 items. */
export const SLOTS = 300
const MAX_COST = 75 // a fold of 300 links costs ceil(300 / 4)
const MAX_ROOM = 300

export interface Built {
  circuit: InstanceType<typeof Circuit>
  picked: number[]
  slots: number
  // source layout: [room, bucket_0..n-1, cost_0..n-1]
  write(source: Float32Array, room: number, items: {bucket: number, cost: number}[]): void
}

export function buildPick(slots = SLOTS): Built {
  const circuit = new Circuit(1 + 2 * slots)
  const room0 = circuit.source(0)
  circuit.assumeRange(room0, 0, MAX_ROOM)
  circuit.assumeGrid(room0, 1)
  const bucket = Array.from({length: slots}, (_, i) => circuit.source(1 + i))
  const cost = Array.from({length: slots}, (_, i) => circuit.source(1 + slots + i))
  for (const w of bucket) { circuit.assumeRange(w, -1, EMPTY); circuit.assumeGrid(w, 1) }
  for (const w of cost) { circuit.assumeRange(w, 0, MAX_COST); circuit.assumeGrid(w, 1) }
  // JS: bits.every(bit => bit === 1)
  const both = (a: number, b: number) => circuit.reglu([], 1, [[a, 1], [b, 1]], -1)
  let room = room0
  const picks: number[][] = Array.from({length: slots}, () => [])
  for (const b of BUCKETS) {
    const k = circuit.constant(b)
    for (let i = 0; i < slots; i++) {
      // JS: if (rank(item) === b && cost <= room) { keep; room -= cost }
      const inBucket = emitCompare(circuit, bucket[i], '===', k)
      const fits = emitCompare(circuit, cost[i], '<=', room)
      const pick = both(inBucket, fits)
      picks[i].push(pick)
      room = circuit.affine([[room, 1], [circuit.multiply(pick, cost[i]), -1]])
      // True: a pick only takes a cost that fits, so the room stays within 0..300.
      circuit.assumeRange(room, 0, MAX_ROOM)
      circuit.assumeGrid(room, 1)
    }
  }
  const picked = picks.map((p) => circuit.affine(p.map((w) => [w, 1] as const)))
  return {
    circuit, picked, slots,
    write(source, r, items) {
      if (items.length > slots) throw new Error(`${items.length} items, the program holds ${slots}`)
      source[0] = r
      for (let i = 0; i < slots; i++) {
        source[1 + i] = i < items.length ? items[i].bucket : EMPTY
        source[1 + slots + i] = i < items.length ? items[i].cost : 0
      }
    },
  }
}
