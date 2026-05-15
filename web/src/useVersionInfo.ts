import { useEffect, useState } from 'react'

import { getVersionInfo, type VersionInfo } from './api.js'

export const useVersionInfo = (provided?: VersionInfo): VersionInfo | null => {
  const [loaded, setLoaded] = useState<VersionInfo | null>(null)

  useEffect(() => {
    if (provided) return
    let alive = true
    getVersionInfo()
      .then((info) => {
        if (alive) setLoaded(info)
      })
      .catch(() => {
        if (alive) setLoaded(null)
      })
    return () => {
      alive = false
    }
  }, [provided])

  return provided ?? loaded
}
