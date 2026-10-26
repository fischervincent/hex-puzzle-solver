import { addCells, cellKey, cellSetKey, rotateShapeCells, type Cell } from './hex'

export type SolverPiece = {
  id: number
  cells: Cell[]
  rotatable: boolean
  tier: number
}

export type SolverInput = {
  board: Cell[]
  pieces: SolverPiece[]
  maxSolutions: number
  timeLimitMs: number
}

export type Placement = { pieceId: number; rotation: number; cells: Cell[] }

export type Solution = {
  placements: Placement[]
  placedByTier: number[]
  cellsCovered: number
}

export type SolverOutput = {
  solutions: Solution[]
  complete: boolean
  explored: number
  elapsedMs: number
}

type Orientation = { rotation: number; cells: Cell[] }

type PieceType = {
  pieceIds: number[]
  size: number
  tier: number
  orientations: Orientation[]
}

type TypePlacement = { typeIndex: number; rotation: number; cellIndices: number[] }

const TIER_BASE = 1_000
const CLOCK_CHECK_INTERVAL = 4096

function orientationsOf(piece: SolverPiece): Orientation[] {
  const steps = piece.rotatable ? [0, 1, 2, 3, 4, 5] : [0]
  const seen = new Set<string>()
  return steps.flatMap((rotation) => {
    const cells = rotateShapeCells(piece.cells, rotation)
    const key = cellSetKey(cells)
    if (seen.has(key)) return []
    seen.add(key)
    return [{ rotation, cells }]
  })
}

function groupIntoTypes(pieces: SolverPiece[]): PieceType[] {
  const types = new Map<string, PieceType>()
  for (const piece of pieces) {
    const orientations = orientationsOf(piece)
    const shapeKey = orientations.map((orientation) => cellSetKey(orientation.cells)).sort()[0]
    const key = `${piece.tier}|${piece.rotatable}|${shapeKey}`
    const existing = types.get(key)
    if (existing) existing.pieceIds.push(piece.id)
    else types.set(key, { pieceIds: [piece.id], size: piece.cells.length, tier: piece.tier, orientations })
  }
  return [...types.values()].sort((a, b) => a.tier - b.tier || b.size - a.size)
}

function placementsByFirstCell(board: Cell[], types: PieceType[]): TypePlacement[][][] {
  const indexByKey = new Map(board.map((cell, index) => [cellKey(cell), index]))
  const byFirstCell: TypePlacement[][][] = board.map(() => types.map(() => []))

  types.forEach((type, typeIndex) => {
    const seen = new Set<string>()
    for (const orientation of type.orientations) {
      for (const anchor of board) {
        const offset = { i: anchor.i - orientation.cells[0].i, j: anchor.j - orientation.cells[0].j }
        const cellIndices = orientation.cells.map((cell) => indexByKey.get(cellKey(addCells(cell, offset))))
        if (cellIndices.some((index) => index === undefined)) continue
        const indices = cellIndices.filter((index): index is number => index !== undefined)
        const key = [...indices].sort((a, b) => a - b).join(',')
        if (seen.has(key)) continue
        seen.add(key)
        byFirstCell[Math.min(...indices)][typeIndex].push({ typeIndex, rotation: orientation.rotation, cellIndices: indices })
      }
    }
  })
  return byFirstCell
}

function placementsCoveringEachCell(cellCount: number, byFirstCell: TypePlacement[][][]): TypePlacement[][] {
  const covering: TypePlacement[][] = Array.from({ length: cellCount }, () => [])
  for (const placement of byFirstCell.flat(2)) {
    for (const index of placement.cellIndices) covering[index].push(placement)
  }
  return covering
}

