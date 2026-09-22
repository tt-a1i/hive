/**
 * IME bridge for xterm's hidden textarea.
 *
 * xterm keeps ownership of the visual CompositionHelper. This bridge is the
 * single authority for outbound composed text: it commits only the final value,
 * intercepts the browser's trailing input event before xterm can re-send it,
 * and filters a defensive delayed xterm replay. Ordinary key/input events pass
 * through synchronously.
 */

export interface CompositionSink {
  setComposing: (composing: boolean) => void
  commit: (text: string) => void
  input?: (text: string) => void
}

export interface CompositionBridge {
  dispose: () => void
  filterData: (chunk: string) => string
}

export const attachCompositionBridge = (
  textarea: HTMLTextAreaElement,
  sink: CompositionSink
): CompositionBridge => {
  let composing = false
  let inputOnlyKey = false
  let trailingCompositionText = ''

  const clearTextarea = () => {
    textarea.value = ''
    textarea.scrollLeft = 0
    textarea.scrollTop = 0
  }
  const textFromInput = (event: InputEvent) => event.data || textarea.value
  const isFinalTextInput = (event: InputEvent) =>
    event.inputType === 'insertText' ||
    event.inputType === 'insertFromComposition' ||
    event.inputType === 'insertReplacementText' ||
    event.inputType === 'insertDictationResult'
  const stopInputBeforeXterm = (event: InputEvent) => {
    clearTextarea()
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const controlInput = (input: InputEvent) => {
    switch (input.inputType) {
      case 'deleteContentBackward':
        return '\x7f'
      case 'deleteContentForward':
        return '\x1b[3~'
      case 'insertLineBreak':
      case 'insertParagraph':
        return '\r'
      default:
        return null
    }
  }
  const onBeforeInput = (event: Event) => {
    if (event.target !== textarea) return
    const input = event as InputEvent
    if (input.inputType === 'insertFromPaste') trailingCompositionText = ''
    const bytes = controlInput(input)
    if (!inputOnlyKey || composing || input.isComposing || !input.cancelable || !bytes) return
    inputOnlyKey = false
    trailingCompositionText = ''
    ;(sink.input ?? sink.commit)(bytes)
    stopInputBeforeXterm(input)
  }

  const onStart = () => {
    composing = true
    inputOnlyKey = false
    trailingCompositionText = ''
    sink.setComposing(true)
  }
  const onUpdate = () => {
    composing = true
    sink.setComposing(true)
  }
  const onEnd = (event: Event) => {
    const data = (event as CompositionEvent).data
    const composed = data || textarea.value
    if (composed) sink.commit(composed)
    if (composed) trailingCompositionText = composed
    clearTextarea()
    composing = false
    sink.setComposing(false)
  }

  // xterm registers its input listener on the textarea before this bridge is
  // attached. Listening at the document capture phase lets us stop only IME
  // completion events before they reach xterm, while ordinary input remains on
  // xterm's native path.
  const onDocumentInput = (event: Event) => {
    if (event.target !== textarea) return
    const input = event as InputEvent
    const text = textFromInput(input)

    if (composing || input.isComposing) {
      // `insertCompositionText` is the IME's live candidate. xterm does not
      // submit it, and clearing the textarea here can cancel the iOS candidate.
      return
    }

    const bytes = controlInput(input)
    if (inputOnlyKey && (isFinalTextInput(input) || bytes)) {
      inputOnlyKey = false
      trailingCompositionText = ''
      if (bytes || text) (sink.input ?? sink.commit)(bytes ?? text)
      stopInputBeforeXterm(input)
      return
    }

    if (trailingCompositionText && isFinalTextInput(input)) {
      if (text === trailingCompositionText) {
        trailingCompositionText = ''
        stopInputBeforeXterm(input)
        return
      }
      if (text.startsWith(trailingCompositionText)) {
        const remainder = text.slice(trailingCompositionText.length)
        trailingCompositionText = ''
        if (remainder) sink.commit(remainder)
        stopInputBeforeXterm(input)
        return
      }
    }

    trailingCompositionText = ''
  }

  // Runs after xterm's capture listener for ordinary input and only clears the
  // helper value it already handled. This prevents its deferred composition
  // read from merging the next ASCII character into the prior CJK commit.
  const onTextareaInput = (event: Event) => {
    const input = event as InputEvent
    if (input.defaultPrevented && isFinalTextInput(input)) clearTextarea()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== textarea || composing || event.isComposing) return
    // A new key is not a delayed replay of the previous composition.
    trailingCompositionText = ''
    inputOnlyKey =
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      (event.keyCode === 229 || event.keyCode === 0)
    // 229 normally schedules a deferred textarea diff in xterm. The ensuing
    // input event owns this edit instead; do not run two competing senders.
    if (inputOnlyKey && event.keyCode === 229) event.stopImmediatePropagation()
  }
  const onKeyPress = (event: KeyboardEvent) => {
    if (event.target === textarea) inputOnlyKey = false
  }
  const onPaste = (event: Event) => {
    if (event.target === textarea) trailingCompositionText = ''
  }

  const compositionOptions: AddEventListenerOptions = { capture: true }
  textarea.addEventListener('compositionstart', onStart, compositionOptions)
  textarea.addEventListener('compositionupdate', onUpdate, compositionOptions)
  textarea.addEventListener('compositionend', onEnd, compositionOptions)
  textarea.ownerDocument.addEventListener('input', onDocumentInput, true)
  textarea.ownerDocument.addEventListener('beforeinput', onBeforeInput, true)
  textarea.ownerDocument.addEventListener('paste', onPaste, true)
  textarea.ownerDocument.addEventListener('keydown', onKeyDown, true)
  textarea.ownerDocument.addEventListener('keypress', onKeyPress, true)
  textarea.addEventListener('input', onTextareaInput, compositionOptions)

  return {
    dispose: () => {
      textarea.removeEventListener('compositionstart', onStart, compositionOptions)
      textarea.removeEventListener('compositionupdate', onUpdate, compositionOptions)
      textarea.removeEventListener('compositionend', onEnd, compositionOptions)
      textarea.ownerDocument.removeEventListener('input', onDocumentInput, true)
      textarea.ownerDocument.removeEventListener('beforeinput', onBeforeInput, true)
      textarea.ownerDocument.removeEventListener('paste', onPaste, true)
      textarea.ownerDocument.removeEventListener('keydown', onKeyDown, true)
      textarea.ownerDocument.removeEventListener('keypress', onKeyPress, true)
      textarea.removeEventListener('input', onTextareaInput, compositionOptions)
      composing = false
      inputOnlyKey = false
      trailingCompositionText = ''
      sink.setComposing(false)
    },
    filterData: (chunk: string) => {
      if (composing) return ''
      if (!trailingCompositionText || !chunk.startsWith(trailingCompositionText)) return chunk
      const remainder = chunk.slice(trailingCompositionText.length)
      trailingCompositionText = ''
      return remainder
    },
  }
}
