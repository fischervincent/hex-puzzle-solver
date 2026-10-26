import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BoardView, PieceView, type DrawnPiece } from './components/HexGraphics'
import { ScreenshotPreview } from './components/ScreenshotPreview'
import { groupByColor, type ColorClass } from './lib/colors'
import { detect, type DetectedPiece, type Detection } from './lib/detect'
import { FLAT_TOP_ANGLE, HEX_NEIGHBORS, addCells, cellKey, rectangularBoard, type Cell } from './lib/hex'
import type { Solution, SolverInput, SolverOutput } from './lib/solver'

type Importance = 'priority' | 'optional' | 'skip'

const IMPORTANCE_LEVELS: Importance[] = ['priority', 'optional', 'skip']

const IMPORTANCE_LABELS: Record<Importance, string> = {
  priority: 'Priority',
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

type Piece = DetectedPiece & { label: string }

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
  const [timeLimit, setTimeLimit] = useState(10_000)
  const [solving, setSolving] = useState(false)
  const [result, setResult] = useState<{ inputKey: string; output: SolverOutput } | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const extraFileInputRef = useRef<HTMLInputElement>(null)
  const nextIdRef = useRef(0)

  const detection = boardSource?.detection ?? null
  const angle = detection?.displayAngle ?? extraSources[0]?.detection.displayAngle ?? FLAT_TOP_ANGLE
  const pieces = useMemo(() => {
    const combined: Piece[] = []
    for (const source of boardSource ? [boardSource, ...extraSources] : extraSources) {
      source.detection.pieces.forEach((piece, index) =>
        combined.push({
          ...piece,
          id: source.pieceIds[index],
          label: `${combined.length + 1}`,
          boardCells: source === boardSource ? piece.boardCells : null,
        }),
      )
    }
    return combined
  }, [boardSource, extraSources])
  const labelById = useMemo(() => new Map(pieces.map((piece) => [piece.id, piece.label])), [pieces])
  const colorClasses = useMemo(() => groupByColor(pieces), [pieces])
  const colorClassOf = useMemo(() => {
    const byPiece = new Map<number, ColorClass>()
    for (const colorClass of colorClasses) for (const id of colorClass.pieceIds) byPiece.set(id, colorClass)
    return byPiece
  }, [colorClasses])

  const importanceOf = useCallback((piece: DetectedPiece) => importance[piece.id] ?? 'priority', [importance])
  const canRotate = useCallback(
    (piece: DetectedPiece) => {
      const colorClass = colorClassOf.get(piece.id)
      return colorClass ? (rotationByColor[colorClass.id] ?? true) : true
    },
    [colorClassOf, rotationByColor],
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

  const solverInput = useMemo<SolverInput>(
    () => ({
      board,
      pieces: pieces
        .filter((piece) => importanceOf(piece) !== 'skip')
        .map((piece) => ({
          id: piece.id,
          cells: piece.shape.cells,
          rotatable: canRotate(piece),
          priority: importanceOf(piece) === 'priority',
        })),
      maxSolutions: SOLUTION_COUNT,
      timeLimitMs: timeLimit,
    }),
    [board, pieces, importanceOf, canRotate, timeLimit],
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
  const priorityCount = solverInput.pieces.filter((piece) => piece.priority).length
  const optionalCount = solverInput.pieces.length - priorityCount
  const pieceCells = solverInput.pieces.reduce((sum, piece) => sum + piece.cells.length, 0)

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
        <p className="hint">Click a cell to remove it, or click a dashed cell to add it.</p>
        <div className="board-editor">
          <BoardView
            board={board}
            angleDeg={angle}
            pieces={currentLayout}
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
                </label>
              ))}
            </div>
            <div className="piece-grid">
              {pieces.map((piece) => (
                <article key={piece.id} className={`piece-card piece-${importanceOf(piece)}`}>
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
                  <div className="segmented">
                    {IMPORTANCE_LEVELS.map((level) => (
                      <button
                        key={level}
                        type="button"
                        className={importanceOf(piece) === level ? 'active' : ''}
                        onClick={() => setImportance((current) => ({ ...current, [piece.id]: level }))}
                      >
                        {IMPORTANCE_LABELS[level]}
                      </button>
                    ))}
                  </div>
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
          <span className="muted">
            {priorityCount} priority · {optionalCount} optional
          </span>
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
            priorityTotal={priorityCount}
            optionalTotal={optionalCount}
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
  priorityTotal: number
  optionalTotal: number
}

function SolutionList({ output, stale, consideredIds, ...cardProps }: SolutionListProps) {
  if (output.solutions.length === 0) return <p className="status">No placement found.</p>
  return (
    <>
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
  priorityTotal: number
  optionalTotal: number
}

function SolutionCard(props: SolutionCardProps) {
  const { index, solution, board, angle, piecesById, consideredIds, priorityTotal, optionalTotal } = props
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
          {solution.priorityPlaced}/{priorityTotal} priority
          {optionalTotal > 0 && ` · ${solution.optionalPlaced}/${optionalTotal} optional`} · {solution.cellsCovered}/
          {board.length} cells
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
