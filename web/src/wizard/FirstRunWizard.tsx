import * as Dialog from '@radix-ui/react-dialog'
import { Hexagon } from 'lucide-react'
import { useState } from 'react'

import { useI18n } from '../i18n.js'

type FirstRunWizardProps = {
  open: boolean
  onClose: (shouldMarkSeen?: boolean) => void
  onAddWorkspace: () => void
  onTryDemo: () => void
}

export const FirstRunWizard = ({
  open,
  onClose,
  onAddWorkspace,
  onTryDemo,
}: FirstRunWizardProps) => {
  const { t } = useI18n()
  const [slideIdx, setSlideIdx] = useState(0)

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setSlideIdx(0)
      onClose()
    }
  }

  const handleClose = (shouldMarkSeen = true) => {
    setSlideIdx(0)
    onClose(shouldMarkSeen)
  }

  const isLastSlide = slideIdx === 2

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            aria-label={t('firstRun.title')}
            className="dialog-scale-pop elev-2 pointer-events-auto w-[480px] max-w-[calc(100vw-32px)] rounded-lg border p-6"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
          >
            <Dialog.Description className="sr-only">
              {t('firstRun.step', { current: slideIdx + 1, total: 3 })}
            </Dialog.Description>

            {/* Slide content */}
            <div className="min-h-[200px]">
              {slideIdx === 0 && (
                <div className="flex flex-col items-center gap-4 py-4 text-center">
                  <div
                    aria-hidden
                    className="flex h-14 w-14 items-center justify-center rounded-lg"
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
                      {t('firstRun.title')}
                    </Dialog.Title>
                    <p className="text-sm text-sec">{t('firstRun.desc')}</p>
                    <p className="text-xs text-ter">{t('firstRun.subtitle')}</p>
                  </div>
                </div>
              )}
              {/* Hidden title for slides 1+ so Radix doesn't warn */}
              {slideIdx > 0 && (
                <Dialog.Title className="sr-only">{t('firstRun.title')}</Dialog.Title>
              )}

              {slideIdx === 1 && (
                <div className="flex flex-col gap-4 py-2">
                  <h2 className="text-lg font-semibold text-pri">{t('firstRun.howItWorks')}</h2>
                  <ol className="flex flex-col gap-3">
                    {[
                      {
                        n: 1,
                        title: t('firstRun.slide1Title'),
                        desc: t('firstRun.slide1Desc'),
                      },
                      {
                        n: 2,
                        title: t('firstRun.slide2Title'),
                        desc: t('firstRun.slide2Desc'),
                      },
                      {
                        n: 3,
                        title: t('firstRun.slide3Title'),
                        desc: t('firstRun.slide3Desc'),
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
                  <h2 className="text-lg font-semibold text-pri">{t('firstRun.getStarted')}</h2>
                  <p className="text-sm text-sec">{t('firstRun.optionDesc')}</p>
                  <div className="mt-2 flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onAddWorkspace()
                        handleClose(false)
                      }}
                      className="icon-btn icon-btn--primary w-full justify-center"
                    >
                      {t('firstRun.addWorkspace')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onTryDemo()
                        handleClose(true)
                      }}
                      className="icon-btn w-full justify-center"
                    >
                      {t('firstRun.tryDemo')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleClose()}
                      className="text-xs text-sec underline hover:text-pri mt-1"
                    >
                      {t('firstRun.skipForNow')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="mt-5 flex items-center justify-between">
              <span className="text-xs text-ter">
                {t('firstRun.step', { current: slideIdx + 1, total: 3 })}
              </span>
              <div className="flex items-center gap-2">
                {slideIdx > 0 && !isLastSlide && (
                  <button
                    type="button"
                    onClick={() => setSlideIdx((i) => i - 1)}
                    className="icon-btn"
                  >
                    {t('firstRun.back')}
                  </button>
                )}
                {!isLastSlide && (
                  <button
                    type="button"
                    onClick={() => setSlideIdx((i) => i + 1)}
                    className="icon-btn icon-btn--primary"
                  >
                    {t('firstRun.next')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleClose()}
                  className="text-xs text-ter underline hover:text-sec"
                >
                  {t('firstRun.skip')}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
