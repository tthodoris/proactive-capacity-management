import { useEffect, useRef, useState } from 'react'
import {
  chatWithCapacityAgent,
  getCapacityAgentStatus,
  resetCapacityAgentSession,
  type CapacityAgentStatus,
} from '../lib/agentApi'

type ChatRole = 'user' | 'assistant' | 'system'

type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  at: string
}

const SESSION_KEY = 'pcm.capacityAgent.sessionId'

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
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'I am the Capacity Forecasting Agent. Ask about a customer’s opportunities, Stratus capacity risk, or CXObserve ACR growth — for example Hellenic Bank of Attica or CUST-002.',
      at: new Date().toISOString(),
    },
  ])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(() =>
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SESSION_KEY) : null,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<CapacityAgentStatus | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    getCapacityAgentStatus()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

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
      const result = await chatWithCapacityAgent(prompt, sessionId)
      setSessionId(result.sessionId)
      sessionStorage.setItem(SESSION_KEY, result.sessionId)
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          role: 'assistant',
          content: result.reply,
          at: new Date().toISOString(),
        },
      ])
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
        id: newId(),
        role: 'assistant',
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
              opportunities · {status.counts?.inventoryAcr ?? 0} ACR rows · model{' '}
              {status.model || 'gpt-4.1'}
            </span>
          ) : (
            <span className="muted">{status?.error || 'Checking agent…'}</span>
          )}
          {status?.warnings?.length ? (
            <span className="pill pill-medium">{status.warnings.length} datasource warning(s)</span>
          ) : null}
        </div>
      </section>

      <section className="panel forecast-agent-chat">
        <div className="panel-body forecast-agent-thread">
          {messages.map((m) => (
            <div key={m.id} className={`forecast-bubble forecast-bubble-${m.role}`}>
              <div className="forecast-bubble-label">
                {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Agent' : 'System'}
              </div>
              <div className="forecast-bubble-body">{m.content}</div>
            </div>
          ))}
          {busy ? (
            <div className="forecast-bubble forecast-bubble-assistant">
              <div className="forecast-bubble-label">Agent</div>
              <div className="forecast-bubble-body muted">Analyzing opportunities, capacity, and ACR trends…</div>
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
  )
}
