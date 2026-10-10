import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { runFile, type CommandResult } from '../adapters/node/exec.js'
import { assertRealAdaptersAllowed } from '../adapters/windows/guard.js'
import { OPERATIONS, type OperationName } from './operations.js'

export interface CommandRunner {
  run(file: string, args: string[]): Promise<CommandResult>
}

// The real runner: only inside the elevated helper, never under tests
export class ExecFileRunner implements CommandRunner {
  run(file: string, args: string[]): Promise<CommandResult> {
    assertRealAdaptersAllowed('custodio-helper')
    return runFile(file, args)
  }
}

export type HelperErrorCode = 'unauthorized' | 'bad_request' | 'unknown_operation' | 'invalid_arguments' | 'confirmation_required' | 'confirmation_invalid' | 'command_failed'

export type HelperResponse =
  | { id: string; ok: true; result: CommandResult | { token: string; expiresAt: string } }
  | { id: string; ok: false; error: { code: HelperErrorCode; message: string } }

const RequestSchema = z.object({
  id: z.string().min(1).max(100),
  secret: z.string(),
  op: z.string(),
  args: z.unknown(),
  confirmation: z.string().optional()
})

const IssueSchema = z.object({ op: z.string(), args: z.unknown() }).strict()

const fingerprint = (op: string, args: unknown): string => createHash('sha256').update(`${op}\n${JSON.stringify(args)}`).digest('hex')

// One-time confirmations for destructive operations: bound to the exact operation and arguments, short-lived
export class ConfirmationBook {
  private readonly tokens = new Map<string, { fingerprint: string; expiresAt: number }>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 2 * 60 * 1000
  ) {}

  issue(op: string, args: unknown): { token: string; expiresAt: string } {
    const token = randomBytes(24).toString('hex')
    const expiresAt = this.now() + this.ttlMs
    this.tokens.set(token, { fingerprint: fingerprint(op, args), expiresAt })
    return { token, expiresAt: new Date(expiresAt).toISOString() }
  }

  redeem(token: string, op: string, args: unknown): boolean {
    const entry = this.tokens.get(token)
    this.tokens.delete(token)
    return entry !== undefined && entry.expiresAt > this.now() && entry.fingerprint === fingerprint(op, args)
  }
}

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// custodio-helper: the only elevated piece. It runs a short whitelist of commands with validated arguments
export class Helper {
  constructor(
    private readonly runner: CommandRunner,
    private readonly secret: string,
    private readonly book: ConfirmationBook = new ConfirmationBook()
  ) {}

  async handle(raw: unknown): Promise<HelperResponse> {
    const parsed = RequestSchema.safeParse(raw)
    const id = parsed.success ? parsed.data.id : '?'
    const fail = (code: HelperErrorCode, message: string): HelperResponse => ({ id, ok: false, error: { code, message } })
    if (!parsed.success) return fail('bad_request', 'Malformed request')
    const request = parsed.data
    if (!sameSecret(request.secret, this.secret)) return fail('unauthorized', 'Invalid helper secret')

    if (request.op === 'confirmation.issue') {
      const issue = IssueSchema.safeParse(request.args)
      if (!issue.success) return fail('invalid_arguments', 'Expected { op, args }')
      const target = OPERATIONS[issue.data.op as OperationName] as (typeof OPERATIONS)[OperationName] | undefined
      if (!target?.requiresConfirmation) return fail('unknown_operation', `${issue.data.op} does not take confirmations`)
      const args = target.args.safeParse(issue.data.args)
      if (!args.success) return fail('invalid_arguments', `Invalid arguments for ${issue.data.op}`)
      return { id, ok: true, result: this.book.issue(issue.data.op, args.data) }
    }

    if (!Object.hasOwn(OPERATIONS, request.op)) return fail('unknown_operation', `${request.op} is not on the whitelist`)
    const operation = OPERATIONS[request.op as OperationName]
    const args = operation.args.safeParse(request.args)
    if (!args.success) return fail('invalid_arguments', `Invalid arguments for ${request.op}`)

    if (operation.requiresConfirmation) {
      if (!request.confirmation) return fail('confirmation_required', `${request.op} needs a one-time confirmation`)
      if (!this.book.redeem(request.confirmation, request.op, args.data)) return fail('confirmation_invalid', 'Confirmation is unknown, expired, already used or for other arguments')
    }

    const command = (operation.command as (a: unknown) => { file: string; args: string[] })(args.data)
    try {
      return { id, ok: true, result: await this.runner.run(command.file, command.args) }
    } catch (error) {
      return fail('command_failed', error instanceof Error ? error.message : String(error))
    }
  }
}
