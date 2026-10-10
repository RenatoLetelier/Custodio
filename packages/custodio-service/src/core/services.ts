import { DeletionService } from './allocation/deletions.js'
import { DescriptorService } from './allocation/descriptor.js'
import { PlanService } from './allocation/plans.js'
import { ProjectService } from './allocation/projects.js'
import { RecoveryService } from './allocation/reconstruct.js'
import { BackupEngine } from './backup/engine.js'
import { PolicyService } from './backup/policies.js'
import { Scheduler } from './backup/scheduler.js'
import { VerificationService } from './backup/verification.js'
import { InventoryService } from './inventory-health/inventory.js'
import { JobRunner } from './jobs/runner.js'
import { createCore, type CoreDeps } from './shared/context.js'

export function createServices(deps: CoreDeps) {
  const core = createCore(deps)
  const inventory = new InventoryService(core)
  const projects = new ProjectService(core)
  const descriptors = new DescriptorService(core)
  const plans = new PlanService(core, projects, descriptors)
  const deletions = new DeletionService(core, plans)
  const policies = new PolicyService(core, projects, descriptors)
  const engine = new BackupEngine(core, deletions)
  const verifier = new VerificationService(core)
  const recovery = new RecoveryService(core)
  const runner = new JobRunner(core, engine, verifier, {
    // A scan also refreshes volume.json on disks that came back and retries pending deletions
    scan: async () => {
      const result = await inventory.scan()
      const descriptorsRefreshed = await descriptors.syncConnected()
      const deletionsCompleted = await deletions.retryPending()
      return { ...result, descriptorsRefreshed, deletionsCompleted }
    }
  })
  const scheduler = new Scheduler(core, runner, deletions)
  return { core, inventory, projects, descriptors, plans, deletions, policies, engine, verifier, recovery, runner, scheduler }
}

export type Services = ReturnType<typeof createServices>
