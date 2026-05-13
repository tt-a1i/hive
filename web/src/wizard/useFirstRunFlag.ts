import { useCallback, useState } from 'react'

const KEY = 'hive.first-run-seen'

export const useFirstRunFlag = () => {
  const [seen, setSeen] = useState(() => {
    try {
      return window.localStorage.getItem(KEY) === '1'
    } catch {
      return true
    }
  })

  const markSeen = useCallback(() => {
    try {
      window.localStorage.setItem(KEY, '1')
    } catch {}
    setSeen(true)
  }, [])

  return { seen, markSeen }
}
