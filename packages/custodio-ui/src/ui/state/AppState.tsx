import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, streamEvents } from '../api/client'
import type { Disk, Job, Overview, ProjectView } from '../api/types'

export type Connection = 'connecting' | 'online' | 'offline'

export interface AppData {
  overview: Overview | null
  disks: Disk[]
  projects: ProjectView[]
  jobs: Job[]
}

interface AppState extends AppData {
  loaded: boolean
  connection: Connection
  error: unknown
  refresh: () => Promise<void>
}

const EMPTY: AppData = { overview: null, disks: [], projects: [], jobs: [] }
const RETRY_MS = 2000

const Context = createContext<AppState | null>(null)

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

function upsertJob(jobs: Job[], job: Job): Job[] {
  const index = jobs.findIndex((j) => j.id === job.id)
  if (index < 0) return [job, ...jobs]
  const next = [...jobs]
  next[index] = job
  return next
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [error, setError] = useState<unknown>(null)
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [overview, disks, projects, jobs] = await Promise.all([
        api<Overview>('GET', '/v1/overview'),
        api<{ disks: Disk[] }>('GET', '/v1/disks'),
        api<{ projects: ProjectView[] }>('GET', '/v1/projects'),
        api<{ jobs: Job[] }>('GET', '/v1/jobs?limit=50')
      ])
      setData({ overview, disks: disks.disks, projects: projects.projects, jobs: jobs.jobs })
      setLoaded(true)
      setConnection('online')
      setError(null)
    } catch (e) {
      setError(e)
      setConnection('offline')
    }
  }, [])

  // Many events arrive together (a scan, a finished copy): one refresh for all of them
  const refreshSoon = useCallback(() => {
    if (pendingRef.current) clearTimeout(pendingRef.current)
    pendingRef.current = setTimeout(() => void refresh(), 150)
  }, [refresh])

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      while (!controller.signal.aborted) {
        await refresh()
        try {
          for await (const message of streamEvents(controller.signal)) {
            setConnection('online')
            if (message.event === 'job.updated') {
              const job = message.data as Job
              setData((current) => ({ ...current, jobs: upsertJob(current.jobs, job) }))
              if (job.status !== 'running') refreshSoon()
            } else {
              refreshSoon()
            }
          }
        } catch (e) {
          if (controller.signal.aborted) return
          setError(e)
        }
        if (controller.signal.aborted) return
        setConnection('offline')
        await pause(RETRY_MS, controller.signal)
      }
    })()
    return () => {
      controller.abort()
      if (pendingRef.current) clearTimeout(pendingRef.current)
    }
  }, [refresh, refreshSoon])

  const value = useMemo<AppState>(() => ({ ...data, loaded, connection, error, refresh }), [data, loaded, connection, error, refresh])
  return <Context value={value}>{children}</Context>
}

export function useAppState(): AppState {
  const state = use(Context)
  if (!state) throw new Error('useAppState outside AppStateProvider')
  return state
}
