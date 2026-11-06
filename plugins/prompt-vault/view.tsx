import { useEffect, useMemo, useState } from 'react'
import { usePlugin, formatTime } from '../../src/renderer/src/utils'
import EmojiPicker from './emoji-picker'
import type { PromptEntry, PromptVaultData } from './types'
import './prompt-vault.css'

const emptyPrompt = (): PromptEntry => ({
  id: '',
  title: '',
  emoji: '',
  tags: [],
  role: '',
  content: '',
  updatedAt: 0
})

export default function PromptVaultView(): JSX.Element {
  const { invoke } = usePlugin('prompt-vault')
  const [data, setData] = useState<PromptVaultData>({ prompts: [] })
  const [promptDraft, setPromptDraft] = useState<PromptEntry>(emptyPrompt())
  const [status, setStatus] = useState('')
  const [keyword, setKeyword] = useState('')

  const apply = (next: PromptVaultData): void => {
    setData(next)
  }

  useEffect(() => {
    void invoke<PromptVaultData>('load').then(apply)
  }, [invoke])

  const filteredPrompts = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    if (!k) return data.prompts
    return data.prompts.filter(
      (item) =>
        item.title.toLowerCase().includes(k) ||
        item.content.toLowerCase().includes(k) ||
        item.tags.some((tag) => tag.toLowerCase().includes(k))
    )
  }, [data.prompts, keyword])

  const pickPrompt = (entry: PromptEntry): void => {
    setPromptDraft(entry)
  }

  const savePrompt = async (): Promise<void> => {
    if (!promptDraft.title.trim()) {
      setStatus('请填写标题')
      return
    }
    const creating = !promptDraft.id
    const next = await invoke<PromptVaultData>('savePrompt', promptDraft)
    apply(next)
    if (creating) {
      // 新建保存后回到空白草稿，下一次保存继续新增，不会覆盖刚保存的提示词
      setPromptDraft(emptyPrompt())
      setStatus('已保存')
      return
    }
    const saved = next.prompts.find((item) => item.id === promptDraft.id)
    if (saved) setPromptDraft(saved)
    setStatus('已更新')
  }

  const removePrompt = async (): Promise<void> => {
    if (!promptDraft.id) return
    apply(await invoke<PromptVaultData>('deletePrompt', { id: promptDraft.id }))
    setPromptDraft(emptyPrompt())
    setStatus('已删除')
  }

  const copyContent = async (): Promise<void> => {
    if (!promptDraft.content) {
      setStatus('没有可复制的正文')
      return
    }
    try {
      await navigator.clipboard.writeText(promptDraft.content)
      setStatus('正文已复制')
    } catch {
      setStatus('复制失败，剪贴板不可用')
    }
  }

  const exportAll = async (format: 'md' | 'json'): Promise<void> => {
    const result = await invoke<{ savedTo: string | null; promptCount: number }>('exportAll', {
      format
    })
    setStatus(
      result.savedTo
        ? `已导出 ${result.promptCount} 条提示词 → ${result.savedTo}`
        : '已取消导出'
    )
  }

  return (
    <>
      <div className="toolbar vault-toolbar">
        <span className="vault-count">提示词 · {data.prompts.length} 条</span>
        <div className="spacer" />
        <button onClick={() => void exportAll('md')}>导出 Markdown</button>
        <button onClick={() => void exportAll('json')}>导出 JSON</button>
      </div>

      <div className="panes">
        <div className="list-pane">
          <div className="list-pane-head">
            <button
              className="ghost"
              onClick={() => {
                setPromptDraft(emptyPrompt())
              }}
            >
              新建
            </button>
            <input
              placeholder="搜索标题或内容"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          {filteredPrompts.map((entry) => (
            <div
              key={entry.id}
              className={`list-item${entry.id === promptDraft.id ? ' active' : ''}`}
              onClick={() => pickPrompt(entry)}
            >
              <div className="list-item-title">
                {entry.emoji && <span className="prompt-emoji">{entry.emoji}</span>}
                {entry.title}
              </div>
              <div className="list-item-sub">
                {entry.tags.join(' · ') || '无标签'}
              </div>
            </div>
          ))}
          {!filteredPrompts.length && <div className="empty">没有匹配的提示词</div>}
        </div>

        <div className="editor">
          <div className="form-grid">
            <div className="field">
              <label>标题</label>
              <input
                value={promptDraft.title}
                onChange={(e) => setPromptDraft({ ...promptDraft, title: e.target.value })}
              />
            </div>
            <div className="field">
              <label>图标</label>
              <EmojiPicker
                value={promptDraft.emoji}
                onChange={(emoji) => setPromptDraft({ ...promptDraft, emoji })}
              />
            </div>
            <div className="field">
              <label>标签（逗号分隔）</label>
              <input
                value={promptDraft.tags.join(', ')}
                onChange={(e) =>
                  setPromptDraft({
                    ...promptDraft,
                    tags: e.target.value
                      .split(',')
                      .map((tag) => tag.trim())
                      .filter(Boolean)
                  })
                }
              />
            </div>
            <div className="field">
              <label>角色</label>
              <input
                value={promptDraft.role}
                onChange={(e) => setPromptDraft({ ...promptDraft, role: e.target.value })}
                placeholder="system / assistant"
              />
            </div>
            <div className="field full">
              <label>正文</label>
              <textarea
                className="vault-prompt-body"
                rows={6}
                value={promptDraft.content}
                onChange={(e) => setPromptDraft({ ...promptDraft, content: e.target.value })}
              />
            </div>
          </div>

          <div className="row vault-prompt-actions">
            <button className="primary" onClick={() => void savePrompt()}>
              保存
            </button>
            <button onClick={() => void removePrompt()} disabled={!promptDraft.id}>
              删除
            </button>
            <button
              className="ghost"
              onClick={() => void copyContent()}
              disabled={!promptDraft.content}
            >
              复制正文
            </button>
            {promptDraft.updatedAt > 0 && (
              <span className="dim">更新于 {formatTime(promptDraft.updatedAt)}</span>
            )}
            {status && <span className="dim">{status}</span>}
          </div>
        </div>
      </div>

      <div className="status">
        <span>提示词 {data.prompts.length} 条</span>
        <span className="dim">本地存储 · 无云同步</span>
      </div>
    </>
  )
}
