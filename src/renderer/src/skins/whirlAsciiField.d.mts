export interface FieldRenderer {
  columns: number
  rows: number
  stepCols: number
  stepRows: number
  render(time: number): string[]
}

export function createFieldRenderer(options: {
  columns: number
  rows: number
  stepCols?: number
  stepRows?: number
  charAspect?: number
}): FieldRenderer
