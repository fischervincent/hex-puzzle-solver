import { HEX_NEIGHBORS, addCells, cellKey, translateToOrigin, type Cell, type Link, type Point, type Shape } from './hex'
import {
  distanceTransform,
  fillHoles,
  hueDistance,
  labelComponents,
  median,
  toHsv,
  type HsvImage,
  type RgbaImage,
} from './imageOps'

const MIN_SATURATION = 0.47
const MIN_VALUE = 0.47
const MIN_NODE_CORE_AREA = 20
const NODE_CORE_RATIO = 0.6
const LARGE_BLOB_PERCENTILE = 0.9
const NODE_SIZE_TOLERANCE = 0.6
const RIM_SAMPLE_COUNT = 48
const RIM_RADIUS_RATIO = 0.8
const MIN_RIM_COVERAGE = 0.75
const DISK_RADIUS_RATIO = 0.95
const MIN_DISK_COVERAGE = 0.64
const NEIGHBOR_MIN_PITCHES = 0.65
const NEIGHBOR_MAX_PITCHES = 1.35
const BAR_SAMPLE_COUNT = 30
const BAR_MATCH_RATIO = 0.75
const BAR_SEGMENT_START = 0.3
const BAR_SEGMENT_END = 0.7
const MAX_HUE_DIFFERENCE = 24
const OUTLINE_MAX_SATURATION = 0.2
const OUTLINE_MIN_VALUE = 0.17
const OUTLINE_MAX_VALUE = 0.55
const OUTLINE_SCALES = [0.9, 0.95, 1]
const OUTLINE_SAMPLES_PER_EDGE = 12
const OUTLINE_MIN_RATIO = 0.6
const MAX_ON_BOARD_RESIDUAL = 0.3

export type DetectedNode = Point & { hue: number; color: string }

export type Lattice = { origin: Point; e1: Point; e2: Point }

export type DetectedPiece = {
  id: number
  shape: Shape
  hue: number
  color: string
  nodes: DetectedNode[]
  boardCells: Cell[] | null
}

export type Detection = {
  pieces: DetectedPiece[]
  board: Cell[]
  lattice: Lattice | null
  displayAngle: number
  nodeRadius: number
}

export function detect(image: RgbaImage): Detection {
  const hsv = toHsv(image)
  const colored = coloredMask(hsv)
  const { nodes, nodeRadius } = findNodes(image, hsv, colored)
  if (nodes.length === 0) {
    return { pieces: [], board: [], lattice: null, displayAngle: 30, nodeRadius: 0 }
  }

  const pitch = cellPitch(nodes)
  const neighborPairs = findNeighborPairs(nodes, pitch)
  const links = neighborPairs.filter(([a, b]) => isBarBetween(hsv, colored, nodes[a], nodes[b]))
  const groups = groupByLinks(nodes.length, links)

  const { lattice, phaseDegrees } = fitLattice(nodes, neighborPairs, pitch)
  const board = detectBoardCells(hsv, colored, lattice)
  const boardKeys = new Set(board.map(cellKey))

  const pieces = groups
    .map((memberIndices) => buildPiece(memberIndices, nodes, links, lattice, boardKeys))
    .sort((a, b) => minY(a.nodes) - minY(b.nodes) || minX(a.nodes) - minX(b.nodes))
    .map((piece, index) => ({ ...piece, id: index }))

  return {
    pieces,
    board,
    lattice,
    displayAngle: Math.round(phaseDegrees / 30) % 2 === 1 ? 30 : 0,
    nodeRadius,
  }
}

function minY(nodes: Point[]): number {
  return Math.min(...nodes.map((node) => node.y))
}

function minX(nodes: Point[]): number {
  return Math.min(...nodes.map((node) => node.x))
}

function coloredMask(hsv: HsvImage): Uint8Array {
  const mask = new Uint8Array(hsv.hue.length)
  for (let p = 0; p < mask.length; p++) {
    mask[p] = hsv.saturation[p] >= MIN_SATURATION && hsv.value[p] >= MIN_VALUE ? 1 : 0
  }
  return mask
}

