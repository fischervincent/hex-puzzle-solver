import { useEffect, useRef, type MouseEvent } from 'react'
import { hexVertices, type DetectedPiece, type Detection } from '../lib/detect'
import type { Point } from '../lib/hex'

type Props = {
  bitmap: ImageBitmap
  detection: Detection | null
  labels: string[]
  showBoard?: boolean
  linkedGroups?: number[][]
  selectedIndices?: number[]
  onPieceClick?: (index: number) => void
}

const LINK_COLOR = '#f0a43a'
const CLICK_REACH_IN_NODE_RADII = 1.4

function centerOf(piece: DetectedPiece): Point {
  return {
    x: piece.nodes.reduce((sum, node) => sum + node.x, 0) / piece.nodes.length,
    y: piece.nodes.reduce((sum, node) => sum + node.y, 0) / piece.nodes.length,
  }
}

export function ScreenshotPreview({
  bitmap,
  detection,
  labels,
  showBoard = true,
  linkedGroups = [],
  selectedIndices = [],
  onPieceClick,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    context.drawImage(bitmap, 0, 0)
    if (!detection) return

    context.fillStyle = 'rgba(0, 0, 0, 0.45)'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const lineWidth = Math.max(2, detection.nodeRadius * 0.12)

    const { lattice } = detection
    if (lattice && showBoard) {
      context.strokeStyle = 'rgba(120, 220, 255, 0.9)'
      context.lineWidth = lineWidth
      for (const cell of detection.board) {
        const vertices = hexVertices(lattice, cell, 0.9)
        context.beginPath()
        vertices.forEach((vertex, index) =>
          index === 0 ? context.moveTo(vertex.x, vertex.y) : context.lineTo(vertex.x, vertex.y),
        )
        context.closePath()
        context.stroke()
      }
    }

    context.setLineDash([lineWidth * 3, lineWidth * 2])
    context.strokeStyle = LINK_COLOR
    context.lineWidth = lineWidth * 1.5
    for (const group of linkedGroups) {
      const centers = group.flatMap((index) => (detection.pieces[index] ? [centerOf(detection.pieces[index])] : []))
      context.beginPath()
      centers.forEach((center, index) =>
        index === 0 ? context.moveTo(center.x, center.y) : context.lineTo(center.x, center.y),
      )
      context.stroke()
    }
    context.setLineDash([])

    detection.pieces.forEach((piece, index) => {
      context.strokeStyle = piece.color
      context.lineWidth = lineWidth * 2
      for (const [a, b] of piece.shape.links) {
        context.beginPath()
        context.moveTo(piece.nodes[a].x, piece.nodes[a].y)
        context.lineTo(piece.nodes[b].x, piece.nodes[b].y)
        context.stroke()
      }
      const isSelected = selectedIndices.includes(index)
      for (const node of piece.nodes) {
        if (isSelected) {
          context.beginPath()
          context.arc(node.x, node.y, detection.nodeRadius * 1.15, 0, Math.PI * 2)
          context.strokeStyle = LINK_COLOR
          context.lineWidth = lineWidth * 2
          context.stroke()
        }
        context.beginPath()
        context.arc(node.x, node.y, detection.nodeRadius * 0.55, 0, Math.PI * 2)
        context.fillStyle = piece.color
        context.fill()
        context.strokeStyle = '#fff'
        context.lineWidth = lineWidth
        context.stroke()
      }
      const top = piece.nodes.reduce((highest, node) => (node.y < highest.y ? node : highest))
      context.font = `bold ${Math.round(detection.nodeRadius * 0.9)}px system-ui, sans-serif`
      context.fillStyle = '#fff'
      context.fillText(`#${labels[index]}`, top.x + detection.nodeRadius * 0.7, top.y - detection.nodeRadius * 0.6)
    })
  }, [bitmap, detection, labels, showBoard, linkedGroups, selectedIndices])

  const handleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    if (!onPieceClick || !detection) return
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const scale = Math.min(rect.width / bitmap.width, rect.height / bitmap.height)
    const x = (event.clientX - rect.left - (rect.width - bitmap.width * scale) / 2) / scale
    const y = (event.clientY - rect.top - (rect.height - bitmap.height * scale) / 2) / scale
    const reach = detection.nodeRadius * CLICK_REACH_IN_NODE_RADII
    const index = detection.pieces.findIndex((piece) =>
      piece.nodes.some((node) => Math.hypot(node.x - x, node.y - y) <= reach),
    )
    if (index >= 0) onPieceClick(index)
  }

  return (
    <canvas
      ref={canvasRef}
      className={onPieceClick ? 'screenshot-canvas screenshot-selecting' : 'screenshot-canvas'}
      onClick={handleClick}
    />
  )
}
