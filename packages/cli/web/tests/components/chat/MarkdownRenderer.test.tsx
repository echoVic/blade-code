// @vitest-environment jsdom

import { act } from 'react'
import ReactDOM from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../../src/store/SettingsStore', () => ({
  useIsDark: () => false,
}))

import { MarkdownRenderer } from '../../../src/components/chat/MarkdownRenderer'

describe('MarkdownRenderer', () => {
  let container: HTMLDivElement
  let root: ReactDOM.Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = ReactDOM.createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  test('renders fenced code as plain preformatted text when syntax highlighting is disabled', () => {
    act(() => {
      root.render(
        <MarkdownRenderer
          content={'```ts\nconst answer = 42\n```'}
          syntaxHighlight={false}
        />
      )
    })

    expect(container.textContent).toContain('const answer = 42')
    expect(container.querySelector('button[title="Copy code"]')).toBeNull()
  })
})
