import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { detect } from '../src/lib/detect'
import { solve } from '../src/lib/solver'

const png = PNG.sync.read(readFileSync(process.argv[2]))
const detection = detect({ width: png.width, height: png.height, data: png.data })
const fixedColor = process.argv[3]

const output = solve({
  board: detection.board,
  pieces: detection.pieces.map((piece) => ({
    id: piece.id,
    cells: piece.shape.cells,
    rotatable: piece.color !== fixedColor,
    tier: 0,
  })),
  maxSolutions: 5,
  timeLimitMs: 5000,
})
console.log(`complete=${output.complete} explored=${output.explored} ${output.elapsedMs.toFixed(0)}ms`)
for (const solution of output.solutions) {
  console.log(
    `placed by tier ${solution.placedByTier.join("/")} cells ${solution.cellsCovered}/${detection.board.length}: ` +
      solution.placements.map((p) => `#${p.pieceId + 1}r${p.rotation * 60}`).join(' '),
  )
}
