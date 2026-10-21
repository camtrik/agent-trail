'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CornerLeftUp, Search, ChevronUp, ChevronDown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import type { TraceSession, TraceTurn, TraceActivity, TraceMessage } from '@/types/trace'
import { useAgentTool } from '@/lib/agent-tools/client-hooks'
import { formatSessionCost } from '@/lib/session-cost'
import { parseUserMessage } from '@/lib/replay/parse-user-message'
import { SessionIdCopyButton } from '@/components/ui/session-id-copy-button'
import { CopyButton } from '@/components/ui/copy-button'
import { MarkdownContent } from './markdown-content'
import { ToolBlock } from './tool-block'
import { SkillBlock } from './skill-block'
import { SubagentBlock } from './subagent-block'
import { ThinkingBlock } from './thinking-block'
import { SystemEventBlock } from './system-event-block'
import { getActivityKey, getMessageKey } from './key-utils'
import { useStarredStore } from '@/stores/starred-store'
import { ReplaySearchBar } from './replay-search-bar'
import { useReplayStore } from '@/stores/replay-store'

interface TraceThreadProps {
  session: TraceSession | null
  turns: TraceTurn[]
  sessionId: string
  onBackToSessions: () => void
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  totalTurns?: number
}

const VIRTUALIZATION_THRESHOLD = 30

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '\u2014'
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const time = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return `${y}/${mo}/${day} ${time}`
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '\u2014'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function deriveDisplayStatus(session: TraceSession | null): { label: string; color: string; pulse: boolean } | null {
  if (!session) return null
  if (session.status === 'active') return { label: 'LIVE', color: 'var(--status-success)', pulse: true }
  if (session.status === 'error') return { label: 'ERROR', color: 'var(--destructive)', pulse: false }
  if (session.status === 'aborted') return { label: 'ABORTED', color: 'var(--destructive)', pulse: false }
  if (session.metrics.isTruncated) return { label: 'TRUNCATED', color: 'oklch(0.76 0.17 55)', pulse: false }
  return null
}

type ActivityEntry = { activity: TraceActivity; idx: number }

