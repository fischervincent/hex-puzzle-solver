import { readFileSync } from 'node:fs'
import { parseSetup, setupToSolverInput } from '../src/lib/setup'
import { solve } from '../src/lib/solver'

const [setupPath, timeLimitSeconds] = process.argv.slice(2)
if (!setupPath) {
  console.log('usage: npx tsx scripts/solve-setup.ts <hexfit-setup.json> [timeLimitSeconds]')
  process.exit(1)
}

const setup = parseSetup(readFileSync(setupPath, 'utf8'))
const input = setupToSolverInput(setup, 6)
if (timeLimitSeconds) input.timeLimitMs = Number(timeLimitSeconds) * 1000

const output = solve(input)
const labelOf = (id: number) => setup.pieces[id].label
console.log(
  `${input.pieces.length} pieces, ${setup.board.length} cells: complete=${output.complete} ` +
    `explored=${output.explored} ${output.elapsedMs.toFixed(0)}ms`,
)
for (const solution of output.solutions) {
  console.log(
    `placed ${solution.placedByTier.join('/')} neighbors ${solution.neighborScore} cells ${solution.cellsCovered}: ` +
      solution.placements.map((placement) => `#${labelOf(placement.pieceId)}r${placement.rotation * 60}`).join(' '),
  )
}