function largestSubsetSumAtMost(sizes: number[], limit: number): number {
  if (limit <= 0) return 0
  const reachable = new Uint8Array(limit + 1)
  reachable[0] = 1
  for (const size of sizes) {
    for (let total = limit; total >= size; total--) {
      if (reachable[total - size]) reachable[total] = 1
    }
  }
  let best = limit
  while (!reachable[best]) best--
  return best
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function maxPiecesFitting(sizes: number[], freeCells: number): number {
  let count = 0
  let used = 0
  for (const size of sizes) {
    if (used + size > freeCells) break
    used += size
    count++
  }
  return count
}

export function solve(input: SolverInput): SolverOutput {
  const started = performance.now()
  const board = [...input.board].sort((a, b) => a.i - b.i || a.j - b.j)
  const types = groupIntoTypes(input.pieces)
  const byFirstCell = placementsByFirstCell(board, types)
  const coveringPlacements = placementsCoveringEachCell(board.length, byFirstCell)
  const remaining = types.map((type) => type.pieceIds.length)
  const occupied = new Uint8Array(board.length)
  const stack: TypePlacement[] = []
  const tierCount = Math.max(0, ...input.pieces.map((piece) => piece.tier + 1))
  const placedByTier = new Array<number>(tierCount).fill(0)

  let freeCells = board.length
  let cellsCovered = 0
  let explored = 0
  let timedOut = false
  const best: { score: number; placements: TypePlacement[] }[] = []

  const scoreOf = (countsByTier: number[], cells: number) =>
    countsByTier.reduce((score, count) => score * TIER_BASE + count, 0) * TIER_BASE + cells

  const fits = (placement: TypePlacement) =>
    remaining[placement.typeIndex] > 0 && placement.cellIndices.every((index) => occupied[index] === 0)

  const countUncoverableCells = (): number => {
    let uncoverable = 0
    for (let index = 0; index < board.length; index++) {
      if (occupied[index] === 0 && !coveringPlacements[index].some(fits)) uncoverable++
    }
    return uncoverable
  }

  const placementsOfType = types.map((_, typeIndex) => byFirstCell.flatMap((perType) => perType[typeIndex]))

  const upperBound = (usableCells: number, onlyPlaceableTypes: boolean): number => {
    const sizesByTier: number[][] = placedByTier.map(() => [])
    types.forEach((type, typeIndex) => {
      if (remaining[typeIndex] === 0) return
      if (onlyPlaceableTypes && !placementsOfType[typeIndex].some(fits)) return
      for (let copy = 0; copy < remaining[typeIndex]; copy++) sizesByTier[type.tier].push(type.size)
    })
    let cellsLeftForTier = usableCells
    let largestCellsAtThoseCounts = 0
    const countsByTier = sizesByTier.map((sizes, tier) => {
      const smallestFirst = [...sizes].sort((a, b) => a - b)
      const count = maxPiecesFitting(smallestFirst, cellsLeftForTier)
      cellsLeftForTier -= sum(smallestFirst.slice(0, count))
      largestCellsAtThoseCounts += sum(smallestFirst.slice(smallestFirst.length - count))
      return placedByTier[tier] + count
    })
    const cellsBound = Math.min(
      largestSubsetSumAtMost(sizesByTier.flat(), usableCells),
      largestCellsAtThoseCounts,
    )
    return scoreOf(countsByTier, cellsCovered + cellsBound)
  }

  const worstKeptScore = () => (best.length < input.maxSolutions ? -1 : best[best.length - 1].score)

  const record = () => {
    const score = scoreOf(placedByTier, cellsCovered)
    if (score <= worstKeptScore()) return
    best.push({ score, placements: [...stack] })
    best.sort((a, b) => b.score - a.score)
    if (best.length > input.maxSolutions) best.pop()
  }

  const search = (start: number): void => {
    if (timedOut) return
    explored++
    if (explored % CLOCK_CHECK_INTERVAL === 0 && performance.now() - started > input.timeLimitMs) {
      timedOut = true
      return
    }

    let cell = start
    while (cell < board.length && occupied[cell]) cell++
    if (upperBound(freeCells, false) <= worstKeptScore()) return
    if (upperBound(freeCells - countUncoverableCells(), true) <= worstKeptScore()) return
    if (cell === board.length) {
      record()
      return
    }

    for (let typeIndex = 0; typeIndex < types.length; typeIndex++) {
      if (remaining[typeIndex] === 0) continue
      const type = types[typeIndex]
      for (const placement of byFirstCell[cell][typeIndex]) {
        if (placement.cellIndices.some((index) => occupied[index])) continue
        for (const index of placement.cellIndices) occupied[index] = 1
        remaining[typeIndex]--
        freeCells -= type.size
        cellsCovered += type.size
        placedByTier[type.tier]++
        stack.push(placement)

        search(cell + 1)

        stack.pop()
        placedByTier[type.tier]--
        cellsCovered -= type.size
        freeCells += type.size
        remaining[typeIndex]++
        for (const index of placement.cellIndices) occupied[index] = 0
        if (timedOut) return
      }
    }

    occupied[cell] = 2
    freeCells--
    search(cell + 1)
    freeCells++
    occupied[cell] = 0
  }

  search(0)

  const piecesById = new Map(input.pieces.map((piece) => [piece.id, piece]))
  const solutions = best.map(({ placements }) => toSolution(placements, types, board, piecesById, tierCount))
  return {
    solutions,
    complete: !timedOut,
    explored,
    elapsedMs: performance.now() - started,
  }
}

function toSolution(
  placements: TypePlacement[],
  types: PieceType[],
  board: Cell[],
  piecesById: Map<number, SolverPiece>,
  tierCount: number,
): Solution {
  const nextCopy = types.map(() => 0)
  const resolved = placements.flatMap((placement) => {
    const type = types[placement.typeIndex]
    const piece = piecesById.get(type.pieceIds[nextCopy[placement.typeIndex]++])
    if (!piece) return []
    const targetCells = placement.cellIndices.map((index) => board[index])
    return [{ ...orientPiece(piece, targetCells), tier: type.tier }]
  })
  return {
    placements: resolved.map(({ pieceId, rotation, cells }) => ({ pieceId, rotation, cells })),
    placedByTier: Array.from(
      { length: tierCount },
      (_, tier) => resolved.filter((placement) => placement.tier === tier).length,
    ),
    cellsCovered: resolved.reduce((sum, placement) => sum + placement.cells.length, 0),
  }
}

function orientPiece(piece: SolverPiece, targetCells: Cell[]): Placement {
  const targetKey = cellSetKey(targetCells)
  const offset = {
    i: Math.min(...targetCells.map((cell) => cell.i)),
    j: Math.min(...targetCells.map((cell) => cell.j)),
  }
  for (const { rotation, cells } of orientationsOf(piece)) {
    if (cellSetKey(cells) === targetKey) {
      return { pieceId: piece.id, rotation, cells: cells.map((cell) => addCells(cell, offset)) }
    }
  }
  return { pieceId: piece.id, rotation: 0, cells: targetCells }
}