function shouldRenderAssistantMessage(message: TraceMessage): boolean {
  if (message.role !== 'assistant') return false
  const content = message.content.trim()
  if (!content) return false
  return !/^\[(function_call|custom_tool_call):/i.test(content)
}

function getActivityMessageOrdinal(activity: TraceActivity): number | undefined {
  if (activity.type === 'tool_call') return activity.messageOrdinal
  if (activity.type === 'subagent_link') return activity.messageOrdinal
  return undefined
}

function groupActivityEntriesByOrdinal(entries: ActivityEntry[]): Map<number, ActivityEntry[]> {
  const grouped = new Map<number, ActivityEntry[]>()
  for (const entry of entries) {
    const ordinal = getActivityMessageOrdinal(entry.activity)
    if (ordinal == null) continue
    const existing = grouped.get(ordinal) ?? []
    existing.push(entry)
    grouped.set(ordinal, existing)
  }
  return grouped
}

function ActivityBlock({ activity, turnIndex, projectPath }: { activity: TraceActivity; turnIndex: number; projectPath?: string }) {
  switch (activity.type) {
    case 'tool_call': return <ToolBlock tool={activity} projectPath={projectPath} />
    case 'skill_use': return <SkillBlock skill={activity} />
    case 'subagent_link': return <SubagentBlock subagent={activity} parentTurnIndex={turnIndex} />
    case 'thinking': return <ThinkingBlock thinking={activity} />
    case 'system': return <SystemEventBlock event={activity} />
    default: return null
  }
}

function extractModel(turns: TraceTurn[]): string | null {
  for (const turn of turns) {
    for (const msg of turn.assistantMessages) {
      if (msg.model) return msg.model
    }
  }
  return null
}

function HudPill({ color, pulse, children }: { color: string; pulse?: boolean; children: React.ReactNode }) {
  return (
    <span className="hud-pill" style={{ color, borderColor: color, background: `color-mix(in oklch, ${color} 12%, transparent)` }}>
      {pulse && <span className="pulse-dot" style={{ background: color }} />}
      {children}
    </span>
  )
}


function TurnCard({
  turn,
  focused,
  onFocus,
  projectPath,
}: {
  turn: TraceTurn
  focused: boolean
  onFocus: () => void
  projectPath?: string
}) {
  const ref = useRef<HTMLElement>(null)
  const searchQuery = useReplayStore((s) => s.searchQuery)
  const userContent = turn.userMessage?.content || ''
  // Plain user text with injected system blocks stripped — what the copy button copies.
  const userCopyText = parseUserMessage(userContent).userText
  const tokenIn = turn.tokenUsage?.inputTokens ?? 0
  const tokenOut = turn.tokenUsage?.outputTokens ?? 0

  const activityEntries: ActivityEntry[] = turn.activities.map((activity, idx) => ({ activity, idx }))
  const activitiesByOrdinal = groupActivityEntriesByOrdinal(activityEntries)
  const messageOrdinals = new Set(turn.assistantMessages.map((m) => m.ordinal))
  const unanchoredActivityEntries = activityEntries.filter(
    ({ activity }) => getActivityMessageOrdinal(activity) == null
  )
  const orphanedAnchoredActivityEntries = activityEntries.filter(({ activity }) => {
    const ordinal = getActivityMessageOrdinal(activity)
    return ordinal != null && !messageOrdinals.has(ordinal)
  })

  return (
    <article
      ref={ref}
      className={`v2-turn ${focused ? 'focused' : ''}`}
      data-turn={turn.index}
      onClick={onFocus}
    >
      <div className="v2-anchor">
        <span className="v2-num mono">{String(turn.index + 1).padStart(2, '0')}</span>
        <span className="v2-line" />
      </div>
      <div className="v2-content">
        <header className="v2-thead">
          <span className="v2-meta mono">
            {formatDuration(turn.durationMs)}{' '}
            {'\u00b7'} {formatTokens(tokenIn)}\u2191/{formatTokens(tokenOut)}\u2193
            {turn.tokenUsage?.sourceCostUsd != null && <> {'\u00b7'} ${turn.tokenUsage.sourceCostUsd.toFixed(4)} recorded</>}
            {(turn.tokenUsage?.cacheReadTokens ?? 0) > 0 && <> {'\u00b7'} cache read {formatTokens(turn.tokenUsage!.cacheReadTokens!)}</>}
            {(turn.tokenUsage?.cacheWriteTokens ?? 0) > 0 && <> {'\u00b7'} cache write {formatTokens(turn.tokenUsage!.cacheWriteTokens!)}</>}
          </span>
        </header>

        <div className="v2-bubble user group" data-turn-bubble={turn.index}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
            <span className="v2-role" style={{ marginBottom: 0 }}>USER</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="v2-time mono">{formatTime(turn.startedAt)}</span>
              <CopyButton text={userCopyText} />
            </div>
          </div>
          <MarkdownContent content={userContent} searchQuery={searchQuery} className="v2-msg" />
        </div>

        {unanchoredActivityEntries.map(({ activity, idx }) => (
          <ActivityBlock
            key={getActivityKey(activity, idx, turn.index)}
            activity={activity}
            turnIndex={turn.index}
            projectPath={projectPath}
          />
        ))}

        {turn.assistantMessages.map((msg, index) => {
          const attachedActivities = activitiesByOrdinal.get(msg.ordinal) ?? []
          const showMessage = shouldRenderAssistantMessage(msg)
          return (
            <div key={getMessageKey(msg, index)}>
              {showMessage && (
                <div className="v2-bubble asst group">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span className="v2-role" style={{ marginBottom: 0 }}>ASSISTANT</span>
                    <CopyButton text={msg.content} />
                  </div>
                  <MarkdownContent content={msg.content} searchQuery={searchQuery} className="v2-msg" />
                </div>
              )}
              {attachedActivities.map(({ activity, idx }) => (
                <ActivityBlock
                  key={getActivityKey(activity, idx, turn.index)}
                  activity={activity}
                  turnIndex={turn.index}
                  projectPath={projectPath}
                />
              ))}
            </div>
          )
        })}

        {orphanedAnchoredActivityEntries.map(({ activity, idx }) => (
          <ActivityBlock
            key={getActivityKey(activity, idx, turn.index)}
            activity={activity}
            turnIndex={turn.index}
            projectPath={projectPath}
          />
        ))}
      </div>
    </article>
  )
}

function Spine({ turns, focused, onPick }: { turns: TraceTurn[]; focused: number; onPick: (idx: number) => void }) {
  return (
    <aside className="v2-spine">
      <div className="v2-spine-head">
        <span className="eyebrow">TRACE</span>
        <span className="mono v2-dim">{turns.length} turns</span>
      </div>
      <div className="v2-spine-rail">
        {turns.map((t) => {
          const counts = t.enrichment?.activityCounts
          const tools = counts?.toolCalls ?? t.activities.filter((a) => a.type === 'tool_call').length
          const skills = counts?.skills ?? t.activities.filter((a) => a.type === 'skill_use').length
          const agents = counts?.subagents ?? t.activities.filter((a) => a.type === 'subagent_link').length
          const userPreview = t.userMessage?.content || ''

          return (
            <button
              key={t.index}
              className={`v2-spine-node ${focused === t.index ? 'focused' : ''}`}
              onClick={() => onPick(t.index)}
            >
              <span className="v2-spine-num mono">{String(t.index + 1).padStart(2, '0')}</span>
              <span className="v2-spine-preview">
                {userPreview.slice(0, 32)}
                {userPreview.length > 32 ? '\u2026' : ''}
              </span>
              <span className="v2-spine-glyphs">
                {tools > 0 && <span className="v2-glyph t">{'\u25AA'}{tools}</span>}
                {skills > 0 && <span className="v2-glyph s">{'\u25C7'}{skills}</span>}
                {agents > 0 && <span className="v2-glyph a">{'\u25C6'}{agents}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

function Inspector({
  turn,
  session,
  onClose,
}: {
  turn: TraceTurn | null
  session: TraceSession | null
  onClose: () => void
}) {
  if (!turn) return null

  const tokenIn = turn.tokenUsage?.inputTokens ?? 0
  const tokenOut = turn.tokenUsage?.outputTokens ?? 0

  const visibleActivities = turn.activities.filter(
    (a) => a.type === 'tool_call' || a.type === 'skill_use' || a.type === 'subagent_link'
  )

  function inspectorActivityMeta(act: TraceActivity) {
    if (act.type === 'tool_call') {
      const cat = act.category
      const color =
        cat === 'Edit' ? 'var(--accent)' :
        cat === 'Bash' ? 'oklch(0.78 0.12 300)' :
        cat === 'Read' || cat === 'Grep' ? 'oklch(0.78 0.10 220)' :
        cat === 'Agent' ? 'oklch(0.78 0.15 320)' :
        'var(--muted-foreground)'
      let path = ''
      try { const p = JSON.parse(act.inputJson); path = p.file_path || p.path || '' } catch { /* ignore */ }
      return { name: act.displayName || act.name, path, color }
    }
    if (act.type === 'skill_use') return { name: act.displayName || act.name, path: '', color: 'oklch(0.78 0.15 50)' }
    if (act.type === 'subagent_link') return { name: 'subagent', path: act.subagentSessionId, color: 'oklch(0.78 0.15 320)' }
    return { name: '', path: '', color: 'var(--muted-foreground)' }
  }

  return (
    <aside className="v2-inspect">
      <header className="v2-ins-head">
        <span className="eyebrow">TURN {String(turn.index + 1).padStart(2, '0')} {'\u00b7'} INSPECT</span>
        <button className="v2-ins-close" onClick={onClose}>
          {'\u00d7'}
        </button>
      </header>

      <div className="v2-ins-hudgrid">
        <div className="v2-ins-cell">
          <span className="v2-ins-k">TIME</span>
          <span className="v2-ins-v mono">{formatTime(turn.startedAt)}</span>
        </div>
        <div className="v2-ins-cell">
          <span className="v2-ins-k">DUR</span>
          <span className="v2-ins-v mono">{formatDuration(turn.durationMs)}</span>
        </div>
        <div className="v2-ins-cell">
          <span className="v2-ins-k">IN</span>
          <span className="v2-ins-v mono">
            {formatTokens(tokenIn)}
            <small>{'\u2191'}</small>
          </span>
        </div>
        <div className="v2-ins-cell">
          <span className="v2-ins-k">OUT</span>
          <span className="v2-ins-v mono">
            {formatTokens(tokenOut)}
            <small>{'\u2193'}</small>
          </span>
        </div>
      </div>

      <div className="v2-ins-section">
        <div className="eyebrow">ACTIVITY {'\u00b7'} {visibleActivities.length}</div>
        <div className="v2-ins-stack">
          {visibleActivities.length === 0 ? (
            <div className="v2-ins-empty mono">{'\u2014'} no tools called</div>
          ) : (
            visibleActivities.map((act, i) => {
              const { name, path, color } = inspectorActivityMeta(act)
              return (
                <div key={i} className="v2-ins-act">
                  <span
                    className="v2-ins-pip"
                    style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                  />
                  <span className="mono v2-ins-actname">{name}</span>
                  <span className="mono v2-ins-actpath">{path}</span>
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="v2-ins-section">
        <div className="eyebrow">CONTEXT</div>
        <dl className="v2-ins-kv">
          <dt>Model</dt>
          <dd className="mono">{session?.model || extractModel(session?.turns || []) || '\u2014'}</dd>
          <dt>Project</dt>
          <dd>{session?.project || '\u2014'}</dd>
          <dt>Branch</dt>
          <dd className="mono">{session?.gitBranch || '\u2014'}</dd>
          <dt>CWD</dt>
          <dd className="mono">{session?.cwd || '\u2014'}</dd>
        </dl>
      </div>
    </aside>
  )
}

export function TraceThread({
  session,
  turns,
  sessionId,
  onBackToSessions,
  hasMore,
  loadingMore,
  onLoadMore,
  totalTurns,
}: TraceThreadProps) {
  const [focused, setFocused] = useState(0)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const searchMatches = useReplayStore((s) => s.searchMatches)
  const currentMatchIndex = useReplayStore((s) => s.currentMatchIndex)
  const setCurrentMatchIndex = useReplayStore((s) => s.setCurrentMatchIndex)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isProgrammaticScroll = useRef(false)
  const skipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loadedTotal = turns.length
  const totalAvailable = totalTurns ?? loadedTotal
  const totalLabel = totalAvailable > loadedTotal ? `${loadedTotal}/${totalAvailable}` : String(totalAvailable)

  const isVirtual = turns.length > VIRTUALIZATION_THRESHOLD || hasMore

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual owns its scroll subscription.
  const rowVirtualizer = useVirtualizer({
    count: isVirtual ? turns.length + (hasMore ? 1 : 0) : turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 260,
    overscan: 4,
    enabled: isVirtual,
  })

  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
  }, [rowVirtualizer])

  const virtualItems = rowVirtualizer.getVirtualItems()
  const lastVirtualIndex = virtualItems.length > 0
    ? virtualItems[virtualItems.length - 1].index
    : null

  useEffect(() => {
    if (!isVirtual || !hasMore || loadingMore || lastVirtualIndex == null) return
    if (lastVirtualIndex >= turns.length - 1) {
      onLoadMore()
    }
  }, [turns.length, hasMore, isVirtual, lastVirtualIndex, loadingMore, onLoadMore])

  const scrollToTurn = useCallback((idx: number) => {
    const container = scrollRef.current
    if (!container) return
    const turnIndex = turns.findIndex((turn) => turn.index === idx)
    if (isVirtual && turnIndex !== -1) {
      rowVirtualizer.scrollToIndex(turnIndex, { align: 'start' })
      return
    }
    const el =
      container.querySelector<HTMLElement>(`[data-turn-bubble="${idx}"]`) ??
      container.querySelector<HTMLElement>(`[data-turn="${idx}"]`)
    if (!el) return
    const containerRect = container.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    container.scrollTo({
      top: elRect.top - containerRect.top + container.scrollTop - 24,
      behavior: 'smooth',
    })
  }, [turns, isVirtual, rowVirtualizer])

  const focus = useCallback(
    (idx: number) => {
      isProgrammaticScroll.current = true
      clearTimeout(skipTimer.current)
      skipTimer.current = setTimeout(() => { isProgrammaticScroll.current = false }, 800)
      setFocused(idx)
      scrollToTurn(idx)
    },
    [scrollToTurn]
  )

  const moveFocus = useCallback(
    (delta: number) => {
      if (turns.length === 0) return
      const currentPosition = Math.max(0, turns.findIndex((turn) => turn.index === focused))
      const nextPosition = Math.max(0, Math.min(currentPosition + delta, turns.length - 1))
      const nextTurn = turns[nextPosition]
      if (nextTurn) focus(nextTurn.index)
    },
    [focused, focus, turns],
  )

  useEffect(() => () => clearTimeout(skipTimer.current), [])

  // Scroll to matching turn when currentMatchIndex changes
  useEffect(() => {
    if (!searchMatches.length || currentMatchIndex === 0) return
    const match = searchMatches[currentMatchIndex - 1]
    if (!match) return
    const turn = turns.find((t) => t.id === match.turnId)
    if (turn) focus(turn.index)
  }, [currentMatchIndex, searchMatches, turns, focus])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'j') { e.preventDefault(); moveFocus(1) }
      if (e.key === 'k') { e.preventDefault(); moveFocus(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moveFocus])

  // Track which turn is in view while user scrolls manually
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const onScroll = () => {
      if (isProgrammaticScroll.current) return
      const turnEls = container.querySelectorAll<HTMLElement>('[data-turn]')
      const containerTop = container.getBoundingClientRect().top
      let best: { idx: number; top: number } | null = null
      for (const el of turnEls) {
        const top = el.getBoundingClientRect().top - containerTop
        if (top <= 60 && (best === null || top > best.top)) {
          best = { idx: Number(el.dataset.turn), top }
        }
      }
      if (best !== null && !isNaN(best.idx)) setFocused(best.idx)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [])

  const displayStatus = deriveDisplayStatus(session)
  const model = session?.model || extractModel(turns)
  const focusedTurn = turns.find((turn) => turn.index === focused) ?? turns[0] ?? null
  const focusedPosition = turns.findIndex((turn) => turn.index === focused)
  const focusedLabel = focusedPosition >= 0 ? focusedPosition + 1 : Math.min(focused + 1, loadedTotal)

  const totalInput = session?.inputTokens ?? session?.metrics.inputTokens ?? 0
  const totalOutput = session?.outputTokens ?? session?.metrics.outputTokens ?? 0
  const cost = session?.estimatedCost != null ? formatSessionCost(session) : null

  // Parent session back-link (D-06 part 3)
  const { href } = useAgentTool()
  const router = useRouter()
  const parentSessionId = session?.parentSessionId
  const parentHref = parentSessionId ? href(`/sessions/${parentSessionId}`) : null
  const resolvedSessionId = session?.id ?? sessionId
  const visibleSessionId = session?.sourceSessionId ?? resolvedSessionId

  const isStarred = useStarredStore((s) => s.isStarred(resolvedSessionId))
  const toggleStar = useStarredStore((s) => s.toggle)

  return (
    <div className="v2-root">
      <div className="v2-hud">
        <button className="v2-back" onClick={onBackToSessions}>
          {'\u2039'} SESSIONS
        </button>
        <div className="v2-title-block">
          <div className="v2-title">{session?.displayTitle || session?.name || visibleSessionId || '\u2014'}</div>
          <div className="v2-subline mono">
            <span className="v2-hash">{'\u25C6'} {visibleSessionId}</span>
            <span className="v2-sep">/</span>
            <span>{session?.project || '\u2014'}</span>
            {model && (
              <>
                <span className="v2-sep">/</span>
                <span>{model}</span>
              </>
            )}
            {parentHref && (
              <>
                <span className="v2-sep">/</span>
                <button
                  onClick={(e) => { e.stopPropagation(); router.push(parentHref) }}
                  className="inline-flex items-center gap-1 hover:text-accent transition-colors"
                  style={{ color: 'oklch(0.78 0.15 320)', fontSize: 'inherit' }}
                  title={`Parent session: ${parentSessionId}`}
                >
                  <CornerLeftUp style={{ width: 10, height: 10 }} />
                  SPAWNED
                </button>
              </>
            )}
          </div>
        </div>
        <button
          className={`v2-hud-star${isStarred ? ' active' : ''}`}
          title={isStarred ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => toggleStar(resolvedSessionId)}
        >
          ★
        </button>
        <div className="v2-hud-stats">
          <div className="v2-hud-stat">
            <span className="v2-hud-k">TURNS</span>
            <span className="v2-hud-v mono">{totalLabel}</span>
          </div>
          <div className="v2-hud-stat">
            <span className="v2-hud-k">IN</span>
            <span className="v2-hud-v mono">{formatTokens(totalInput)}</span>
          </div>
          <div className="v2-hud-stat">
            <span className="v2-hud-k">OUT</span>
            <span className="v2-hud-v mono">{formatTokens(totalOutput)}</span>
          </div>
          {cost && (
            <div className="v2-hud-stat">
              <span className="v2-hud-k">COST</span>
              <span className="v2-hud-v mono accent">{cost}</span>
            </div>
          )}
        </div>
        {displayStatus && (
          <HudPill color={displayStatus.color} pulse={displayStatus.pulse}>
            {displayStatus.label}
          </HudPill>
        )}
        <button
          className="v2-hud-icon"
          title="Inspector"
          onClick={() => setInspectorOpen((o) => !o)}
        >
          {inspectorOpen ? '\u00bb' : '\u00ab'}
        </button>
      </div>

      {session?.source === 'commandcode' && (
        <p className="px-4 py-2 text-sm text-muted-foreground" role="note">
          Command Code history includes parent messages and agent prompts/results. Child conversation and tool traces were not recorded. Recorded costs cover parent model calls; agent results may contain additional token totals.
        </p>
      )}

      <div className="v2-cmd">
        <div className="v2-search">
          <ReplaySearchBar turns={turns} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            className="v2-step"
            onClick={() => {
              if (searchMatches.length > 0) {
                setCurrentMatchIndex(currentMatchIndex < searchMatches.length ? currentMatchIndex + 1 : 1)
              } else {
                document.querySelector<HTMLInputElement>('.v2-search-input')?.focus()
              }
            }}
            title="Search (Enter for next match)"
          >
            <Search size={11} />
          </button>
          {searchMatches.length > 0 && (
            <>
              <button
                className="v2-step"
                onClick={() => setCurrentMatchIndex(currentMatchIndex > 1 ? currentMatchIndex - 1 : searchMatches.length)}
                title="Prev match (Shift+Enter)"
              >
                <ChevronUp size={11} />
              </button>
              <button
                className="v2-step"
                onClick={() => setCurrentMatchIndex(currentMatchIndex < searchMatches.length ? currentMatchIndex + 1 : 1)}
                title="Next match (Enter)"
              >
                <ChevronDown size={11} />
              </button>
            </>
          )}
        </div>
        <div className="v2-cmd-controls">
          <SessionIdCopyButton
            sessionId={resolvedSessionId}
            displaySessionId={visibleSessionId}
            copySessionId={visibleSessionId}
            displayMode="head8"
            showCopyIconOnHover
            className="text-[10px] font-mono text-muted-foreground transition-colors hover:text-foreground"
          />
          <span className="v2-cmd-sep">{'\u2502'}</span>
          <button className="v2-step" onClick={() => moveFocus(-1)} disabled={loadedTotal === 0} title="Prev (k)">
            {'\u2039'}
          </button>
          <span className="v2-step-pos mono">
            {String(focusedLabel).padStart(2, '0')} <span className="v2-dim">of</span> {totalLabel}
          </span>
          <button className="v2-step" onClick={() => moveFocus(1)} disabled={loadedTotal === 0} title="Next (j)">
            {'\u203a'}
          </button>
          <span className="v2-cmd-sep">{'\u2502'}</span>
          <span className="v2-hint mono">j / k {'\u00b7'} /</span>
        </div>
      </div>

      <div className="v2-grid">
        <Spine turns={turns} focused={focused} onPick={focus} />

        <main className="v2-trace" ref={scrollRef}>
          <div className="v2-trace-pad">
            {turns.length === 0 && !hasMore ? (
              <div className="v2-trace-end mono">
                {'\u2014'} NO TURNS {'\u2014'}
              </div>
            ) : isVirtual ? (
              <div
                className="v2-virtual-space"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
                {virtualItems.map((virtualItem) => {
                  const turn = turns[virtualItem.index]
                  if (!turn) {
                    return (
                      <div
                        key="load-more"
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualItem.index}
                        className="v2-virtual-row v2-load-row"
                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                      >
                        <button
                          type="button"
                          className="v2-load-more mono"
                          onClick={onLoadMore}
                          disabled={loadingMore}
                        >
                          {loadingMore ? 'LOADING\u2026' : 'LOAD MORE'}
                        </button>
                      </div>
                    )
                  }

                  return (
                    <div
                      key={turn.id}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualItem.index}
                      className="v2-virtual-row"
                      style={{ transform: `translateY(${virtualItem.start}px)` }}
                    >
                      <TurnCard
                        turn={turn}
                        focused={focused === turn.index}
                        onFocus={() => setFocused(turn.index)}
                        projectPath={session?.cwd ?? session?.project}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              turns.map((t) => (
                <TurnCard
                  key={t.id}
                  turn={t}
                  focused={focused === t.index}
                  onFocus={() => setFocused(t.index)}
                  projectPath={session?.cwd ?? session?.project}
                />
              ))
            )}
            {!hasMore && turns.length > 0 && (
              <div className="v2-trace-end mono">{'\u2014'} END OF TRACE {'\u2014'}</div>
            )}
          </div>
        </main>

        {inspectorOpen && (
          <Inspector turn={focusedTurn} session={session} onClose={() => setInspectorOpen(false)} />
        )}
      </div>
    </div>
  )
}
