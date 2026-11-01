import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BoardView, PieceView, type DrawnPiece } from './components/HexGraphics'
import { ScreenshotPreview } from './components/ScreenshotPreview'
import { groupByColor, type ColorClass } from './lib/colors'
import { detect, type DetectedPiece, type Detection } from './lib/detect'
import {
  FLAT_TOP_ANGLE,
  HEX_NEIGHBORS,
  addCells,
  cellKey,
  lastRowAndColumnCells,
  rectangularBoard,
  translateToOrigin,
  type Cell,
  type Link,
} from './lib/hex'
import type { Solution, SolverInput, SolverOutput } from './lib/solver'

type Importance = 'mandatory' | 'high' | 'medium' | 'optional' | 'skip'

const IMPORTANCE_LEVELS: Importance[] = ['mandatory', 'high', 'medium', 'optional', 'skip']
const RANKED_LEVELS: Importance[] = ['mandatory', 'high', 'medium', 'optional']
const DEFAULT_IMPORTANCE: Importance = 'medium'

const IMPORTANCE_LABELS: Record<Importance, string> = {
  mandatory: 'Mandatory',
  high: 'High',
  medium: 'Medium',
  optional: 'Optional',
  skip: 'Skip',
}

const TIME_LIMITS = [3_000, 10_000, 30_000]
const SOLUTION_COUNT = 6

type Source = {
  key: number
  name: string
  bitmap: ImageBitmap
  detection: Detection
  detectionMs: number
  pieceIds: number[]
}

type Piece = DetectedPiece & { label: string; sourceKey: number; partIds: number[] }

function linkParts(parts: Piece[]): Piece {
  let offset = 0
  const links: Link[] = parts.flatMap((part) => {
    const shifted = part.shape.links.map(([a, b]): Link => [a + offset, b + offset])
    offset += part.latticeCells.length
    return shifted
  })
  const latticeCells = parts.flatMap((part) => part.latticeCells)
  return {
    ...parts[0],
    label: parts.map((part) => part.label).join('+'),
    shape: { cells: translateToOrigin(latticeCells), links },
    nodes: parts.flatMap((part) => part.nodes),
    latticeCells,
    boardCells: parts.every((part) => part.boardCells) ? parts.flatMap((part) => part.boardCells ?? []) : null,
    partIds: parts.map((part) => part.id),
  }
}

async function readPixels(bitmap: ImageBitmap): Promise<ImageData> {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas 2D is not available')
  context.drawImage(bitmap, 0, 0)
  return context.getImageData(0, 0, bitmap.width, bitmap.height)
}

function boardRing(board: Cell[]): Cell[] {
  const boardKeys = new Set(board.map(cellKey))
  const ring = new Map<string, Cell>()
  for (const cell of board) {
    for (const direction of HEX_NEIGHBORS) {
      const neighbor = addCells(cell, direction)
      if (!boardKeys.has(cellKey(neighbor))) ring.set(cellKey(neighbor), neighbor)
    }
  }
  return [...ring.values()]
}

function tierSummary(totalsByTier: number[], placedByTier?: number[]): string {
  return RANKED_LEVELS.flatMap((level, tier) => {
    const total = totalsByTier[tier]
    if (total === 0) return []
    const label = IMPORTANCE_LABELS[level].toLowerCase()
    return [placedByTier ? `${placedByTier[tier]}/${total} ${label}` : `${total} ${label}`]
  }).join(' · ')
}

