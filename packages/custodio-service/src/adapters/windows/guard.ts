export class RealAdapterBlockedError extends Error {
  constructor(what: string) {
    super(`${what} talks to real disks and is blocked while NODE_ENV=test`)
    this.name = 'RealAdapterBlockedError'
  }
}

// Real hardware adapters refuse to run under tests, whatever machine the tests run on
export function assertRealAdaptersAllowed(what: string): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) throw new RealAdapterBlockedError(what)
}
