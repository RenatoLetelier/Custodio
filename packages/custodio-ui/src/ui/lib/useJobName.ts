import type { Job } from '../api/types'
import { t } from '../i18n'
import { useAppState } from '../state/AppState'

// "Copia «Familia»", "Revisión del disco WD Elements": what a job is, for people
export function useJobName(): (job: Job) => string {
  const { projects, disks } = useAppState()
  const policies = projects.flatMap((p) => p.policies)
  return (job) => {
    const policy = policies.find((p) => p.id === job.policyId)
    if (job.kind === 'backup' && policy) return t(job.dryRun ? 'activity.name.dryRun' : 'activity.name.backup', { name: policy.name })
    if (job.kind === 'verification' && policy) return t('activity.name.verification', { name: policy.name })
    const disk = job.diskId ? disks.find((d) => d.id === job.diskId) : undefined
    if (job.kind === 'repair' && disk) return t('activity.name.repair', { disk: disk.model })
    return t(`jobs.kind.${job.kind}`)
  }
}
