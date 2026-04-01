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
        resolve({
          code: error ? (error as NodeJS.ErrnoException & { code?: number }).code as unknown as number ?? 1 : 0,
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
