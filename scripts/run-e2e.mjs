/* global fetch, process, setTimeout */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const root = process.cwd()
const port = process.env.PLAYWRIGHT_PORT ?? '4173'
const url = `http://127.0.0.1:${port}`
const vite = resolve(root, 'node_modules/vite/bin/vite.js')
const playwright = resolve(root, 'node_modules/@playwright/test/cli.js')

async function isReady() {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

async function waitForServer(server) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await isReady()) return
    if (server.exitCode !== null) throw new Error(`Vite exited with code ${server.exitCode}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
}

let server
let ownsServer = false

try {
  if (!(await isReady())) {
    server = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', port], {
      cwd: root,
      stdio: 'inherit',
    })
    ownsServer = true
    await waitForServer(server)
  }

  const tests = spawn(process.execPath, [playwright, 'test', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
  })
  const result = await waitForExit(tests)
  process.exitCode = result.code ?? 1
} finally {
  if (ownsServer && server && server.exitCode === null) {
    server.kill()
    await Promise.race([
      waitForExit(server),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
    ])
  }
}
