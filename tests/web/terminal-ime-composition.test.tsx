// @vitest-environment jsdom
//
// M5b impl:terminal — IME (Chinese input) bridge over the xterm helper textarea.
// CJK composition is the classic mobile double-commit pitfall: the bridge must
// keep the composing flag TRUE across multi-keystroke updates, commit the final
// string EXACTLY ONCE on compositionend, and release composition synchronously
// so an immediately-following slash/ASCII key is not swallowed on iOS Safari.

import { afterEach, describe, expect, test, vi } from 'vitest'

import { attachCompositionBridge as attachCompositionBridgeRaw } from '../../web/src/terminal/composition.js'

const bridgeDisposers: Array<() => void> = []
const attachCompositionBridge = (...args: Parameters<typeof attachCompositionBridgeRaw>) => {
  const bridge = attachCompositionBridgeRaw(...args)
  bridgeDisposers.push(bridge.dispose)
  return bridge
}

afterEach(() => {
  for (const dispose of bridgeDisposers.splice(0)) dispose()
  document.body.replaceChildren()
})

const fireComposition = (
  el: HTMLElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data: string
) => {
  const event = new CompositionEvent(type, { data })
  el.dispatchEvent(event)
}

const fireInput = (
  el: HTMLElement,
  input: { data: string; inputType?: string } = { data: 'hello' }
) => {
  const event = new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    data: input.data,
    inputType: input.inputType ?? 'insertText',
  })
  el.dispatchEvent(event)
}

describe('attachCompositionBridge', () => {
  const connectedTextarea = () => {
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    return textarea
  }

  test('commits the composed string exactly once on compositionend', () => {
    const textarea = connectedTextarea()
    const commit = vi.fn()
    const setComposing = vi.fn()
    attachCompositionBridge(textarea, { commit, setComposing })

    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionupdate', '你')
    fireComposition(textarea, 'compositionupdate', '你好')
    expect(commit).not.toHaveBeenCalled() // never commit per-update
    fireComposition(textarea, 'compositionend', '你好')

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('你好')
  })

  test('releases composition synchronously so the next slash is sent immediately', () => {
    const textarea = connectedTextarea()
    let composing = false
    const sent: string[] = []
    const bridge = attachCompositionBridge(textarea, {
      commit: () => {},
      setComposing: (v) => {
        composing = v
      },
    })

    fireComposition(textarea, 'compositionstart', '')
    expect(composing).toBe(true)
    fireComposition(textarea, 'compositionupdate', '你')
    expect(composing).toBe(true)
    fireComposition(textarea, 'compositionend', '你好')
    expect(composing).toBe(false)

    const filtered = bridge.filterData('/')
    if (!composing && filtered) sent.push(filtered)
    expect(sent).toEqual(['/'])
  })

  test('removes the committed prefix from a delayed merged xterm chunk', () => {
    const textarea = connectedTextarea()
    const bridge = attachCompositionBridge(textarea, { commit: () => {}, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionend', '你好')

    expect(bridge.filterData('你好/')).toBe('/')
    expect(bridge.filterData('a')).toBe('a')
    expect(bridge.filterData('\u007f')).toBe('\u007f')
  })

  test('intercepts the real composition input sequence before xterm and sends only the final text', () => {
    const textarea = connectedTextarea()
    const xtermSent: string[] = []
    textarea.addEventListener(
      'input',
      (event) => {
        const input = event as InputEvent
        if (input.inputType === 'insertText' && input.data) {
          xtermSent.push(input.data)
          input.preventDefault()
        }
      },
      { capture: true }
    )
    const committed: string[] = []
    attachCompositionBridge(textarea, {
      commit: (text) => committed.push(text),
      setComposing: () => {},
    })

    fireComposition(textarea, 'compositionstart', '')
    textarea.value = 'n'
    fireInput(textarea, { data: 'n', inputType: 'insertCompositionText' })
    fireComposition(textarea, 'compositionupdate', '你')
    fireComposition(textarea, 'compositionend', '你好')
    textarea.value = '你好/'
    fireInput(textarea, { data: '你好/' })

    expect(committed).toEqual(['你好', '/'])
    expect(xtermSent).toEqual([])
    expect(textarea.value).toBe('')
  })

  test('a second composition with the same text is a new commit', () => {
    const textarea = connectedTextarea()
    const commit = vi.fn()
    attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionend', '你')
    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionend', '你')

    expect(commit.mock.calls).toEqual([['你'], ['你']])
  })

  test('clears the textarea synchronously on end so xterm cannot re-commit', () => {
    const textarea = connectedTextarea()
    textarea.value = '你好'
    attachCompositionBridge(textarea, { commit: () => {}, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionend', '你好')
    expect(textarea.value).toBe('')
  })

  test('empty-data compositionend commits textarea-delivered text once', () => {
    const textarea = connectedTextarea()
    textarea.value = '语音输入的一整句'
    const commit = vi.fn()
    attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionend', '')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('语音输入的一整句')
    expect(textarea.value).toBe('')
  })

  test('empty-data compositionend without textarea text does not emit a spurious commit', () => {
    const textarea = connectedTextarea()
    const commit = vi.fn()
    attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionend', '')
    expect(commit).not.toHaveBeenCalled()
  })

  test('insertText during composition waits for the final compositionend', () => {
    const textarea = connectedTextarea()
    const commit = vi.fn()
    const bridge = attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    textarea.value = '听写提交'
    fireInput(textarea, { data: '听写提交' })
    expect(commit).not.toHaveBeenCalled()
    expect(textarea.value).toBe('听写提交')

    fireComposition(textarea, 'compositionend', '')

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('听写提交')
    expect(bridge.filterData('听写提交')).toBe('')
    expect(bridge.filterData('next')).toBe('next')
  })

  test('partial composition input is not committed before compositionend', () => {
    const textarea = connectedTextarea()
    const commit = vi.fn()
    attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    textarea.value = 'n'
    fireInput(textarea, { data: 'n', inputType: 'insertCompositionText' })

    expect(commit).not.toHaveBeenCalled()
    expect(textarea.value).toBe('n')
  })

  test('handled non-composition input is cleared without a second commit', () => {
    const textarea = connectedTextarea()
    const commit = vi.fn()
    textarea.addEventListener('input', (event) => event.preventDefault(), { capture: true })
    attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    textarea.value = 'voice text'
    fireInput(textarea, { data: 'voice text' })

    expect(commit).not.toHaveBeenCalled()
    expect(textarea.value).toBe('')
  })

  test('the disposer removes the listeners (no commit after dispose)', () => {
    const textarea = connectedTextarea()
    const commit = vi.fn()
    const composingStates: boolean[] = []
    const bridge = attachCompositionBridge(textarea, {
      commit,
      setComposing: (value) => composingStates.push(value),
    })

    fireComposition(textarea, 'compositionstart', '')
    bridge.dispose()
    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionend', '你好')
    expect(commit).not.toHaveBeenCalled()
    expect(composingStates.at(-1)).toBe(false)
    expect(bridge.filterData('/')).toBe('/')
  })
})
