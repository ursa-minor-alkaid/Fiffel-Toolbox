import { useEffect, useMemo, useState } from 'react'
import { usePlugin, formatTime } from '../../src/renderer/src/utils'

interface ApiEntry {
  id: string
  name: string
  provider: string
  baseUrl: string
  models: string[]
  keyCipher: string
  note: string
  updatedAt: number
}

interface PromptEntry {
  id: string
  title: string
  category: string
  tags: string[]
  role: string
  content: string
  updatedAt: number
}

interface VaultData {
  apis: ApiEntry[]
  prompts: PromptEntry[]
  encryptionAvailable: boolean
}

const emptyApi = (): ApiEntry => ({
  id: '',
  name: '',
  provider: '',
  baseUrl: '',
  models: [],
  keyCipher: '',
  note: '',
  updatedAt: 0
})

const emptyPrompt = (): PromptEntry => ({
  id: '',
  title: '',
  category: '',
  tags: [],
  role: '',
  content: '',
  updatedAt: 0
})

const MODEL_SLOTS = 5

export default function VaultView(): JSX.Element {
  const { invoke } = usePlugin('vault')
  const [data, setData] = useState<VaultData>({ apis: [], prompts: [], encryptionAvailable: false })
  const [tab, setTab] = useState<'apis' | 'prompts'>('apis')
  const [apiDraft, setApiDraft] = useState<ApiEntry>(emptyApi())
  const [promptDraft, setPromptDraft] = useState<PromptEntry>(emptyPrompt())
  const [plainKey, setPlainKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState('')
  const [keyword, setKeyword] = useState('')
  const [includeSecrets, setIncludeSecrets] = useState(false)

  const apply = (next: VaultData): void => {
    setData(next)
  }

  useEffect(() => {
    void invoke<VaultData>('load').then(apply)
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

  const pickApi = (entry: ApiEntry): void => {
    setApiDraft(entry)
    setPlainKey('')
    setShowKey(false)
  }

  const pickPrompt = (entry: PromptEntry): void => {
    setPromptDraft(entry)
  }

  const saveApi = async (): Promise<void> => {
    if (!apiDraft.name.trim()) {
      setStatus('请填写名称')
      return
    }
    const next = await invoke<VaultData>('saveApi', {
      ...apiDraft,
      plainKey: plainKey || undefined
    })
    apply(next)
    setPlainKey('')
    setShowKey(false)
    const saved = apiDraft.id
      ? next.apis.find((item) => item.id === apiDraft.id)
      : next.apis.find((item) => item.name === apiDraft.name)
    if (saved) setApiDraft(saved)
    setStatus('已保存')
  }

  const removeApi = async (): Promise<void> => {
    if (!apiDraft.id) return
    apply(await invoke<VaultData>('deleteApi', { id: apiDraft.id }))
    setApiDraft(emptyApi())
    setPlainKey('')
    setShowKey(false)
    setStatus('已删除')
  }

  const copyText = async (text: string, label: string): Promise<void> => {
    if (!text) {
      setStatus(`没有可复制的${label}`)
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setStatus(`${label}已复制`)
    } catch {
      setStatus('复制失败，剪贴板不可用')
    }
  }

  const toggleKeyVisible = async (): Promise<void> => {
    if (showKey) {
      setShowKey(false)
      return
    }
    if (!plainKey && apiDraft.id) {
      setPlainKey(await invoke<string>('revealApiKey', { id: apiDraft.id }))
    }
    setShowKey(true)
  }

  const copyApiKey = async (): Promise<void> => {
    let value = plainKey
    if (!value && apiDraft.id) {
      value = await invoke<string>('revealApiKey', { id: apiDraft.id })
    }
    await copyText(value, 'API Key')
  }

  const modelSlots = Array.from(
    { length: MODEL_SLOTS },
    (_, index) => apiDraft.models[index] ?? ''
  )

  const setModelAt = (index: number, value: string): void => {
    const next = modelSlots.slice()
    next[index] = value
    setApiDraft({ ...apiDraft, models: next })
  }

  const savePrompt = async (): Promise<void> => {
    if (!promptDraft.title.trim()) {
      setStatus('请填写标题')
      return
    }
    const next = await invoke<VaultData>('savePrompt', promptDraft)
    apply(next)
    const saved = promptDraft.id
      ? next.prompts.find((item) => item.id === promptDraft.id)
      : next.prompts.find((item) => item.title === promptDraft.title)
    if (saved) setPromptDraft(saved)
    setStatus('已保存')
  }

  const removePrompt = async (): Promise<void> => {
    if (!promptDraft.id) return
    apply(await invoke<VaultData>('deletePrompt', { id: promptDraft.id }))
    setPromptDraft(emptyPrompt())
    setStatus('已删除')
  }

  const exportAll = async (format: 'md' | 'json'): Promise<void> => {
    const result = await invoke<{ savedTo: string | null; apiCount: number; promptCount: number }>(
      'exportAll',
      { format, includeSecrets }
    )
    setStatus(
      result.savedTo
        ? `已导出 ${result.apiCount} 条 API、${result.promptCount} 条提示词 → ${result.savedTo}`
        : '已取消导出'
    )
  }

  return (
    <>
      <div className="toolbar">
        <button className={tab === 'apis' ? 'primary' : ''} onClick={() => setTab('apis')}>
          API 配置 ({data.apis.length})
        </button>
        <button className={tab === 'prompts' ? 'primary' : ''} onClick={() => setTab('prompts')}>
          提示词 ({data.prompts.length})
        </button>
        <div className="spacer" />
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={includeSecrets}
            onChange={(e) => setIncludeSecrets(e.target.checked)}
          />
          <span className="dim">导出含密钥明文</span>
        </label>
        <button onClick={() => void exportAll('md')}>导出 Markdown</button>
        <button onClick={() => void exportAll('json')}>导出 JSON</button>
      </div>

      {!data.encryptionAvailable && (
        <div className="banner">系统密钥保护不可用，密钥以可逆编码保存。建议在正常桌面环境中使用。</div>
      )}

      {tab === 'apis' ? (
        <div className="panes">
          <div className="list-pane">
            <div className="list-pane-head">
              <button className="ghost" onClick={() => { setApiDraft(emptyApi()); setPlainKey(''); setShowKey(false) }}>
                新建
              </button>
            </div>
            {data.apis.map((entry) => (
              <div
                key={entry.id}
                className={`list-item${entry.id === apiDraft.id ? ' active' : ''}`}
                onClick={() => pickApi(entry)}
              >
                <div className="list-item-title">{entry.name}</div>
                <div className="list-item-sub">
                  {entry.provider || '未指定服务商'} ·{' '}
                  {entry.models.filter(Boolean).join(' / ') || '未指定模型'}
                </div>
              </div>
            ))}
            {!data.apis.length && <div className="empty">还没有 API 记录</div>}
          </div>

          <div className="editor">
            <div className="form-grid">
              <div className="field">
                <label>名称</label>
                <input
                  value={apiDraft.name}
                  onChange={(e) => setApiDraft({ ...apiDraft, name: e.target.value })}
                  placeholder="如 DeepSeek 官方"
                />
              </div>
              <div className="field">
                <label>服务商</label>
                <input
                  value={apiDraft.provider}
                  onChange={(e) => setApiDraft({ ...apiDraft, provider: e.target.value })}
                  placeholder="OpenAI / Anthropic / 自建"
                />
              </div>
              <div className="field full">
                <label>Base URL</label>
                <div className="input-actions">
                  <input
                    value={apiDraft.baseUrl}
                    onChange={(e) => setApiDraft({ ...apiDraft, baseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    spellCheck={false}
                  />
                  <button
                    className="ghost"
                    onClick={() => void copyText(apiDraft.baseUrl, 'Base URL')}
                    disabled={!apiDraft.baseUrl}
                  >
                    复制
                  </button>
                </div>
              </div>
              <div className="field full">
                <label>模型名称（最多 {MODEL_SLOTS} 个）</label>
                <div className="model-grid">
                  {modelSlots.map((value, index) => (
                    <input
                      key={index}
                      value={value}
                      onChange={(e) => setModelAt(index, e.target.value)}
                      placeholder={`模型 ${index + 1}`}
                      spellCheck={false}
                    />
                  ))}
                </div>
              </div>
              <div className="field full">
                <label>API Key（保存后加密，默认隐藏）</label>
                <div className="input-actions">
                  <input
                    value={plainKey}
                    onChange={(e) => setPlainKey(e.target.value)}
                    placeholder={apiDraft.keyCipher ? '已保存，留空表示不修改' : 'sk-...'}
                    type={showKey ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button className="ghost" onClick={() => void toggleKeyVisible()}>
                    {showKey ? '隐藏' : '显示'}
                  </button>
                  <button
                    className="ghost"
                    onClick={() => void copyApiKey()}
                    disabled={!plainKey && !apiDraft.keyCipher}
                  >
                    复制
                  </button>
                </div>
              </div>
              <div className="field full">
                <label>备注</label>
                <input
                  value={apiDraft.note}
                  onChange={(e) => setApiDraft({ ...apiDraft, note: e.target.value })}
                />
              </div>
            </div>

            <div className="row">
              <button className="primary" onClick={() => void saveApi()}>
                保存
              </button>
              <button onClick={() => void removeApi()} disabled={!apiDraft.id}>
                删除
              </button>
              {apiDraft.updatedAt > 0 && (
                <span className="dim">更新于 {formatTime(apiDraft.updatedAt)}</span>
              )}
              {status && <span className="dim">{status}</span>}
            </div>
          </div>
        </div>
      ) : (
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
                <div className="list-item-title">{entry.title}</div>
                <div className="list-item-sub">
                  {[entry.category, ...entry.tags].filter(Boolean).join(' · ') || '未分类'}
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
                <label>分类</label>
                <input
                  value={promptDraft.category}
                  onChange={(e) => setPromptDraft({ ...promptDraft, category: e.target.value })}
                  placeholder="写作 / 代码 / 人设"
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
                  rows={16}
                  value={promptDraft.content}
                  onChange={(e) => setPromptDraft({ ...promptDraft, content: e.target.value })}
                />
              </div>
            </div>

            <div className="row">
              <button className="primary" onClick={() => void savePrompt()}>
                保存
              </button>
              <button onClick={() => void removePrompt()} disabled={!promptDraft.id}>
                删除
              </button>
              <button
                className="ghost"
                onClick={() => void navigator.clipboard.writeText(promptDraft.content)}
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
      )}

      <div className="status">
        <span>API {data.apis.length} 条 · 提示词 {data.prompts.length} 条</span>
        <span className="dim">
          密钥 {data.encryptionAvailable ? '已使用系统密钥保护' : '未加密'}
        </span>
      </div>
    </>
  )
}
