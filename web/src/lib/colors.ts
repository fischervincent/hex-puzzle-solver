import type { DetectedPiece } from './detect'
import { hueDistance } from './imageOps'

export type ColorClass = { id: string; name: string; color: string; hue: number; pieceIds: number[] }

const SAME_COLOR_MAX_HUE_DISTANCE = 20

const HUE_NAMES: [number, string][] = [
  [15, 'Red'],
  [45, 'Orange'],
  [70, 'Yellow'],
  [165, 'Green'],
  [250, 'Blue'],
  [290, 'Purple'],
  [335, 'Pink'],
  [360, 'Red'],
]

function hueName(hue: number): string {
  return HUE_NAMES.find(([limit]) => hue < limit)?.[1] ?? 'Red'
}

export function groupByColor(pieces: DetectedPiece[]): ColorClass[] {
  const classes: ColorClass[] = []
  for (const piece of pieces) {
    const match = classes.find((colorClass) => hueDistance(colorClass.hue, piece.hue) <= SAME_COLOR_MAX_HUE_DISTANCE)
    if (match) {
      match.pieceIds.push(piece.id)
      continue
    }
    const name = hueName(piece.hue)
    classes.push({ id: `${name}-${classes.length}`, name, color: piece.color, hue: piece.hue, pieceIds: [piece.id] })
  }
  return classes
}
