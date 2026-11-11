'use client'

import { useEffect, useRef, useState } from 'react'
import { useHydrated } from '@/lib/use-hydrated'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

export interface SessionsFilterState {
  groupByProject: boolean
  dateRangeActive: boolean
  dateFrom: string
  dateTo: string
}

interface SessionsFilterPanelProps {
  state: SessionsFilterState
  onGroupByProjectToggle: () => void
  onDateRangeToggle: () => void
  onDateFromChange: (date: string) => void
  onDateToChange: (date: string) => void
  onClearAll: () => void
}

// ============================================================================
// Helpers
// ============================================================================

function hasActiveFilters(s: SessionsFilterState): boolean {
  return s.groupByProject || (s.dateRangeActive && (!!s.dateFrom || !!s.dateTo))
}

function CheckIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 4L3 5.5L6.5 2.5" />
    </svg>
  )
}

// ============================================================================
// SessionsFilterPanel
// ============================================================================

export function SessionsFilterPanel({
  state,
  onGroupByProjectToggle,
  onDateRangeToggle,
  onDateFromChange,
  onDateToChange,
  onClearAll,
}: SessionsFilterPanelProps) {
  const [open, setOpen] = useState(false)
  const mounted = useHydrated()
  const containerRef = useRef<HTMLDivElement>(null)
  const filtersActive = hasActiveFilters(state)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  return (
    <div ref={containerRef} className="sfp-root">
      <button
        type="button"
        className={cn('sfp-trigger', open && 'sfp-trigger--open')}
        onClick={() => setOpen(p => !p)}
        aria-label="Filter sessions"
        title="Filter sessions"
        aria-expanded={open}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        {mounted && filtersActive && <span className="sfp-dot" />}
      </button>

      {open && (
        <div className="sfp-panel">

          {/* DISPLAY */}
          <div className="sfp-section">
            <div className="sfp-section-title">Display</div>
            <button
              type="button"
              className={cn('sfp-row', state.groupByProject && 'sfp-row--active')}
              onClick={onGroupByProjectToggle}
            >
              <span className={cn('sfp-check', state.groupByProject && 'sfp-check--on')}>
                {state.groupByProject && <CheckIcon />}
              </span>
              <span>Group by project</span>
            </button>
          </div>

          {/* DATE RANGE */}
          <div className="sfp-section">
            <div className="sfp-section-title">Date Range</div>
            <button
              type="button"
              className={cn('sfp-row', state.dateRangeActive && 'sfp-row--active')}
              onClick={onDateRangeToggle}
            >
              <span className={cn('sfp-check', state.dateRangeActive && 'sfp-check--on')}>
                {state.dateRangeActive && <CheckIcon />}
              </span>
              <span>By date range</span>
            </button>
            {state.dateRangeActive && (
              <div className="sfp-date-inputs">
                <div className="sfp-date-row">
                  <span className="sfp-date-label">FROM</span>
                  <input
                    type="date"
                    className="sfp-date-input"
                    value={state.dateFrom}
                    onChange={(e) => onDateFromChange(e.target.value)}
                  />
                </div>
                <div className="sfp-date-row">
                  <span className="sfp-date-label">TO</span>
                  <input
                    type="date"
                    className="sfp-date-input"
                    value={state.dateTo}
                    onChange={(e) => onDateToChange(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          {/* CLEAR */}
          {filtersActive && (
            <button
              type="button"
              className="sfp-clear"
              onClick={() => { onClearAll(); setOpen(false) }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  )
}