function findNodes(
  image: RgbaImage,
  hsv: HsvImage,
  colored: Uint8Array,
): { nodes: DetectedNode[]; nodeRadius: number } {
  const { width, height } = hsv
  const filled = fillHoles(colored, width, height)
  const distance = distanceTransform(filled, width, height)
  const blobs = labelComponents(filled, width, height)

  const blobRadii = new Array<number>(blobs.count + 1).fill(0)
  for (let p = 0; p < distance.length; p++) {
    const label = blobs.labels[p]
    if (label && distance[p] > blobRadii[label]) blobRadii[label] = distance[p]
  }
  const nodeRadius = estimateNodeRadius(
    blobRadii.filter((_, label) => label > 0 && blobs.areas[label] >= MIN_NODE_CORE_AREA),
  )
  if (nodeRadius === 0) return { nodes: [], nodeRadius: 0 }

  const cores = new Uint8Array(distance.length)
  for (let p = 0; p < distance.length; p++) cores[p] = distance[p] > nodeRadius * NODE_CORE_RATIO ? 1 : 0
  const coreComponents = labelComponents(cores, width, height)

  const nodes: DetectedNode[] = []
  for (let label = 1; label <= coreComponents.count; label++) {
    if (coreComponents.areas[label] < MIN_NODE_CORE_AREA) continue
    const center = coreComponents.centroids[label]
    if (rimCoverage(colored, width, height, center, nodeRadius) < MIN_RIM_COVERAGE) continue
    if (diskCoverage(colored, width, height, center, nodeRadius) < MIN_DISK_COVERAGE) continue
    nodes.push({ ...center, ...nodeColor(image, hsv, colored, center, nodeRadius) })
  }
  return { nodes, nodeRadius }
}

function estimateNodeRadius(blobRadii: number[]): number {
  if (blobRadii.length === 0) return 0
  const sorted = [...blobRadii].sort((a, b) => a - b)
  const reference = sorted[Math.floor((sorted.length - 1) * LARGE_BLOB_PERCENTILE)]
  return median(sorted.filter((radius) => radius >= reference * NODE_SIZE_TOLERANCE))
}

function rimCoverage(colored: Uint8Array, width: number, height: number, center: Point, radius: number): number {
  let covered = 0
  for (let sample = 0; sample < RIM_SAMPLE_COUNT; sample++) {
    const angle = (sample / RIM_SAMPLE_COUNT) * Math.PI * 2
    const x = Math.round(center.x + Math.cos(angle) * radius * RIM_RADIUS_RATIO)
    const y = Math.round(center.y + Math.sin(angle) * radius * RIM_RADIUS_RATIO)
    if (x >= 0 && y >= 0 && x < width && y < height && colored[y * width + x]) covered++
  }
  return covered / RIM_SAMPLE_COUNT
}

function diskCoverage(colored: Uint8Array, width: number, height: number, center: Point, radius: number): number {
  const reach = radius * DISK_RADIUS_RATIO
  let inside = 0
  let covered = 0
  for (let y = Math.floor(center.y - reach); y <= Math.ceil(center.y + reach); y++) {
    for (let x = Math.floor(center.x - reach); x <= Math.ceil(center.x + reach); x++) {
      if ((x - center.x) ** 2 + (y - center.y) ** 2 > reach * reach) continue
      inside++
      if (x >= 0 && y >= 0 && x < width && y < height && colored[y * width + x]) covered++
    }
  }
  return inside === 0 ? 0 : covered / inside
}

function nodeColor(
  image: RgbaImage,
  hsv: HsvImage,
  colored: Uint8Array,
  center: Point,
  radius: number,
): { hue: number; color: string } {
  let hueX = 0
  let hueY = 0
  const reds: number[] = []
  const greens: number[] = []
  const blues: number[] = []
  const r = Math.ceil(radius)
  for (let y = Math.max(0, Math.round(center.y) - r); y <= Math.min(hsv.height - 1, Math.round(center.y) + r); y++) {
    for (let x = Math.max(0, Math.round(center.x) - r); x <= Math.min(hsv.width - 1, Math.round(center.x) + r); x++) {
      const p = y * hsv.width + x
      if (!colored[p] || (x - center.x) ** 2 + (y - center.y) ** 2 > radius * radius) continue
      const angle = (hsv.hue[p] * Math.PI) / 180
      hueX += Math.cos(angle)
      hueY += Math.sin(angle)
      reds.push(image.data[p * 4])
      greens.push(image.data[p * 4 + 1])
      blues.push(image.data[p * 4 + 2])
    }
  }
  const hue = ((Math.atan2(hueY, hueX) * 180) / Math.PI + 360) % 360
  return { hue, color: rgbToHex(median(reds), median(greens), median(blues)) }
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function cellPitch(nodes: Point[]): number {
  if (nodes.length < 2) return 1
  return median(
    nodes.map((a) => Math.min(...nodes.filter((b) => b !== a).map((b) => distanceBetween(a, b)))),
  )
}

function findNeighborPairs(nodes: Point[], pitch: number): Link[] {
  const pairs: Link[] = []
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const distance = distanceBetween(nodes[a], nodes[b])
      if (distance >= pitch * NEIGHBOR_MIN_PITCHES && distance <= pitch * NEIGHBOR_MAX_PITCHES) pairs.push([a, b])
    }
  }
  return pairs
}

