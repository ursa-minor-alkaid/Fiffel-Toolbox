export interface AppleFrame {
  text: string
  hits: number
  minCol: number
  maxCol: number
  minRow: number
  maxRow: number
}

export interface AppleRenderer {
  columns: number
  rows: number
  render(angle: number): AppleFrame
}

export const ROTATION_SECONDS: number

export function appleAngle(elapsedSeconds: number): number

export function createAppleRenderer(options: {
  columns: number
  rows: number
  charAspect?: number
}): AppleRenderer
