import * as Dialog from '@radix-ui/react-dialog'
import { Hexagon } from 'lucide-react'
import { useState } from 'react'

type FirstRunWizardProps = {
  open: boolean
  onClose: () => void
  onAddWorkspace: () => void
  onTryDemo: () => void
}

export const FirstRunWizard = ({
  open,
  onClose,
  onAddWorkspace,
  onTryDemo,
}: FirstRunWizardProps) => {
  const [slideIdx, setSlideIdx] = useState(0)

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setSlideIdx(0)
      onClose()
    }
  }

  const handleClose = () => {
    setSlideIdx(0)
    onClose()
  }

  const isLastSlide = slideIdx === 2

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            aria-label="Welcome to Hive"
            className="dialog-scale-pop elev-2 pointer-events-auto w-[480px] max-w-[calc(100vw-32px)] rounded-lg border p-6"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <Dialog.Description className="sr-only">
              First-run wizard — step {slideIdx + 1} of 3
            </Dialog.Description>

            {/* Slide content */}
            <div className="min-h-[200px]">
              {slideIdx === 0 && (
                <div className="flex flex-col items-center gap-4 py-4 text-center">
                  <div
                    aria-hidden
                    className="flex h-14 w-14 items-center justify-center rounded-2xl"
                    style={{
                      background: 'color-mix(in oklab, var(--accent) 15%, transparent)',
                      color: 'var(--accent)',
                      border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                    }}
                  >
                    <Hexagon size={32} />
                  </div>
                  <div className="space-y-2">
                    {/* Dialog.Title IS the visible welcome heading on slide 0 */}
                    <Dialog.Title className="text-xl font-semibold text-pri">
                      Welcome to Hive
                    </Dialog.Title>
                    <p className="text-sm text-sec">
                      Coordinate multiple CLI coding agents — locally.
                    </p>
                  </div>
                </div>
              )}
              {/* Hidden title for slides 1+ so Radix doesn't warn */}
              {slideIdx > 0 && <Dialog.Title className="sr-only">Welcome to Hive</Dialog.Title>}

              {slideIdx === 1 && (
                <div className="flex flex-col gap-4 py-2">
                  <h2 className="text-lg font-semibold text-pri">How it works</h2>
                  <ol className="flex flex-col gap-3">
                    {[
                      {
                        n: 1,
                        title: 'Add a workspace',
                        desc: 'Pick a project folder on your machine.',
                      },
                      {
                        n: 2,
                        title: 'Pick an Orchestrator',
                        desc: 'Claude Code, Codex, Gemini, OpenCode — your choice.',
                      },
                      {
                        n: 3,
                        title: 'Dispatch tasks',
                        desc: 'The Orchestrator routes work to Workers via team send.',
                      },
                    ].map(({ n, title, desc }) => (
                      <li key={n} className="flex items-start gap-3">
                        <span
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium"
                          style={{
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border-bright)',
                            color: 'var(--accent)',
                          }}
                        >
                          {n}
                        </span>
                        <div>
                          <div className="text-sm font-medium text-pri">{title}</div>
                          <div className="text-xs text-sec">{desc}</div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {slideIdx === 2 && (
                <div className="flex flex-col gap-3 py-2">
                  <h2 className="text-lg font-semibold text-pri">Get started</h2>
                  <p className="text-sm text-sec">Choose how you want to begin.</p>
                  <div className="mt-2 flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onAddWorkspace()
                        handleClose()
                      }}
                      className="icon-btn icon-btn--primary w-full justify-center"
                    >
                      Add Workspace
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onTryDemo()
                        handleClose()
                      }}
                      className="icon-btn w-full justify-center"
                    >
                      Try Demo
                    </button>
                    <button
                      type="button"
                      onClick={handleClose}
                      className="text-xs text-sec underline hover:text-pri mt-1"
                    >
                      Skip for now
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="mt-5 flex items-center justify-between">
              <span className="text-xs text-ter">Step {slideIdx + 1} of 3</span>
              <div className="flex items-center gap-2">
                {slideIdx > 0 && !isLastSlide && (
                  <button
                    type="button"
                    onClick={() => setSlideIdx((i) => i - 1)}
                    className="icon-btn"
                  >
                    Back
                  </button>
                )}
                {!isLastSlide && (
                  <button
                    type="button"
                    onClick={() => setSlideIdx((i) => i + 1)}
                    className="icon-btn icon-btn--primary"
                  >
                    Next
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  className="text-xs text-ter underline hover:text-sec"
                >
                  Skip
                </button>
              </div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
