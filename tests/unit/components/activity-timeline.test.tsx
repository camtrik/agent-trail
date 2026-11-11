// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ActivityTimeline } from '@/components/overview/activity-timeline'
import type { TimelineEvent } from '@/types/overview'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ActivityTimeline', () => {
  it('does not emit duplicate-key warnings when a session has multiple events', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const timeline: TimelineEvent[] = [
      {
        id: '4c96cd93-b1bf-4304-8095-e4808cec7b5d',
        source: 'codex',
        eventType: 'session_started',
        eventTime: '2026-05-16T10:00:00.000Z',
        project: 'project-a',
        name: 'Session A',
        status: 'active',
      },
      {
        id: '4c96cd93-b1bf-4304-8095-e4808cec7b5d',
        source: 'codex',
        eventType: 'session_completed',
        eventTime: '2026-05-16T10:05:00.000Z',
        project: 'project-a',
        name: 'Session A',
        status: 'idle',
      },
    ]

    render(<ActivityTimeline timeline={timeline} loading={false} />)

    expect(screen.getByText('Session started: Session A')).toBeTruthy()
    expect(screen.getByText('Session completed: Session A')).toBeTruthy()

    const duplicateKeyCalls = consoleError.mock.calls.filter((call) =>
      call.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('Encountered two children with the same key'),
      ),
    )
    expect(duplicateKeyCalls).toHaveLength(0)
  })
})