function isBarBetween(hsv: HsvImage, colored: Uint8Array, a: DetectedNode, b: DetectedNode): boolean {
  if (hueDistance(a.hue, b.hue) > MAX_HUE_DIFFERENCE) return false
  let matches = 0
  for (let sample = 0; sample < BAR_SAMPLE_COUNT; sample++) {
    const t = BAR_SEGMENT_START + ((BAR_SEGMENT_END - BAR_SEGMENT_START) * sample) / (BAR_SAMPLE_COUNT - 1)
    const p = Math.round(a.y + (b.y - a.y) * t) * hsv.width + Math.round(a.x + (b.x - a.x) * t)
    if (colored[p] && hueDistance(hsv.hue[p], a.hue) <= MAX_HUE_DIFFERENCE) matches++
  }
  return matches / BAR_SAMPLE_COUNT >= BAR_MATCH_RATIO
}

function groupByLinks(nodeCount: number, links: Link[]): number[][] {
  const parent = Array.from({ length: nodeCount }, (_, index) => index)
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]]
      index = parent[index]
    }
    return index
  }
  for (const [a, b] of links) parent[root(a)] = root(b)

  const groups = new Map<number, number[]>()
  for (let index = 0; index < nodeCount; index++) {
    const key = root(index)
    groups.set(key, [...(groups.get(key) ?? []), index])
  }
  return [...groups.values()]
}

type Matrix2 = { a: number; b: number; c: number; d: number }

function inverseBasis(e1: Point, e2: Point): Matrix2 {
  const determinant = e1.x * e2.y - e2.x * e1.y
  return { a: e2.y / determinant, b: -e2.x / determinant, c: -e1.y / determinant, d: e1.x / determinant }
}

function applyMatrix(m: Matrix2, v: Point): { i: number; j: number } {
  return { i: m.a * v.x + m.b * v.y, j: m.c * v.x + m.d * v.y }
}

export function latticeCoordinates(lattice: Lattice, point: Point): { i: number; j: number } {
  return applyMatrix(inverseBasis(lattice.e1, lattice.e2), {
    x: point.x - lattice.origin.x,
    y: point.y - lattice.origin.y,
  })
}

export function latticePoint(lattice: Lattice, cell: { i: number; j: number }): Point {
  return {
    x: lattice.origin.x + cell.i * lattice.e1.x + cell.j * lattice.e2.x,
    y: lattice.origin.y + cell.i * lattice.e1.y + cell.j * lattice.e2.y,
  }
}

function estimateBasis(nodes: Point[], pairs: Link[], pitch: number): { e1: Point; e2: Point; phase: number } {
  const vectors = pairs.map(([a, b]) => {
    const vector = { x: nodes[b].x - nodes[a].x, y: nodes[b].y - nodes[a].y }
    return vector.y < 0 || (vector.y === 0 && vector.x < 0) ? { x: -vector.x, y: -vector.y } : vector
  })

  let sumCos = 0
  let sumSin = 0
  for (const vector of vectors) {
    const angle = Math.atan2(vector.y, vector.x)
    sumCos += Math.cos(6 * angle)
    sumSin += Math.sin(6 * angle)
  }
  const sixtyDegrees = Math.PI / 3
  let phase = Math.atan2(sumSin, sumCos) / 6
  if (phase < 0) phase += sixtyDegrees

  const clusters: Point[][] = [[], [], []]
  for (const vector of vectors) {
    const steps = Math.round((Math.atan2(vector.y, vector.x) - phase) / sixtyDegrees)
    const sign = steps >= 0 && steps <= 2 ? 1 : -1
    clusters[((steps % 3) + 3) % 3].push({ x: sign * vector.x, y: sign * vector.y })
  }

  const directionAt = (k: number): Point => {
    const cluster = clusters[k]
    if (cluster.length > 0) return { x: median(cluster.map((v) => v.x)), y: median(cluster.map((v) => v.y)) }
    const angle = phase + k * sixtyDegrees
    return { x: pitch * Math.cos(angle), y: pitch * Math.sin(angle) }
  }
  return { e1: directionAt(0), e2: directionAt(1), phase }
}

