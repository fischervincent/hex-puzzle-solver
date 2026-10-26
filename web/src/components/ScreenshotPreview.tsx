import { useEffect, useRef } from 'react'
import { hexVertices, type Detection } from '../lib/detect'

type Props = { bitmap: ImageBitmap; detection: Detection | null }

export function ScreenshotPreview({ bitmap, detection }: Props) {
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
    if (lattice) {
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

    for (const piece of detection.pieces) {
      context.strokeStyle = piece.color
      context.lineWidth = lineWidth * 2
      for (const [a, b] of piece.shape.links) {
        context.beginPath()
        context.moveTo(piece.nodes[a].x, piece.nodes[a].y)
        context.lineTo(piece.nodes[b].x, piece.nodes[b].y)
        context.stroke()
      }
      for (const node of piece.nodes) {
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
      context.fillText(`#${piece.id + 1}`, top.x + detection.nodeRadius * 0.7, top.y - detection.nodeRadius * 0.6)
    }
  }, [bitmap, detection])

  return <canvas ref={canvasRef} className="screenshot-canvas" />
}
