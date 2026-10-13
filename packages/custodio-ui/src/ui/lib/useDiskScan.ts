import { useState } from 'react'
import { api } from '../api/client'
import type { Job } from '../api/types'
import { useAppState } from '../state/AppState'
import { JobFailed } from './errors'
import { isActive } from './jobs'
import { useAction } from './useAction'

// "Buscar discos" waits for the search to end, then says so; a search Custodio started on its own counts too
export function useDiskScan() {
  const { jobs, track, waitFor, refresh } = useAppState()
  const { pending, error, run } = useAction()
  const [done, setDone] = useState(false)
  const automatic = jobs.some((j) => j.kind === 'inventory_scan' && isActive(j))

  const scan = () =>
    run('scan', async () => {
      setDone(false)
      const { job } = await api<{ job: Job }>('POST', '/v1/disks/scan')
      track(job)
      const ended = await waitFor(job.id)
      await refresh()
      if (ended.status !== 'succeeded') throw new JobFailed(ended)
      setDone(true)
    })

  return { scanning: pending !== null || automatic, done: done && pending === null, error, scan }
}