function formatSeconds(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`
}

export default function App() {
  const [boardSource, setBoardSource] = useState<Source | null>(null)
  const [extraSources, setExtraSources] = useState<Source[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [board, setBoard] = useState<Cell[]>(() => rectangularBoard(7, 6, FLAT_TOP_ANGLE))
  const [columns, setColumns] = useState(7)
  const [rows, setRows] = useState(6)
  const [importance, setImportance] = useState<Record<number, Importance>>({})
  const [rotationByColor, setRotationByColor] = useState<Record<string, boolean>>({})
  const [avoidEdgeByColor, setAvoidEdgeByColor] = useState<Record<string, boolean>>({})
  const [wantsNeighbors, setWantsNeighbors] = useState<Record<number, boolean>>({})
  const [linkGroups, setLinkGroups] = useState<number[][]>([])
  const [selectedForLink, setSelectedForLink] = useState<number[]>([])
  const [timeLimit, setTimeLimit] = useState(10_000)
  const [solving, setSolving] = useState(false)
  const [result, setResult] = useState<{ inputKey: string; output: SolverOutput } | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const extraFileInputRef = useRef<HTMLInputElement>(null)
  const nextIdRef = useRef(0)

  const detection = boardSource?.detection ?? null
  const angle = detection?.displayAngle ?? extraSources[0]?.detection.displayAngle ?? FLAT_TOP_ANGLE
  const detectedPieces = useMemo(() => {
    const combined: Piece[] = []
    for (const source of boardSource ? [boardSource, ...extraSources] : extraSources) {
      source.detection.pieces.forEach((piece, index) =>
        combined.push({
          ...piece,
          id: source.pieceIds[index],
          label: `${combined.length + 1}`,
          boardCells: source === boardSource ? piece.boardCells : null,
          sourceKey: source.key,
          partIds: [source.pieceIds[index]],
        }),
      )
    }
    return combined
  }, [boardSource, extraSources])
  const labelById = useMemo(() => new Map(detectedPieces.map((piece) => [piece.id, piece.label])), [detectedPieces])
  const pieces = useMemo(() => {
    const byId = new Map(detectedPieces.map((piece) => [piece.id, piece]))
    const linked = new Map<number, Piece>()
    for (const group of linkGroups) {
      const parts = group.flatMap((id) => byId.get(id) ?? [])
      if (parts.length < 2) continue
      for (const part of parts) linked.set(part.id, parts[0])
      linked.set(parts[0].id, linkParts(parts))
    }
    return detectedPieces.flatMap((piece) => {
      const replacement = linked.get(piece.id)
      if (!replacement) return [piece]
      return replacement.id === piece.id ? [replacement] : []
    })
  }, [detectedPieces, linkGroups])
  const colorClasses = useMemo(() => groupByColor(pieces), [pieces])
  const colorClassOf = useMemo(() => {
    const byPiece = new Map<number, ColorClass>()
    for (const colorClass of colorClasses) for (const id of colorClass.pieceIds) byPiece.set(id, colorClass)
    return byPiece
  }, [colorClasses])

  const importanceOf = useCallback((piece: DetectedPiece) => importance[piece.id] ?? DEFAULT_IMPORTANCE, [importance])
  const canRotate = useCallback(
    (piece: DetectedPiece) => {
      const colorClass = colorClassOf.get(piece.id)
      return colorClass ? (rotationByColor[colorClass.id] ?? true) : true
    },
    [colorClassOf, rotationByColor],
  )
  const avoidsEdgeByDefault = (colorClass: ColorClass) => colorClass.name === 'Red'
  const avoidsEdge = useCallback(
    (piece: DetectedPiece) => {
      const colorClass = colorClassOf.get(piece.id)
      return colorClass ? (avoidEdgeByColor[colorClass.id] ?? avoidsEdgeByDefault(colorClass)) : false
    },
    [colorClassOf, avoidEdgeByColor],
  )

  const linkSelected = () => {
    const selectedPieces = pieces.filter((piece) => selectedForLink.includes(piece.id))
    if (new Set(selectedPieces.map((piece) => piece.sourceKey)).size > 1) {
      setError('Only pieces from the same picture can be linked, so their spacing is known.')
      return
    }
    const partIds = selectedPieces.flatMap((piece) => piece.partIds)
    setLinkGroups((current) => [...current.filter((group) => !group.some((id) => partIds.includes(id))), partIds])
    setSelectedForLink([])
    setError(null)
  }

  const unlink = (piece: Piece) =>
    setLinkGroups((current) => current.filter((group) => !group.includes(piece.id)))

  const toggleLinkSelection = (piece: Piece) =>
    setSelectedForLink((current) =>
      current.includes(piece.id) ? current.filter((id) => id !== piece.id) : [...current, piece.id],
    )

  const analyze = useCallback(async (file: Blob, name: string): Promise<Source> => {
    const bitmap = await createImageBitmap(file)
    const pixels = await readPixels(bitmap)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const started = performance.now()
    const detected = detect(pixels)
    return {
      key: nextIdRef.current++,
      name,
      bitmap,
      detection: detected,
      detectionMs: performance.now() - started,
      pieceIds: detected.pieces.map(() => nextIdRef.current++),
    }
  }, [])

  const loadBoardImage = useCallback(
    async (file: Blob, name: string) => {
      setError(null)
      setAnalyzing(true)
      try {
        const source = await analyze(file, name)
        setBoardSource(source)
        if (source.detection.board.length > 0) setBoard(source.detection.board)
        if (source.detection.pieces.length === 0) setError('No colored nodes found in this image.')
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not read this image.')
      } finally {
        setAnalyzing(false)
      }
    },
    [analyze],
  )

  const addPieceImages = useCallback(
    async (files: { file: Blob; name: string }[]) => {
      setError(null)
      setAnalyzing(true)
      try {
        const sources = await Promise.all(files.map(({ file, name }) => analyze(file, name)))
        setExtraSources((current) => [...current, ...sources])
        const empty = sources.filter((source) => source.detection.pieces.length === 0)
        if (empty.length > 0) setError(`No colored nodes found in ${empty.map((source) => source.name).join(', ')}.`)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not read this image.')
      } finally {
        setAnalyzing(false)
      }
    },
    [analyze],
  )

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((candidate) => candidate.type.startsWith('image/'))
      if (!file) return
      if (boardSource) void addPieceImages([{ file, name: 'pasted image' }])
      else void loadBoardImage(file, 'pasted image')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [boardSource, loadBoardImage, addPieceImages])

  useEffect(() => () => workerRef.current?.terminate(), [])

  const edgeCells = useMemo(() => (board.length > 0 ? lastRowAndColumnCells(board, angle) : []), [board, angle])
  const solverInput = useMemo<SolverInput>(
    () => ({
      board,
      edgeCells,
      pieces: pieces
        .filter((piece) => importanceOf(piece) !== 'skip')
        .map((piece) => ({
          id: piece.id,
          cells: piece.shape.cells,
          rotatable: canRotate(piece),
          tier: RANKED_LEVELS.indexOf(importanceOf(piece)),
          wantsNeighbors: wantsNeighbors[piece.id] ?? false,
          avoidEdge: avoidsEdge(piece),
        })),
      maxSolutions: SOLUTION_COUNT,
      timeLimitMs: timeLimit,
    }),
    [board, edgeCells, pieces, importanceOf, canRotate, avoidsEdge, wantsNeighbors, timeLimit],
  )
  const solverInputKey = useMemo(() => JSON.stringify(solverInput), [solverInput])

  const startSolving = () => {
    workerRef.current?.terminate()
    const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    setSolving(true)
    const inputKey = solverInputKey
    worker.onmessage = (event: MessageEvent<SolverOutput>) => {
      setResult({ inputKey, output: event.data })
      setSolving(false)
      worker.terminate()
    }
    worker.onerror = (event) => {
      setError(`Solver failed: ${event.message}`)
      setSolving(false)
    }
    worker.postMessage(solverInput)
  }

  const stopSolving = () => {
    workerRef.current?.terminate()
    workerRef.current = null
    setSolving(false)
  }

  const toggleCell = (cell: Cell) => {
    const key = cellKey(cell)
    setBoard((current) =>
      current.some((existing) => cellKey(existing) === key)
        ? current.filter((existing) => cellKey(existing) !== key)
        : [...current, cell],
    )
  }

  const boardKeys = new Set(board.map(cellKey))
  const currentLayout: DrawnPiece[] = pieces.flatMap((piece) =>
    piece.boardCells && piece.boardCells.every((cell) => boardKeys.has(cellKey(cell)))
      ? [{ key: `${piece.id}`, cells: piece.boardCells, links: piece.shape.links, color: piece.color, label: piece.label }]
      : [],
  )

  const piecesById = new Map(pieces.map((piece) => [piece.id, piece]))
  const resultIsStale = result !== null && result.inputKey !== solverInputKey
  const totalsByTier = RANKED_LEVELS.map((_, tier) => solverInput.pieces.filter((piece) => piece.tier === tier).length)
  const pieceCells = solverInput.pieces.reduce((sum, piece) => sum + piece.cells.length, 0)
  const someAvoidEdge = solverInput.pieces.some((piece) => piece.avoidEdge)

  return (
    <div className="app">
      <header className="app-header">
        <h1>Hexfit</h1>
        <p>Drop a screenshot of the hex grid. Hexfit finds the pieces and works out how to rotate and place them.</p>
      </header>

      <section className="panel">
        <h2>
          <span className="step">1</span> Screenshot
        </h2>
        <div
          className="dropzone"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            const file = event.dataTransfer.files[0]
            if (file) void loadBoardImage(file, file.name)
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void loadBoardImage(file, file.name)
              event.target.value = ''
            }}
          />
          {boardSource ? (
            <ScreenshotPreview
              bitmap={boardSource.bitmap}
              detection={boardSource.detection}
              labels={boardSource.pieceIds.map((id) => labelById.get(id) ?? '')}
            />
          ) : (
            <div className="dropzone-empty">
              <strong>Click to choose, drop an image, or paste (Ctrl/⌘+V)</strong>
              <span>Everything runs in your browser. The image is never uploaded.</span>
            </div>
          )}
        </div>
        {boardSource && (
          <p className="status">
            Found <strong>{boardSource.detection.pieces.length} pieces</strong> and{' '}
            <strong>{boardSource.detection.board.length} board cells</strong> in{' '}
            {formatSeconds(boardSource.detectionMs)}. Click the image to replace it.
          </p>
        )}

        <div className="extra-header">
          <h3>More pieces</h3>
          <button type="button" onClick={() => extraFileInputRef.current?.click()}>
            Add pictures
          </button>
          <input
            ref={extraFileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])].map((file) => ({ file, name: file.name }))
              if (files.length > 0) void addPieceImages(files)
              event.target.value = ''
            }}
          />
        </div>
        <p className="hint">
          Every node group found in these pictures is added as an extra piece. Only the first screenshot sets the
          board. {boardSource && 'Pasting now adds a picture here.'}
        </p>
        {extraSources.length > 0 && (
          <div className="extra-grid">
            {extraSources.map((source) => (
              <article key={source.key} className="extra-card">
                <ScreenshotPreview
                  bitmap={source.bitmap}
                  detection={source.detection}
                  labels={source.pieceIds.map((id) => labelById.get(id) ?? '')}
                  showBoard={false}
                />
                <div className="extra-meta">
                  <span className="muted" title={source.name}>
                    {source.detection.pieces.length} pieces
                  </span>
                  <button
                    type="button"
                    onClick={() => setExtraSources((current) => current.filter((other) => other.key !== source.key))}
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {analyzing && <p className="status">Analyzing…</p>}
        {error && <p className="status status-error">{error}</p>}
      </section>

      <section className="panel">
        <h2>
          <span className="step">2</span> Board
          <span className="panel-meta">{board.length} cells</span>
        </h2>
        <p className="hint">
          Click a cell to remove it, or click a dashed cell to add it.
          {someAvoidEdge && ' Red-tinted cells are the last row and column, which some pieces avoid.'}
        </p>
        <div className="board-editor">
          <BoardView
            board={board}
            angleDeg={angle}
            pieces={currentLayout}
            highlighted={someAvoidEdge ? edgeCells : []}
            candidates={boardRing(board)}
            onToggleCell={toggleCell}
          />
        </div>
        <div className="controls">
          <label>
            Columns
            <input
              type="number"
              min={1}
              max={20}
              value={columns}
              onChange={(event) => setColumns(Number(event.target.value))}
            />
          </label>
          <label>
            Rows
            <input type="number" min={1} max={20} value={rows} onChange={(event) => setRows(Number(event.target.value))} />
          </label>
          <button type="button" onClick={() => setBoard(rectangularBoard(columns, rows, angle))}>
            Use {columns}×{rows} grid
          </button>
          {detection && detection.board.length > 0 && (
            <button type="button" onClick={() => setBoard(detection.board)}>
              Reset to detected
            </button>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>
          <span className="step">3</span> Pieces
          <span className="panel-meta">
            {pieceCells} cells for {board.length} board cells
          </span>
        </h2>
        {pieces.length === 0 ? (
          <p className="hint">Pieces appear here once a screenshot is analyzed.</p>
        ) : (
          <>
            <div className="color-rules">
              {colorClasses.map((colorClass) => (
                <label key={colorClass.id} className="color-rule">
                  <span className="swatch" style={{ background: colorClass.color }} />
                  {colorClass.name} <span className="muted">×{colorClass.pieceIds.length}</span>
                  <input
                    type="checkbox"
                    checked={rotationByColor[colorClass.id] ?? true}
                    onChange={(event) =>
                      setRotationByColor((current) => ({ ...current, [colorClass.id]: event.target.checked }))
                    }
                  />
                  can rotate
                  <input
                    type="checkbox"
                    checked={avoidEdgeByColor[colorClass.id] ?? avoidsEdgeByDefault(colorClass)}
                    onChange={(event) =>
                      setAvoidEdgeByColor((current) => ({ ...current, [colorClass.id]: event.target.checked }))
                    }
                  />
                  keep off last row/column
                </label>
              ))}
            </div>
            <div className="link-bar">
              <span className="muted">
                Some upgrades are several separate node groups. Tick them (same picture) and link them to keep their
                spacing.
              </span>
              <button type="button" disabled={selectedForLink.length < 2} onClick={linkSelected}>
                Link selected ({selectedForLink.length})
              </button>
            </div>
            <div className="piece-grid">
              {pieces.map((piece) => (
                <article
                  key={piece.id}
                  className={`piece-card piece-${importanceOf(piece)}${selectedForLink.includes(piece.id) ? ' piece-selected' : ''}`}
                >
                  <div className="piece-preview">
                    <PieceView
                      angleDeg={angle}
                      piece={{
                        key: `${piece.id}`,
                        cells: piece.shape.cells,
                        links: piece.shape.links,
                        color: piece.color,
                        label: piece.label,
                      }}
                    />
                  </div>
                  <div className="piece-meta">
                    <strong>#{piece.label}</strong>
                    <span className="muted">
                      {piece.shape.cells.length} cells · {piece.boardCells ? 'on board' : 'loose'}
                      {canRotate(piece) ? '' : ' · fixed'}
                    </span>
                  </div>
                  <div className="piece-options">
                    <label>
                      <input
                        type="checkbox"
                        checked={wantsNeighbors[piece.id] ?? false}
                        onChange={(event) =>
                          setWantsNeighbors((current) => ({ ...current, [piece.id]: event.target.checked }))
                        }
                      />
                      Wants neighbors
                    </label>
                    {piece.partIds.length > 1 ? (
                      <button type="button" className="small" onClick={() => unlink(piece)}>
                        Unlink
                      </button>
                    ) : (
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedForLink.includes(piece.id)}
                          onChange={() => toggleLinkSelection(piece)}
                        />
                        Link
                      </label>
                    )}
                  </div>
                  <select
                    className="importance-select"
                    value={importanceOf(piece)}
                    onChange={(event) => {
                      const level = IMPORTANCE_LEVELS.find((candidate) => candidate === event.target.value)
                      if (level) setImportance((current) => ({ ...current, [piece.id]: level }))
                    }}
                  >
                    {IMPORTANCE_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {IMPORTANCE_LABELS[level]}
                      </option>
                    ))}
                  </select>
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>
          <span className="step">4</span> Solve
        </h2>
        <div className="controls">
          <label>
            Time limit
            <select value={timeLimit} onChange={(event) => setTimeLimit(Number(event.target.value))}>
              {TIME_LIMITS.map((limit) => (
                <option key={limit} value={limit}>
                  {limit / 1000} s
                </option>
              ))}
            </select>
          </label>
          {solving ? (
            <button type="button" onClick={stopSolving}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={solverInput.pieces.length === 0 || board.length === 0}
              onClick={startSolving}
            >
              Find placements
            </button>
          )}
          <span className="muted">{tierSummary(totalsByTier)}</span>
        </div>
        {solving && <p className="status">Searching… (up to {timeLimit / 1000} s)</p>}
        {result && !solving && (
          <SolutionList
            output={result.output}
            stale={resultIsStale}
            board={board}
            angle={angle}
            piecesById={piecesById}
            consideredIds={solverInput.pieces.map((piece) => piece.id)}
            totalsByTier={totalsByTier}
          />
        )}
      </section>
    </div>
  )
}

type SolutionListProps = {
  output: SolverOutput
  stale: boolean
  board: Cell[]
  angle: number
  piecesById: Map<number, Piece>
  consideredIds: number[]
  totalsByTier: number[]
}

function SolutionList({ output, stale, consideredIds, ...cardProps }: SolutionListProps) {
  if (output.solutions.length === 0) return <p className="status">No placement found.</p>
  const mandatoryTotal = cardProps.totalsByTier[0]
  const mandatoryFits = output.solutions[0].placedByTier[0] === mandatoryTotal
  return (
    <>
      {!mandatoryFits && (
        <p className="status status-error">
          {output.complete ? 'The mandatory pieces cannot all fit on this board.' : 'No layout found yet that fits every mandatory piece.'}
        </p>
      )}
      <p className="status">
        {output.complete
          ? `Search complete: these are the best placements (${formatSeconds(output.elapsedMs)}).`
          : `Time limit reached: best placements found so far (${output.explored.toLocaleString()} states checked).`}
        {stale && <span className="status-warning"> Settings changed since this run, so solve again.</span>}
      </p>
      <div className="solution-grid">
        {output.solutions.map((solution, index) => (
          <SolutionCard key={index} index={index} solution={solution} consideredIds={consideredIds} {...cardProps} />
        ))}
      </div>
    </>
  )
}

type SolutionCardProps = {
  index: number
  solution: Solution
  board: Cell[]
  angle: number
  piecesById: Map<number, Piece>
  consideredIds: number[]
  totalsByTier: number[]
}

function SolutionCard(props: SolutionCardProps) {
  const { index, solution, board, angle, piecesById, consideredIds, totalsByTier } = props
  const drawn: DrawnPiece[] = solution.placements.flatMap((placement) => {
    const piece = piecesById.get(placement.pieceId)
    return piece
      ? [{ key: `${piece.id}`, cells: placement.cells, links: piece.shape.links, color: piece.color, label: piece.label }]
      : []
  })
  const placedIds = new Set(solution.placements.map((placement) => placement.pieceId))
  const unplacedIds = consideredIds.filter((id) => !placedIds.has(id))

  return (
    <article className="solution-card">
      <header>
        <strong>Option {index + 1}</strong>
        <span className="muted">
          {tierSummary(totalsByTier, solution.placedByTier)}
          {solution.placements.some((placement) => placement.neighborCount !== null) &&
            ` · ${solution.neighborScore} neighbors`}{' '}
          · {solution.cellsCovered}/{board.length} cells
        </span>
      </header>
      <BoardView board={board} angleDeg={angle} pieces={drawn} />
      <div className="chips">
        {solution.placements
          .slice()
          .sort((a, b) => a.pieceId - b.pieceId)
          .map((placement) => (
            <span key={placement.pieceId} className="chip">
              #{piecesById.get(placement.pieceId)?.label} {placement.rotation === 0 ? 'no rotation' : `↻ ${placement.rotation * 60}°`}
              {placement.neighborCount !== null && ` · ${placement.neighborCount} neighbors`}
            </span>
          ))}
        {unplacedIds.map((id) => (
          <span key={id} className="chip chip-missing">
            #{piecesById.get(id)?.label} not placed
          </span>
        ))}
      </div>
    </article>
  )
}
