import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, History } from 'lucide-react'
import { AgentMarkdown } from '../components/AgentMarkdown'
import {
  chatWithCapacityAgent,
  getCapacityAgentChat,
  getCapacityAgentModels,
  getCapacityAgentStatus,
  listCapacityAgentChats,
  resetCapacityAgentSession,
  type CapacityAgentChatSummary,
  type CapacityAgentModel,
  type CapacityAgentStatus,
} from '../lib/agentApi'
import { formatRelative } from '../lib/format'

type ChatRole = 'user' | 'assistant' | 'system'

type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  at: string
}

const SESSION_KEY = 'pcm.capacityAgent.sessionId'
const MODEL_KEY = 'pcm.capacityAgent.model'
const HISTORY_COLLAPSED_KEY = 'pcm.capacityAgent.historyCollapsed'

const WELCOME_MESSAGE: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    'I am the Capacity Forecasting Agent. Ask about a customer’s opportunities, Stratus capacity risk, or CXObserve ACR growth — for example Hellenic Bank of Attica or CUST-002.',
  at: new Date().toISOString(),
}

const SUGGESTIONS = [
  'What is the capacity forecast for Hellenic Bank of Attica?',
  'Where are we constrained for Aegean Retail Group VM SKUs?',
  'Which ACR services are growing fastest for CUST-001?',
  'What proactive actions should we take before Olympus Energy consumption starts?',
]

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function ForecastAgentPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(() =>
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SESSION_KEY) : null,
  )
  const [models, setModels] = useState<CapacityAgentModel[]>([])
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(MODEL_KEY) || '' : '',
  )
  const [modelsWarning, setModelsWarning] = useState<string | null>(null)
  const [modelsSource, setModelsSource] = useState<'copilot' | 'fallback' | null>(null)
  const [history, setHistory] = useState<CapacityAgentChatSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<CapacityAgentStatus | null>(null)
  const [historyCollapsed, setHistoryCollapsed] = useState(() =>
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(HISTORY_COLLAPSED_KEY) === '1'
      : false,
  )
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const result = await listCapacityAgentChats(20)
      setHistory(result.chats)
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err))
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([getCapacityAgentStatus(), getCapacityAgentModels(), listCapacityAgentChats(20)])
      .then(([s, modelList, chatList]) => {
        if (cancelled) return
        setStatus(s)
        setModels(modelList.models)
        setModelsSource(modelList.source)
        setModelsWarning(modelList.warning || null)
        setHistory(chatList.chats)
        setHistoryLoading(false)
        setSelectedModel((prev) => {
          const saved = prev || sessionStorage.getItem(MODEL_KEY) || ''
          const next =
            (saved && modelList.models.some((m) => m.id === saved) && saved) ||
            modelList.defaultModel ||
            s.defaultModel ||
            s.model ||
            ''
          if (next) sessionStorage.setItem(MODEL_KEY, next)
          return next
        })
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
          setHistoryLoading(false)
          setHistoryError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

  function onModelChange(nextModel: string) {
    setSelectedModel(nextModel)
    sessionStorage.setItem(MODEL_KEY, nextModel)
  }

  function toggleHistoryCollapsed() {
    setHistoryCollapsed((prev) => {
      const next = !prev
      localStorage.setItem(HISTORY_COLLAPSED_KEY, next ? '1' : '0')
      return next
    })
  }

  async function openChat(chatId: string) {
    if (busy || loadingChatId) return
    setLoadingChatId(chatId)
    setError(null)
    try {
      const chat = await getCapacityAgentChat(chatId)
      setSessionId(chat.id)
      sessionStorage.setItem(SESSION_KEY, chat.id)
      if (chat.model) {
        setSelectedModel(chat.model)
        sessionStorage.setItem(MODEL_KEY, chat.model)
      }
      setMessages(
        chat.messages.length
          ? chat.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              at: m.at,
            }))
          : [WELCOME_MESSAGE],
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingChatId(null)
    }
  }

  async function send(text: string) {
    const prompt = text.trim()
    if (!prompt || busy) return
    setError(null)
    setInput('')
    setMessages((prev) => [
      ...prev,
      { id: newId(), role: 'user', content: prompt, at: new Date().toISOString() },
    ])
    setBusy(true)
    try {
      const result = await chatWithCapacityAgent(prompt, sessionId, selectedModel || undefined)
      setSessionId(result.sessionId)
      sessionStorage.setItem(SESSION_KEY, result.sessionId)
      if (result.model) {
        setSelectedModel(result.model)
        sessionStorage.setItem(MODEL_KEY, result.model)
      }
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          role: 'assistant',
          content: result.reply,
          at: new Date().toISOString(),
        },
      ])
      void refreshHistory()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          role: 'system',
          content: `Could not reach the capacity agent: ${message}`,
          at: new Date().toISOString(),
        },
      ])
    } finally {
      setBusy(false)
    }
  }

  async function onReset() {
    if (busy) return
    try {
      if (sessionId) await resetCapacityAgentSession(sessionId)
    } catch {
      // Ignore reset failures; still clear local chat.
    }
    sessionStorage.removeItem(SESSION_KEY)
    setSessionId(null)
    setError(null)
    setMessages([
      {
        ...WELCOME_MESSAGE,
        id: newId(),
        content: 'Conversation cleared. Ask a new capacity forecast question.',
        at: new Date().toISOString(),
      },
    ])
  }

  return (
    <div className="stack forecast-agent-page">
      <div className="page-hero">
        <div>
          <h3>Capacity forecasting agent</h3>
          <p>
            Natural-language outlook across MSX opportunities, Stratus capacity, and CXObserve ACR
            inventory — the same Copilot agent available via CLI / Teams.
          </p>
        </div>
        <div className="forecast-agent-actions">
          <label className="forecast-model-picker">
            <span>Model</span>
            <select
              value={selectedModel}
              disabled={busy || !models.length || status?.ok === false}
              onChange={(e) => onModelChange(e.target.value)}
              aria-label="Copilot model"
            >
              {!models.length ? <option value="">Loading models…</option> : null}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.id === (status?.defaultModel || status?.model) ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-ghost" onClick={onReset} disabled={busy}>
            New chat
          </button>
        </div>
      </div>

      <section className="panel forecast-agent-status">
        <div className="panel-body forecast-agent-status-row">
          <span className={`pill ${status?.ok ? 'pill-ok' : 'pill-critical'}`}>
            {status?.ok ? 'Agent ready' : 'Agent unavailable'}
          </span>
          {status?.hasGitHubToken === false ? (
            <span className="muted">Set GH_TOKEN (or GITHUB_TOKEN) on the API for Copilot access.</span>
          ) : null}
          {status?.ok ? (
            <span className="muted">
              {status.counts?.customers ?? 0} customers · {status.counts?.opportunities ?? 0}{' '}
              opportunities · {status.counts?.inventoryAcr ?? 0} ACR rows · using{' '}
              {selectedModel || status.defaultModel || status.model || 'default model'}
              {modelsSource === 'copilot' ? ' · org/account model list' : null}
            </span>
          ) : (
            <span className="muted">{status?.error || 'Checking agent…'}</span>
          )}
          {modelsWarning ? (
            <span className="pill pill-medium" title={modelsWarning}>
              Model list fallback
            </span>
          ) : null}
          {status?.warnings?.length ? (
            <span className="pill pill-medium">{status.warnings.length} datasource warning(s)</span>
          ) : null}
        </div>
      </section>

      <div className={`forecast-agent-layout${historyCollapsed ? ' history-collapsed' : ''}`}>
        <aside className="panel forecast-history-panel" aria-hidden={historyCollapsed}>
          <div className="panel-header">
            <div>
              <h4>Recent chats</h4>
              <p>Last 20 conversations</p>
            </div>
            <div className="forecast-history-header-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void refreshHistory()}
                disabled={historyLoading || busy || historyCollapsed}
              >
                Refresh
              </button>
              <button
                type="button"
                className="btn btn-ghost forecast-history-toggle"
                onClick={toggleHistoryCollapsed}
                aria-expanded={!historyCollapsed}
                aria-controls="forecast-history-list"
                title="Collapse recent chats"
              >
                <ChevronLeft size={16} aria-hidden />
                <span className="sr-only">Collapse recent chats</span>
              </button>
            </div>
          </div>
          <div id="forecast-history-list" className="panel-body forecast-history-list">
            {historyLoading ? <div className="muted">Loading history…</div> : null}
            {historyError ? <div className="forecast-agent-error">{historyError}</div> : null}
            {!historyLoading && !historyError && history.length === 0 ? (
              <div className="empty">No saved chats yet. Send a message to start one.</div>
            ) : null}
            {history.map((chat) => {
              const active = chat.id === sessionId
              return (
                <button
                  key={chat.id}
                  type="button"
                  className={`forecast-history-item${active ? ' active' : ''}`}
                  disabled={busy || loadingChatId === chat.id}
                  onClick={() => void openChat(chat.id)}
                >
                  <strong>{chat.title || 'Untitled chat'}</strong>
                  <span className="muted">
                    {chat.updatedAt ? formatRelative(chat.updatedAt) : 'Unknown time'}
                    {chat.model ? ` · ${chat.model}` : ''}
                    {chat.messageCount != null ? ` · ${chat.messageCount} msgs` : ''}
                  </span>
                  {chat.preview ? <span className="forecast-history-preview">{chat.preview}</span> : null}
                  {loadingChatId === chat.id ? (
                    <span className="muted">Opening…</span>
                  ) : null}
                </button>
              )
            })}
          </div>
        </aside>

        <button
          type="button"
          className="forecast-history-rail"
          onClick={toggleHistoryCollapsed}
          aria-expanded={!historyCollapsed}
          title="Expand recent chats"
        >
          <ChevronRight size={16} aria-hidden />
          <History size={16} aria-hidden />
          <span>Recent chats</span>
        </button>

        <section className="panel forecast-agent-chat">
          <div className="panel-body forecast-agent-thread">
            {messages.map((m) => (
              <div key={m.id} className={`forecast-bubble forecast-bubble-${m.role}`}>
                <div className="forecast-bubble-label">
                  {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Agent' : 'System'}
                </div>
                <div className="forecast-bubble-body">
                  {m.role === 'assistant' ? (
                    <AgentMarkdown content={m.content} />
                  ) : (
                    <AgentMarkdown content={m.content} plain />
                  )}
                </div>
              </div>
            ))}
            {busy ? (
              <div className="forecast-bubble forecast-bubble-assistant">
                <div className="forecast-bubble-label">Agent</div>
                <div className="forecast-bubble-body muted">
                  Analyzing opportunities, capacity, and ACR trends…
                </div>
              </div>
            ) : null}
            <div ref={bottomRef} />
          </div>

          <div className="forecast-agent-composer">
            <div className="forecast-suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="btn btn-ghost forecast-suggestion"
                  disabled={busy || !status?.ok}
                  onClick={() => void send(s)}
                >
                  {s}
                </button>
              ))}
            </div>
            <form
              className="forecast-agent-form"
              onSubmit={(e) => {
                e.preventDefault()
                void send(input)
              }}
            >
              <label className="field full" style={{ margin: 0, flex: 1 }}>
                <span className="sr-only">Message</span>
                <textarea
                  rows={3}
                  value={input}
                  disabled={busy || status?.ok === false}
                  placeholder="Ask about a customer capacity outlook…"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send(input)
                    }
                  }}
                />
              </label>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !input.trim() || status?.ok === false}
              >
                {busy ? 'Working…' : 'Send'}
              </button>
            </form>
            {error ? <div className="forecast-agent-error">{error}</div> : null}
          </div>
        </section>
      </div>
    </div>
  )
}
