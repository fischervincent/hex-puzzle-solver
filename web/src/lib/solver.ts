import { HEX_NEIGHBORS, addCells, cellKey, cellSetKey, rotateShapeCells, type Cell } from './hex'

export type SolverPiece = {
  id: number
  cells: Cell[]
  rotatable: boolean
  tier: number
  wantsNeighbors: boolean
  avoidEdge: boolean
}

export type SolverInput = {
  board: Cell[]
  edgeCells: Cell[]
  pieces: SolverPiece[]
  maxSolutions: number
  timeLimitMs: number
}

export type Placement = { pieceId: number; rotation: number; cells: Cell[]; neighborCount: number | null }

export type Solution = {
  placements: Placement[]
  placedByTier: number[]
  neighborScore: number
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
  wantsNeighbors: boolean
  avoidEdge: boolean
  orientations: Orientation[]
}

type TypePlacement = { typeIndex: number; rotation: number; cellIndices: number[] }

type Score = number[]

const CLOCK_CHECK_INTERVAL = 4096
const FIT_PHASE_SHARE = 0.5
const FREE = 0
const FILLED = 1
const LEFT_EMPTY = 2

function compareScores(a: Score, b: Score): number {
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

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
    const key = [piece.tier, piece.rotatable, piece.wantsNeighbors, piece.avoidEdge, shapeKey].join('|')
    const existing = types.get(key)
    if (existing) existing.pieceIds.push(piece.id)
    else
      types.set(key, {
        pieceIds: [piece.id],
        size: piece.cells.length,
        tier: piece.tier,
        wantsNeighbors: piece.wantsNeighbors,
        avoidEdge: piece.avoidEdge,
        orientations,
      })
  }
  return [...types.values()].sort(
    (a, b) => a.tier - b.tier || Number(b.wantsNeighbors) - Number(a.wantsNeighbors) || b.size - a.size,
  )
}

