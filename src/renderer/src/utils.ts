import { useCallback } from 'react'
import { api } from './bridge'

export function usePlugin<T = unknown>(pluginId: string) {
  const invoke = useCallback(
    <R = T,>(method: string, args?: unknown) => api.invoke<R>(pluginId, method, args),
    [pluginId]
  )
  return { invoke }
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '…'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`
}

export function formatTime(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
