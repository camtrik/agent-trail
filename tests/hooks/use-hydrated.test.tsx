// @vitest-environment jsdom

import { act } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { useHydrated } from '@/lib/use-hydrated'

function HydrationIndicator() {
  return <span>{useHydrated() ? 'client' : 'server'}</span>
}

it('preserves the server snapshot during hydration before showing client state', async () => {
  const container = document.createElement('div')
  container.innerHTML = renderToString(<HydrationIndicator />)
  expect(container.textContent).toBe('server')
  const onRecoverableError = vi.fn()

  let root: ReturnType<typeof hydrateRoot> | undefined
  try {
    await act(async () => {
      root = hydrateRoot(container, <HydrationIndicator />, { onRecoverableError })
    })
    expect(container.textContent).toBe('client')
    expect(onRecoverableError).not.toHaveBeenCalled()
  } finally {
    await act(async () => root?.unmount())
  }
})
