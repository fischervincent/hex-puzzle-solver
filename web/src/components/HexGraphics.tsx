import { cellCenter, cellKey, hexPoints, type Cell, type Link, type Point } from '../lib/hex'

export type DrawnPiece = { key: string; cells: Cell[]; links: Link[]; color: string; label: string }

const NODE_OUTLINE = '#1b1638'

type Box = { x: number; y: number; width: number; height: number }

function boundsAround(cells: Cell[], size: number, angleDeg: number): Box {
  if (cells.length === 0) return { x: 0, y: 0, width: 10, height: 10 }
  const centers = cells.map((cell) => cellCenter(cell, size, angleDeg))
  const minX = Math.min(...centers.map((c) => c.x)) - size * 1.1
  const minY = Math.min(...centers.map((c) => c.y)) - size * 1.1
  const maxX = Math.max(...centers.map((c) => c.x)) + size * 1.1
  const maxY = Math.max(...centers.map((c) => c.y)) + size * 1.1
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function viewBoxOf(box: Box): string {
  return `${box.x} ${box.y} ${box.width} ${box.height}`
}

export function PieceNodes({ piece, size, angleDeg }: { piece: DrawnPiece; size: number; angleDeg: number }) {
  const centers: Point[] = piece.cells.map((cell) => cellCenter(cell, size, angleDeg))
  return (
    <g>
      {piece.links.map(([a, b]) => (
        <g key={`${a}-${b}`}>
          <line
            x1={centers[a].x}
            y1={centers[a].y}
            x2={centers[b].x}
            y2={centers[b].y}
            stroke={NODE_OUTLINE}
            strokeWidth={size * 0.42}
          />
          <line
            x1={centers[a].x}
            y1={centers[a].y}
            x2={centers[b].x}
            y2={centers[b].y}
            stroke={piece.color}
            strokeWidth={size * 0.3}
          />
        </g>
      ))}
      {centers.map((center, index) => (
        <g key={index}>
          <polygon
            points={hexPoints(center, size * 0.6, angleDeg)}
            fill={piece.color}
            stroke={NODE_OUTLINE}
            strokeWidth={size * 0.07}
          />
          <text
            x={center.x}
            y={center.y}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={size * 0.5}
            fontWeight={700}
            fill={NODE_OUTLINE}
          >
            {piece.label}
          </text>
        </g>
      ))}
    </g>
  )
}

type BoardViewProps = {
  board: Cell[]
  angleDeg: number
  pieces?: DrawnPiece[]
  candidates?: Cell[]
  onToggleCell?: (cell: Cell) => void
}

const BOARD_HEX_SIZE = 20

export function BoardView({ board, angleDeg, pieces = [], candidates = [], onToggleCell }: BoardViewProps) {
  const size = BOARD_HEX_SIZE
  const editable = onToggleCell !== undefined
  return (
    <svg className="board-svg" viewBox={viewBoxOf(boundsAround([...board, ...candidates], size, angleDeg))}>
      {candidates.map((cell) => (
        <polygon
          key={`candidate-${cellKey(cell)}`}
          className="cell-candidate"
          points={hexPoints(cellCenter(cell, size, angleDeg), size * 0.9, angleDeg)}
          onClick={() => onToggleCell?.(cell)}
        />
      ))}
      {board.map((cell) => (
        <polygon
          key={`cell-${cellKey(cell)}`}
          className={editable ? 'cell cell-editable' : 'cell'}
          points={hexPoints(cellCenter(cell, size, angleDeg), size * 0.9, angleDeg)}
          strokeWidth={size * 0.1}
          onClick={() => onToggleCell?.(cell)}
        />
      ))}
      <g pointerEvents="none">
        {pieces.map((piece) => (
          <PieceNodes key={piece.key} piece={piece} size={size} angleDeg={angleDeg} />
        ))}
      </g>
    </svg>
  )
}

const PIECE_HEX_SIZE = 14
const PIECE_ZOOM = 1.5

export function PieceView({ piece, angleDeg }: { piece: DrawnPiece; angleDeg: number }) {
  const box = boundsAround(piece.cells, PIECE_HEX_SIZE, angleDeg)
  return (
    <svg className="piece-svg" viewBox={viewBoxOf(box)} width={box.width * PIECE_ZOOM} height={box.height * PIECE_ZOOM}>
      <PieceNodes piece={piece} size={PIECE_HEX_SIZE} angleDeg={angleDeg} />
    </svg>
  )
}
