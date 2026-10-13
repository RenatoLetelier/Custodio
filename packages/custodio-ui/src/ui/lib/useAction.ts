import { useCallback, useRef, useState } from 'react'

// An action started from a button: which one is running (to show it on that button) and what went wrong.
// A second click while one runs is ignored
export function useAction<K extends string = string>() {
  const [pending, setPending] = useState<K | null>(null)
  const [error, setError] = useState<unknown>(null)
  const busyRef = useRef(false)

  const run = useCallback(async (key: K, fn: () => Promise<unknown>): Promise<boolean> => {
    if (busyRef.current) return false
    busyRef.current = true
    setPending(key)
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(e)
      return false
    } finally {
      busyRef.current = false
      setPending(null)
    }
  }, [])

  return { pending, error, setError, run }
}
