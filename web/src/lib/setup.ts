import { lastRowAndColumnCells, type Cell, type Link } from './hex'
import type { SolverInput } from './solver'

export type Importance = 'mandatory' | 'high' | 'medium' | 'optional' | 'skip'

export const IMPORTANCE_LEVELS: Importance[] = ['mandatory', 'high', 'medium', 'optional', 'skip']
export const RANKED_LEVELS: Importance[] = ['mandatory', 'high', 'medium', 'optional']

export type SetupPiece = {
  label: string
  color: string
  hue: number
  cells: Cell[]
  links: Link[]
  boardCells: Cell[] | null
  importance: Importance
  wantsNeighbors: boolean
  rotatable: boolean
  avoidEdge: boolean
}

export type Setup = {
  version: 1
  angle: number
  board: Cell[]
  timeLimitMs: number
  pieces: SetupPiece[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCell(value: unknown): value is Cell {
  return isRecord(value) && typeof value.i === 'number' && typeof value.j === 'number'
}

function isCellList(value: unknown): value is Cell[] {
  return Array.isArray(value) && value.every(isCell)
}

function isLink(value: unknown): value is Link {
  return Array.isArray(value) && value.length === 2 && value.every((end) => typeof end === 'number')
}

function isImportance(value: unknown): value is Importance {
  return IMPORTANCE_LEVELS.some((level) => level === value)
}

function isSetupPiece(value: unknown): value is SetupPiece {
  return (
    isRecord(value) &&
    typeof value.label === 'string' &&
    typeof value.color === 'string' &&
    typeof value.hue === 'number' &&
    isCellList(value.cells) &&
    Array.isArray(value.links) &&
    value.links.every(isLink) &&
    (value.boardCells === null || isCellList(value.boardCells)) &&
    isImportance(value.importance) &&
    typeof value.wantsNeighbors === 'boolean' &&
    typeof value.rotatable === 'boolean' &&
    typeof value.avoidEdge === 'boolean'
  )
}

export function parseSetup(text: string): Setup {
  const value: unknown = JSON.parse(text)
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.angle !== 'number' ||
    typeof value.timeLimitMs !== 'number' ||
    !isCellList(value.board) ||
    !Array.isArray(value.pieces) ||
    !value.pieces.every(isSetupPiece)
  ) {
    throw new Error('This file is not a Hexfit setup.')
  }
  return {
    version: 1,
    angle: value.angle,
    board: value.board,
    timeLimitMs: value.timeLimitMs,
    pieces: value.pieces,
  }
}

export function setupToSolverInput(setup: Setup, maxSolutions: number): SolverInput {
  return {
    board: setup.board,
    edgeCells: setup.board.length > 0 ? lastRowAndColumnCells(setup.board, setup.angle) : [],
    pieces: setup.pieces.flatMap((piece, index) =>
      piece.importance === 'skip'
        ? []
        : [
            {
              id: index,
              cells: piece.cells,
              rotatable: piece.rotatable,
              tier: RANKED_LEVELS.indexOf(piece.importance),
              wantsNeighbors: piece.wantsNeighbors,
              avoidEdge: piece.avoidEdge,
            },
          ],
    ),
    maxSolutions,
    timeLimitMs: setup.timeLimitMs,
  }
}
