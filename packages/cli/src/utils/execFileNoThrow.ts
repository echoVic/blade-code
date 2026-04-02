import { execFile } from 'child_process'

interface ExecFileOptions {
  input?: string
  useCwd?: boolean
  timeout?: number
}

interface ExecFileResult {
  code: number | null
  stdout: string
  stderr: string
}

export function execFileNoThrow(
  file: string,
  args: string[],
  options?: ExecFileOptions,
): Promise<ExecFileResult> {
  return new Promise(resolve => {
    const child = execFile(
      file,
      args,
      { timeout: options?.timeout ?? 5000 },
      (error, stdout, stderr) => {
        let code: number | null = 0
        if (error) {
          const status = (error as { status?: number }).status
          code = typeof status === 'number' ? status : 1
        }
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr),
        })
      },
    )
    if (options?.input && child.stdin) {
      child.stdin.write(options.input)
      child.stdin.end()
    }
  })
}
