import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { detect } from '../src/lib/detect'
import { solve } from '../src/lib/solver'

const [imagePath, fixedColor, boosterLabel] = process.argv.slice(2)
if (!imagePath) {
  console.log('usage: npx tsx scripts/solve-image.ts <image.png> [fixedHexColor] [boosterPieceNumber]')
  process.exit(1)
}

const png = PNG.sync.read(readFileSync(imagePath))
const detection = detect({ width: png.width, height: png.height, data: png.data })

const output = solve({
  board: detection.board,
  edgeCells: [],
  pieces: detection.pieces.map((piece) => ({
    id: piece.id,
    cells: piece.shape.cells,
    rotatable: piece.color !== fixedColor,
    tier: 0,
    wantsNeighbors: `${piece.id + 1}` === boosterLabel,
    avoidEdge: false,
  })),
  maxSolutions: 5,
  timeLimitMs: 10000,
})
console.log(`complete=${output.complete} explored=${output.explored} ${output.elapsedMs.toFixed(0)}ms`)
for (const solution of output.solutions) {
  console.log(
    `placed ${solution.placedByTier.join('/')} neighbors ${solution.neighborScore} cells ${solution.cellsCovered}/${detection.board.length}: ` +
      solution.placements.map((p) => `#${p.pieceId + 1}r${p.rotation * 60}`).join(' '),
  )
}