function fitLattice(nodes: Point[], pairs: Link[], pitch: number): { lattice: Lattice; phaseDegrees: number } {
  const { e1, e2, phase } = estimateBasis(nodes, pairs, pitch)
  const phaseDegrees = (phase * 180) / Math.PI
  const inverse = inverseBasis(e1, e2)

  const adjacency: number[][] = nodes.map(() => [])
  for (const [a, b] of pairs) {
    adjacency[a].push(b)
    adjacency[b].push(a)
  }

  const coordinates: (Cell | null)[] = nodes.map(() => null)
  let largestComponent: number[] = []
  for (let seed = 0; seed < nodes.length; seed++) {
    if (coordinates[seed]) continue
    coordinates[seed] = { i: 0, j: 0 }
    const component = [seed]
    for (let cursor = 0; cursor < component.length; cursor++) {
      const current = component[cursor]
      const currentCell = coordinates[current]
      if (!currentCell) continue
      for (const neighbor of adjacency[current]) {
        if (coordinates[neighbor]) continue
        const step = applyMatrix(inverse, {
          x: nodes[neighbor].x - nodes[current].x,
          y: nodes[neighbor].y - nodes[current].y,
        })
        coordinates[neighbor] = addCells(currentCell, { i: Math.round(step.i), j: Math.round(step.j) })
        component.push(neighbor)
      }
    }
    if (component.length > largestComponent.length) largestComponent = component
  }

  const samples = largestComponent.flatMap((index) => {
    const cell = coordinates[index]
    return cell ? [{ cell, point: nodes[index] }] : []
  })
  const fitted = leastSquaresLattice(samples)
  const fallback = { origin: nodes[largestComponent[0]], e1, e2 }
  return { lattice: fitted ?? fallback, phaseDegrees }
}

function leastSquaresLattice(samples: { cell: Cell; point: Point }[]): Lattice | null {
  if (samples.length < 3) return null
  const normal = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const rightX = [0, 0, 0]
  const rightY = [0, 0, 0]
  for (const { cell, point } of samples) {
    const row = [1, cell.i, cell.j]
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) normal[r][c] += row[r] * row[c]
      rightX[r] += row[r] * point.x
      rightY[r] += row[r] * point.y
    }
  }
  const solutionX = solve3(normal, rightX)
  const solutionY = solve3(normal, rightY)
  if (!solutionX || !solutionY) return null
  return {
    origin: { x: solutionX[0], y: solutionY[0] },
    e1: { x: solutionX[1], y: solutionY[1] },
    e2: { x: solutionX[2], y: solutionY[2] },
  }
}

