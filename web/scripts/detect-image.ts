import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { detect } from '../src/lib/detect'

const imagePath = process.argv[2]
if (!imagePath) {
  console.log('usage: npx tsx scripts/detect-image.ts <image.png>')
  process.exit(1)
}

const png = PNG.sync.read(readFileSync(imagePath))
const started = performance.now()
const detection = detect({ width: png.width, height: png.height, data: png.data })
console.log(`detected in ${(performance.now() - started).toFixed(0)}ms`)
console.log(`node radius ${detection.nodeRadius.toFixed(1)}, display angle ${detection.displayAngle}`)
console.log(`lattice`, detection.lattice)
console.log(`board: ${detection.board.length} cells`)
for (const piece of detection.pieces) {
  const cells = piece.shape.cells.map((cell) => `${cell.i},${cell.j}`).join(' ')
  console.log(
    `#${piece.id + 1} ${piece.color} hue=${piece.hue.toFixed(0)} nodes=${piece.nodes.length} links=${piece.shape.links.length} ` +
      `${piece.boardCells ? 'on board' : 'loose'}  [${cells}]`,
  )
}
