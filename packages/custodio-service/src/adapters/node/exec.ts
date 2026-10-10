import { execFile } from 'node:child_process'

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

// The only way Custodio starts other programs: no shell, arguments as an array, never a command string
export function runFile(file: string, args: readonly string[], options: { timeoutMs?: number; input?: string } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { shell: false, windowsHide: true, timeout: options.timeoutMs ?? 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(new Error(error.message, { cause: error }))
          return
        }
        resolve({ stdout, stderr, exitCode: error ? (error.code as number) : 0 })
      }
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
  })
}
