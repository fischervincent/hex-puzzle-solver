export type Cell = { i: number; j: number }
export type Link = [number, number]
export type Shape = { cells: Cell[]; links: Link[] }
export type Point = { x: number; y: number }

export const HEX_NEIGHBORS: Cell[] = [
  { i: 1, j: 0 },
  { i: 0, j: 1 },
  { i: -1, j: 1 },
  { i: -1, j: 0 },
  { i: 0, j: -1 },
  { i: 1, j: -1 },
]

export const FLAT_TOP_ANGLE = 30

export function cellKey(cell: Cell): string {
  return `${cell.i},${cell.j}`
}

export function addCells(a: Cell, b: Cell): Cell {
  return { i: a.i + b.i, j: a.j + b.j }
}

export function rotateCell(cell: Cell, steps: number): Cell {
  let { i, j } = cell
  for (let step = 0; step < ((steps % 6) + 6) % 6; step++) {
    ;[i, j] = [-j, i + j]
  }
  return { i, j }
}

export function translateToOrigin(cells: Cell[]): Cell[] {
  const minI = Math.min(...cells.map((cell) => cell.i))
  const minJ = Math.min(...cells.map((cell) => cell.j))
  return cells.map((cell) => ({ i: cell.i - minI, j: cell.j - minJ }))
}

export function rotateShapeCells(cells: Cell[], steps: number): Cell[] {
  return translateToOrigin(cells.map((cell) => rotateCell(cell, steps)))
}

export function cellSetKey(cells: Cell[]): string {
  return translateToOrigin(cells).map(cellKey).sort().join(';')
}

export function rectangularBoard(columns: number, rows: number, angleDeg: number): Cell[] {
  const cells: Cell[] = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      cells.push(
        angleDeg === FLAT_TOP_ANGLE
          ? { i: column, j: row - Math.floor(column / 2) }
          : { i: column - Math.floor(row / 2), j: row },
      )
    }
  }
  return cells
}

export function latticeVectors(size: number, angleDeg: number): [Point, Point] {
  const step = Math.sqrt(3) * size
  const a = (angleDeg * Math.PI) / 180
  const b = a + Math.PI / 3
  return [
    { x: step * Math.cos(a), y: step * Math.sin(a) },
    { x: step * Math.cos(b), y: step * Math.sin(b) },
  ]
}

export function cellCenter(cell: Cell, size: number, angleDeg: number): Point {
  const [e1, e2] = latticeVectors(size, angleDeg)
  return { x: cell.i * e1.x + cell.j * e2.x, y: cell.i * e1.y + cell.j * e2.y }
}

export function hexPoints(center: Point, radius: number, angleDeg: number): string {
  const points: string[] = []
  for (let k = 0; k < 6; k++) {
    const a = ((angleDeg + 30 + 60 * k) * Math.PI) / 180
    points.push(`${(center.x + radius * Math.cos(a)).toFixed(2)},${(center.y + radius * Math.sin(a)).toFixed(2)}`)
  }
  return points.join(' ')
}
