import { useCallback, useEffect, useRef, useState } from 'react'

import { browseFs, type FsBrowseResponse, type FsProbeResponse, probeFs } from '../api.js'

const EMPTY_BROWSE: FsBrowseResponse = {
  current_path: '',
  entries: [],
  error: null,
  ok: false,
  parent_path: null,
  root_path: '',
}

export const useFsBrowser = (enabled: boolean) => {
  const [browse, setBrowse] = useState<FsBrowseResponse>(EMPTY_BROWSE)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [probe, setProbe] = useState<FsProbeResponse | null>(null)
  const browseTokenRef = useRef(0)
  const probeTokenRef = useRef(0)

  const navigate = useCallback(async (path: string) => {
    const token = ++browseTokenRef.current
    setLoading(true)
    try {
      const result = await browseFs(path)
      if (browseTokenRef.current !== token) return
      setBrowse(result)
      if (result.ok) setSelected(result.current_path)
    } catch {
      // network/abort while the dialog is closing — swallow; the stale-token
      // guard above keeps stale responses from mutating state anyway.
    } finally {
      if (browseTokenRef.current === token) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      browseTokenRef.current++
      probeTokenRef.current++
      setBrowse(EMPTY_BROWSE)
      setSelected(null)
      setProbe(null)
      return
    }
    void navigate('')
  }, [enabled, navigate])

  useEffect(() => {
    if (!selected) {
      setProbe(null)
      return
    }
    const token = ++probeTokenRef.current
    probeFs(selected)
      .then((result) => {
        if (probeTokenRef.current === token) setProbe(result)
      })
      .catch(() => {
        // Same rationale as `navigate`: teardown may abort in-flight probes.
      })
  }, [selected])

  const selectEntry = useCallback((path: string) => {
    setSelected(path)
  }, [])

  return { browse, loading, navigate, probe, selectEntry, selected }
}
