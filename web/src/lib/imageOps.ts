export type RgbaImage = { width: number; height: number; data: ArrayLike<number> }

export type HsvImage = {
  width: number
  height: number
  hue: Float32Array
  saturation: Float32Array
  value: Float32Array
}

export type Components = {
  labels: Int32Array
  count: number
  areas: number[]
  centroids: { x: number; y: number }[]
}

export function toHsv(image: RgbaImage): HsvImage {
  const size = image.width * image.height
  const hue = new Float32Array(size)
  const saturation = new Float32Array(size)
  const value = new Float32Array(size)
  for (let p = 0; p < size; p++) {
    const r = image.data[p * 4] / 255
    const g = image.data[p * 4 + 1] / 255
    const b = image.data[p * 4 + 2] / 255
    const max = Math.max(r, g, b)
    const delta = max - Math.min(r, g, b)
    value[p] = max
    saturation[p] = max === 0 ? 0 : delta / max
    hue[p] = delta === 0 ? 0 : hueDegrees(r, g, b, max, delta)
  }
  return { width: image.width, height: image.height, hue, saturation, value }
}

function hueDegrees(r: number, g: number, b: number, max: number, delta: number): number {
  let sector: number
  if (max === r) sector = ((g - b) / delta) % 6
  else if (max === g) sector = (b - r) / delta + 2
  else sector = (r - g) / delta + 4
  const degrees = sector * 60
  return degrees < 0 ? degrees + 360 : degrees
}

export function hueDistance(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360
  return Math.min(difference, 360 - difference)
}

export function fillHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
  const reached = new Uint8Array(mask.length)
  const stack = new Int32Array(mask.length)
  let top = 0
  const visit = (p: number) => {
    if (!mask[p] && !reached[p]) {
      reached[p] = 1
      stack[top++] = p
    }
  }
  for (let x = 0; x < width; x++) {
    visit(x)
    visit((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    visit(y * width)
    visit(y * width + width - 1)
  }
  while (top > 0) {
    const p = stack[--top]
    const x = p % width
    if (x > 0) visit(p - 1)
    if (x < width - 1) visit(p + 1)
    if (p >= width) visit(p - width)
    if (p < mask.length - width) visit(p + width)
  }
  const filled = new Uint8Array(mask.length)
  for (let p = 0; p < mask.length; p++) filled[p] = reached[p] ? 0 : 1
  return filled
}

const FAR_AWAY = 1e20

export function distanceTransform(mask: Uint8Array, width: number, height: number): Float32Array {
  const squared = new Float64Array(mask.length)
  for (let p = 0; p < mask.length; p++) squared[p] = mask[p] ? FAR_AWAY : 0

  const longest = Math.max(width, height)
  const line = new Float64Array(longest)
  const result = new Float64Array(longest)
  const parabolaSites = new Int32Array(longest)
  const boundaries = new Float64Array(longest + 1)

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) line[y] = squared[y * width + x]
    squaredDistance1d(line, height, result, parabolaSites, boundaries)
    for (let y = 0; y < height; y++) squared[y * width + x] = result[y]
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) line[x] = squared[y * width + x]
    squaredDistance1d(line, width, result, parabolaSites, boundaries)
    for (let x = 0; x < width; x++) squared[y * width + x] = result[x]
  }

  const distance = new Float32Array(mask.length)
  for (let p = 0; p < mask.length; p++) distance[p] = Math.sqrt(squared[p])
  return distance
}

function squaredDistance1d(
  f: Float64Array,
  n: number,
  out: Float64Array,
  sites: Int32Array,
  boundaries: Float64Array,
): void {
  let k = 0
  sites[0] = 0
  boundaries[0] = -FAR_AWAY
  boundaries[1] = FAR_AWAY
  const intersection = (q: number, v: number) => (f[q] + q * q - (f[v] + v * v)) / (2 * q - 2 * v)
  for (let q = 1; q < n; q++) {
    let s = intersection(q, sites[k])
    while (s <= boundaries[k]) {
      k--
      s = intersection(q, sites[k])
    }
    k++
    sites[k] = q
    boundaries[k] = s
    boundaries[k + 1] = FAR_AWAY
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (boundaries[k + 1] < q) k++
    const v = sites[k]
    out[q] = (q - v) * (q - v) + f[v]
  }
}

export function labelComponents(mask: Uint8Array, width: number, height: number): Components {
  const labels = new Int32Array(mask.length)
  const stack = new Int32Array(mask.length)
  const areas: number[] = [0]
  const centroids = [{ x: 0, y: 0 }]
  let count = 0
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    count++
    let top = 0
    let area = 0
    let sumX = 0
    let sumY = 0
    labels[start] = count
    stack[top++] = start
    while (top > 0) {
      const p = stack[--top]
      const x = p % width
      const y = (p - x) / width
      area++
      sumX += x
      sumY += y
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          const neighbor = ny * width + nx
          if (mask[neighbor] && !labels[neighbor]) {
            labels[neighbor] = count
            stack[top++] = neighbor
          }
        }
      }
    }
    areas.push(area)
    centroids.push({ x: sumX / area, y: sumY / area })
  }
  return { labels, count, areas, centroids }
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