function placementsByFirstCell(board: Cell[], edgeKeys: Set<string>, types: PieceType[]): TypePlacement[][][] {
  const indexByKey = new Map(board.map((cell, index) => [cellKey(cell), index]))
  const byFirstCell: TypePlacement[][][] = board.map(() => types.map(() => []))

  types.forEach((type, typeIndex) => {
    const seen = new Set<string>()
    for (const orientation of type.orientations) {
      for (const anchor of board) {
        const offset = { i: anchor.i - orientation.cells[0].i, j: anchor.j - orientation.cells[0].j }
        const placed = orientation.cells.map((cell) => addCells(cell, offset))
        if (type.avoidEdge && placed.some((cell) => edgeKeys.has(cellKey(cell)))) continue
        const cellIndices = placed.map((cell) => indexByKey.get(cellKey(cell)))
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

function neighborIndicesOf(board: Cell[]): number[][] {
  const indexByKey = new Map(board.map((cell, index) => [cellKey(cell), index]))
  return board.map((cell) =>
    HEX_NEIGHBORS.flatMap((direction) => {
      const index = indexByKey.get(cellKey(addCells(cell, direction)))
      return index === undefined ? [] : [index]
    }),
  )
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
  const byFirstCell = placementsByFirstCell(board, new Set(input.edgeCells.map(cellKey)), types)
  const coveringPlacements = placementsCoveringEachCell(board.length, byFirstCell)
  const placementsOfType = types.map((_, typeIndex) => byFirstCell.flatMap((perType) => perType[typeIndex]))
  const neighborIndices = neighborIndicesOf(board)
  const remaining = types.map((type) => type.pieceIds.length)
  const occupied = new Uint8Array(board.length)
  const owner = new Int32Array(board.length).fill(-1)
  const stack: TypePlacement[] = []
  const tierCount = Math.max(0, ...input.pieces.map((piece) => piece.tier + 1))
  const placedByTier = new Array<number>(tierCount).fill(0)
  const otherPiecesMax = Math.max(0, input.pieces.length - 1)

  const boosterCopies = types.flatMap((type, typeIndex) =>
    type.wantsNeighbors ? type.pieceIds.map(() => typeIndex) : [],
  )

  let freeCells = board.length
  let cellsCovered = 0
  let explored = 0
  let timedOut = false
  let scoringNeighbors = false
  let tierFloor: number[] | null = null
  let deadline = started + (boosterCopies.length > 0 ? input.timeLimitMs * FIT_PHASE_SHARE : input.timeLimitMs)
  const best: { score: Score; key: string; placements: TypePlacement[] }[] = []

  const fits = (placement: TypePlacement) =>
    remaining[placement.typeIndex] > 0 && placement.cellIndices.every((index) => occupied[index] === FREE)

  const countUncoverableCells = (): number => {
    let uncoverable = 0
    for (let index = 0; index < board.length; index++) {
      if (occupied[index] === FREE && !coveringPlacements[index].some(fits)) uncoverable++
    }
    return uncoverable
  }

  const neighborsOfPlacement = (stackIndex: number): { touching: number; undecided: number } => {
    const touching = new Set<number>()
    let undecided = 0
    const seenCells = new Set<number>()
    for (const cell of stack[stackIndex].cellIndices) {
      for (const neighbor of neighborIndices[cell]) {
        if (seenCells.has(neighbor)) continue
        seenCells.add(neighbor)
        if (owner[neighbor] >= 0 && owner[neighbor] !== stackIndex) touching.add(owner[neighbor])
        else if (occupied[neighbor] === FREE) undecided++
      }
    }
    return { touching: touching.size, undecided }
  }

  const neighborScoreBound = (): number => {
    if (!scoringNeighbors) return 0
    const piecesLeft = sum(remaining)
    let bound = 0
    stack.forEach((placement, stackIndex) => {
      if (!types[placement.typeIndex].wantsNeighbors) return
      const { touching, undecided } = neighborsOfPlacement(stackIndex)
      bound += touching + Math.min(undecided, piecesLeft)
    })
    types.forEach((type, typeIndex) => {
      if (type.wantsNeighbors) bound += remaining[typeIndex] * otherPiecesMax
    })
    return bound
  }

  const currentNeighborScore = (): number =>
    sum(
      stack.map((placement, stackIndex) =>
        types[placement.typeIndex].wantsNeighbors ? neighborsOfPlacement(stackIndex).touching : 0,
      ),
    )

  const upperBound = (usableCells: number, onlyPlaceableTypes: boolean): Score => {
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
    const cellsBound = Math.min(largestSubsetSumAtMost(sizesByTier.flat(), usableCells), largestCellsAtThoseCounts)
    return [...countsByTier, neighborScoreBound(), cellsCovered + cellsBound]
  }

  const cannotBeatKept = (bound: Score): boolean =>
    (tierFloor !== null && compareScores(bound.slice(0, tierCount), tierFloor) < 0) ||
    (best.length >= input.maxSolutions && compareScores(bound, best[best.length - 1].score) <= 0)

  const record = () => {
    const score = [...placedByTier, scoringNeighbors ? currentNeighborScore() : 0, cellsCovered]
    if (cannotBeatKept(score)) return
    const key = layoutKey(stack)
    if (best.some((kept) => kept.key === key)) return
    best.push({ score, key, placements: [...stack] })
    best.sort((a, b) => compareScores(b.score, a.score))
    if (best.length > input.maxSolutions) best.pop()
  }

  const search = (start: number): void => {
    if (timedOut) return
    explored++
    if (explored % CLOCK_CHECK_INTERVAL === 0 && performance.now() > deadline) {
      timedOut = true
      return
    }

    let cell = start
    while (cell < board.length && occupied[cell]) cell++
    if (cannotBeatKept(upperBound(freeCells, false))) return
    if (cannotBeatKept(upperBound(freeCells - countUncoverableCells(), true))) return
    if (cell === board.length) {
      record()
      return
    }

    for (let typeIndex = 0; typeIndex < types.length; typeIndex++) {
      if (remaining[typeIndex] === 0) continue
      const type = types[typeIndex]
      for (const placement of byFirstCell[cell][typeIndex]) {
        if (placement.cellIndices.some((index) => occupied[index])) continue
        const stackIndex = stack.length
        for (const index of placement.cellIndices) {
          occupied[index] = FILLED
          owner[index] = stackIndex
        }
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
        for (const index of placement.cellIndices) {
          occupied[index] = FREE
          owner[index] = -1
        }
        if (timedOut) return
      }
    }

    occupied[cell] = LEFT_EMPTY
    freeCells--
    search(cell + 1)
    freeCells++
    occupied[cell] = FREE
  }

  const boardNeighborCount = (placement: TypePlacement): number => {
    const inside = new Set(placement.cellIndices)
    const around = new Set(placement.cellIndices.flatMap((index) => neighborIndices[index]))
    return [...around].filter((index) => !inside.has(index)).length
  }
  const boardCenter = {
    i: sum(board.map((cell) => cell.i)) / board.length,
    j: sum(board.map((cell) => cell.j)) / board.length,
  }
  const distanceFromCenter = (placement: TypePlacement): number => {
    const cells = placement.cellIndices.map((index) => board[index])
    const di = sum(cells.map((cell) => cell.i)) / cells.length - boardCenter.i
    const dj = sum(cells.map((cell) => cell.j)) / cells.length - boardCenter.j
    return (Math.abs(di) + Math.abs(dj) + Math.abs(di + dj)) / 2
  }
  const boosterPlacements = types.map((_, typeIndex) =>
    [...placementsOfType[typeIndex]].sort(
      (a, b) => boardNeighborCount(b) - boardNeighborCount(a) || distanceFromCenter(a) - distanceFromCenter(b),
    ),
  )

  const placeBoostersThenSearch = (copy: number): void => {
    if (timedOut) return
    if (cannotBeatKept(upperBound(freeCells, false))) return
    if (copy === boosterCopies.length) {
      search(0)
      return
    }
    const typeIndex = boosterCopies[copy]
    const type = types[typeIndex]
    for (const placement of boosterPlacements[typeIndex]) {
      if (!fits(placement)) continue
      const stackIndex = stack.length
      for (const index of placement.cellIndices) {
        occupied[index] = FILLED
        owner[index] = stackIndex
      }
      remaining[typeIndex]--
      freeCells -= type.size
      cellsCovered += type.size
      placedByTier[type.tier]++
      stack.push(placement)

      placeBoostersThenSearch(copy + 1)

      stack.pop()
      placedByTier[type.tier]--
      cellsCovered -= type.size
      freeCells += type.size
      remaining[typeIndex]++
      for (const index of placement.cellIndices) {
        occupied[index] = FREE
        owner[index] = -1
      }
      if (timedOut) return
    }
    remaining[typeIndex]--
    placeBoostersThenSearch(copy + 1)
    remaining[typeIndex]++
  }

  search(0)
  let complete = !timedOut

  if (boosterCopies.length > 0) {
    for (const kept of best) {
      kept.score[tierCount] = neighborScoreOfLayout(kept.placements, types, neighborIndices)
    }
    best.sort((a, b) => compareScores(b.score, a.score))
    tierFloor = best.length > 0 ? best[0].score.slice(0, tierCount) : null
    scoringNeighbors = true
    timedOut = false
    deadline = started + input.timeLimitMs
    placeBoostersThenSearch(0)
    complete = complete && !timedOut
  }

  const piecesById = new Map(input.pieces.map((piece) => [piece.id, piece]))
  const solutions = best.map(({ placements }) =>
    toSolution(placements, types, board, neighborIndices, piecesById, tierCount),
  )
  return {
    solutions,
    complete,
    explored,
    elapsedMs: performance.now() - started,
  }
}

function layoutKey(placements: TypePlacement[]): string {
  return placements
    .map((placement) => `${placement.typeIndex}:${[...placement.cellIndices].sort((a, b) => a - b).join(',')}`)
    .sort()
    .join('|')
}

function neighborCountsOfLayout(placements: TypePlacement[], neighborIndices: number[][]): number[] {
  const ownerByCell = new Map<number, number>()
  placements.forEach((placement, index) => {
    for (const cell of placement.cellIndices) ownerByCell.set(cell, index)
  })
  return placements.map((placement, index) => {
    const touching = new Set<number>()
    for (const cell of placement.cellIndices) {
      for (const neighbor of neighborIndices[cell]) {
        const neighborOwner = ownerByCell.get(neighbor)
        if (neighborOwner !== undefined && neighborOwner !== index) touching.add(neighborOwner)
      }
    }
    return touching.size
  })
}

function neighborScoreOfLayout(placements: TypePlacement[], types: PieceType[], neighborIndices: number[][]): number {
  const counts = neighborCountsOfLayout(placements, neighborIndices)
  return sum(placements.map((placement, index) => (types[placement.typeIndex].wantsNeighbors ? counts[index] : 0)))
}

function toSolution(
  placements: TypePlacement[],
  types: PieceType[],
  board: Cell[],
  neighborIndices: number[][],
  piecesById: Map<number, SolverPiece>,
  tierCount: number,
): Solution {
  const neighborCounts = neighborCountsOfLayout(placements, neighborIndices)

  const nextCopy = types.map(() => 0)
  const resolved = placements.flatMap((placement, stackIndex) => {
    const type = types[placement.typeIndex]
    const piece = piecesById.get(type.pieceIds[nextCopy[placement.typeIndex]++])
    if (!piece) return []
    const targetCells = placement.cellIndices.map((index) => board[index])
    const neighborCount = type.wantsNeighbors ? neighborCounts[stackIndex] : null
    return [{ ...orientPiece(piece, targetCells), neighborCount, tier: type.tier }]
  })
  return {
    placements: resolved.map(({ pieceId, rotation, cells, neighborCount }) => ({ pieceId, rotation, cells, neighborCount })),
    placedByTier: Array.from(
      { length: tierCount },
      (_, tier) => resolved.filter((placement) => placement.tier === tier).length,
    ),
    neighborScore: sum(resolved.map((placement) => placement.neighborCount ?? 0)),
    cellsCovered: sum(resolved.map((placement) => placement.cells.length)),
  }
}

function orientPiece(piece: SolverPiece, targetCells: Cell[]): Omit<Placement, 'neighborCount'> {
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