function determinant3(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

function solve3(m: number[][], rhs: number[]): number[] | null {
  const determinant = determinant3(m)
  if (Math.abs(determinant) < 1e-9) return null
  return [0, 1, 2].map((column) =>
    determinant3(m.map((row, r) => row.map((value, c) => (c === column ? rhs[r] : value)))) / determinant,
  )
}

function hexOutlineOffsets(lattice: Lattice): Point[] {
  const { e1, e2 } = lattice
  const neighbors = HEX_NEIGHBORS.map((n) => ({ x: n.i * e1.x + n.j * e2.x, y: n.i * e1.y + n.j * e2.y }))
  const vertices = neighbors.map((n, k) => {
    const next = neighbors[(k + 1) % 6]
    return { x: (n.x + next.x) / 3, y: (n.y + next.y) / 3 }
  })
  const offsets: Point[] = []
  vertices.forEach((vertex, k) => {
    const next = vertices[(k + 1) % 6]
    for (let sample = 0; sample < OUTLINE_SAMPLES_PER_EDGE; sample++) {
      const t = sample / OUTLINE_SAMPLES_PER_EDGE
      offsets.push({ x: vertex.x + (next.x - vertex.x) * t, y: vertex.y + (next.y - vertex.y) * t })
    }
  })
  return offsets
}

export function hexVertices(lattice: Lattice, cell: Cell, scale: number): Point[] {
  const { e1, e2 } = lattice
  const center = latticePoint(lattice, cell)
  const neighbors = HEX_NEIGHBORS.map((n) => ({ x: n.i * e1.x + n.j * e2.x, y: n.i * e1.y + n.j * e2.y }))
  return neighbors.map((n, k) => {
    const next = neighbors[(k + 1) % 6]
    return { x: center.x + ((n.x + next.x) / 3) * scale, y: center.y + ((n.y + next.y) / 3) * scale }
  })
}

function isOutlinePixel(hsv: HsvImage, p: number): boolean {
  return (
    hsv.saturation[p] < OUTLINE_MAX_SATURATION &&
    hsv.value[p] >= OUTLINE_MIN_VALUE &&
    hsv.value[p] <= OUTLINE_MAX_VALUE
  )
}

function outlineRatio(hsv: HsvImage, colored: Uint8Array, center: Point, offsets: Point[]): number | null {
  let outline = 0
  let dark = 0
  for (const offset of offsets) {
    let sawOutline = false
    let sawColor = false
    for (const scale of OUTLINE_SCALES) {
      const x = Math.round(center.x + offset.x * scale)
      const y = Math.round(center.y + offset.y * scale)
      if (x < 0 || y < 0 || x >= hsv.width || y >= hsv.height) return null
      const p = y * hsv.width + x
      if (colored[p]) sawColor = true
      else if (isOutlinePixel(hsv, p)) sawOutline = true
    }
    if (sawOutline) outline++
    else if (!sawColor) dark++
  }
  const counted = outline + dark
  return counted < offsets.length / 2 ? 0 : outline / counted
}

function detectBoardCells(hsv: HsvImage, colored: Uint8Array, lattice: Lattice): Cell[] {
  const corners = [
    { x: 0, y: 0 },
    { x: hsv.width, y: 0 },
    { x: 0, y: hsv.height },
    { x: hsv.width, y: hsv.height },
  ].map((corner) => latticeCoordinates(lattice, corner))
  const iRange = [Math.floor(Math.min(...corners.map((c) => c.i))), Math.ceil(Math.max(...corners.map((c) => c.i)))]
  const jRange = [Math.floor(Math.min(...corners.map((c) => c.j))), Math.ceil(Math.max(...corners.map((c) => c.j)))]

  const offsets = hexOutlineOffsets(lattice)
  const candidates: Cell[] = []
  for (let i = iRange[0]; i <= iRange[1]; i++) {
    for (let j = jRange[0]; j <= jRange[1]; j++) {
      const ratio = outlineRatio(hsv, colored, latticePoint(lattice, { i, j }), offsets)
      if (ratio !== null && ratio >= OUTLINE_MIN_RATIO) candidates.push({ i, j })
    }
  }
  return largestConnectedRegion(candidates)
}

function largestConnectedRegion(cells: Cell[]): Cell[] {
  const remaining = new Map(cells.map((cell) => [cellKey(cell), cell]))
  let largest: Cell[] = []
  for (const start of cells) {
    if (!remaining.has(cellKey(start))) continue
    remaining.delete(cellKey(start))
    const region = [start]
    for (let cursor = 0; cursor < region.length; cursor++) {
      for (const direction of HEX_NEIGHBORS) {
        const neighbor = addCells(region[cursor], direction)
        if (remaining.delete(cellKey(neighbor))) region.push(neighbor)
      }
    }
    if (region.length > largest.length) largest = region
  }
  return largest
}

function buildPiece(
  memberIndices: number[],
  nodes: DetectedNode[],
  links: Link[],
  lattice: Lattice,
  boardKeys: Set<string>,
): DetectedPiece {
  const members = memberIndices.map((index) => nodes[index])
  const localIndex = new Map(memberIndices.map((global, local) => [global, local]))
  const pieceLinks: Link[] = links.flatMap(([a, b]) => {
    const localA = localIndex.get(a)
    const localB = localIndex.get(b)
    return localA !== undefined && localB !== undefined ? [[localA, localB]] : []
  })

  const inverse = inverseBasis(lattice.e1, lattice.e2)
  const relative = members.map((node) => {
    const step = applyMatrix(inverse, { x: node.x - members[0].x, y: node.y - members[0].y })
    return { i: Math.round(step.i), j: Math.round(step.j) }
  })

  const absolute = members.map((node) => latticeCoordinates(lattice, node))
  const isOnBoard = absolute.every(
    (coords) =>
      Math.hypot(coords.i - Math.round(coords.i), coords.j - Math.round(coords.j)) <= MAX_ON_BOARD_RESIDUAL &&
      boardKeys.has(cellKey({ i: Math.round(coords.i), j: Math.round(coords.j) })),
  )

  const hueX = members.reduce((sum, node) => sum + Math.cos((node.hue * Math.PI) / 180), 0)
  const hueY = members.reduce((sum, node) => sum + Math.sin((node.hue * Math.PI) / 180), 0)

  return {
    id: 0,
    shape: { cells: translateToOrigin(relative), links: pieceLinks },
    hue: ((Math.atan2(hueY, hueX) * 180) / Math.PI + 360) % 360,
    color: members[0].color,
    nodes: members,
    boardCells: isOnBoard
      ? absolute.map((coords) => ({ i: Math.round(coords.i), j: Math.round(coords.j) }))
      : null,
  }
}
