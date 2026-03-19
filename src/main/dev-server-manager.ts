import { EventEmitter } from 'events'
import { createConnection } from 'net'
import { execSync } from 'child_process'
import { log as _log } from './logger'
import type { DevServer } from '../shared/types'

const POLL_INTERVAL_MS = 3000
const PORT_CHECK_TIMEOUT_MS = 500

function log(msg: string): void {
  _log('DevServerManager', msg)
}

const LOCALHOST_URL_RE = /https?:\/\/(localhost|127\.0\.0\.1):(\d+)/gi

/**
 * Tracks dev servers by polling their ports.
 * Detects localhost URLs from Claude's text output, polls port liveness,
 * and discovers PIDs for the stop button.
 */
export class DevServerManager extends EventEmitter {
  private servers = new Map<string, DevServer>()
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    super()
    this.pollTimer = setInterval(() => this._pollAll(), POLL_INTERVAL_MS)
  }

  /**
   * Scan text for localhost URLs and register any new servers.
   * Returns newly detected servers (skips duplicates by port+tab).
   */
  detectFromText(text: string, tabId: string, command: string | null): DevServer[] {
    const detected: DevServer[] = []
    let match: RegExpExecArray | null

    // Reset regex state
    LOCALHOST_URL_RE.lastIndex = 0
    while ((match = LOCALHOST_URL_RE.exec(text)) !== null) {
      const url = match[0]
      const port = parseInt(match[2], 10)
      if (isNaN(port)) continue

      // Deduplicate by port per tab (skip if already tracked and alive)
      const existing = this._findByPortAndTab(port, tabId)
      if (existing && existing.status !== 'dead') continue

      const server: DevServer = {
        id: crypto.randomUUID(),
        tabId,
        url,
        port,
        status: 'unknown',
        detectedAt: Date.now(),
        pid: null,
        command,
      }

      this.servers.set(server.id, server)
      detected.push(server)
      log(`Detected dev server: ${url} (port ${port}) for tab ${tabId.substring(0, 8)}…`)

      // Immediately check if alive
      this._checkPort(server)
    }

    return detected
  }

  /** Get all tracked servers, optionally filtered by tab. */
  getServers(tabId?: string): DevServer[] {
    const all = Array.from(this.servers.values())
    return tabId ? all.filter((s) => s.tabId === tabId) : all
  }

  /** Stop a dev server by killing its PID. */
  async stopServer(serverId: string): Promise<boolean> {
    const server = this.servers.get(serverId)
    if (!server) return false

    // Try to find PID if we don't have one
    if (!server.pid) {
      server.pid = this._findPid(server.port)
    }

    if (!server.pid) {
      log(`Cannot stop server ${serverId}: no PID found for port ${server.port}`)
      return false
    }

    try {
      process.kill(server.pid, 'SIGTERM')
      log(`Sent SIGTERM to PID ${server.pid} (port ${server.port})`)

      // Give it a moment, then force kill if needed
      setTimeout(() => {
        try {
          process.kill(server.pid!, 0) // Check if still alive
          process.kill(server.pid!, 'SIGKILL')
          log(`Force killed PID ${server.pid} (port ${server.port})`)
        } catch {
          // Already dead — good
        }
      }, 2000)

      server.status = 'dead'
      server.pid = null
      this.emit('status-change', server)
      return true
    } catch (err) {
      log(`Failed to kill PID ${server.pid}: ${err}`)
      return false
    }
  }

  shutdown(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  // ─── Internal ───

  private _findByPortAndTab(port: number, tabId: string): DevServer | undefined {
    for (const s of this.servers.values()) {
      if (s.port === port && s.tabId === tabId) return s
    }
    return undefined
  }

  private async _pollAll(): Promise<void> {
    for (const server of this.servers.values()) {
      await this._checkPort(server)
    }
  }

  private async _checkPort(server: DevServer): Promise<void> {
    const alive = await this._isPortAlive(server.port)
    const oldStatus = server.status

    if (alive) {
      server.status = 'alive'
      // Try to discover PID if we don't have one yet
      if (!server.pid) {
        server.pid = this._findPid(server.port)
      }
    } else {
      server.status = 'dead'
      server.pid = null
    }

    if (oldStatus !== server.status) {
      log(`Server ${server.url} status: ${oldStatus} → ${server.status}`)
      this.emit('status-change', server)
    }
  }

  private _isPortAlive(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ port, host: 'localhost' })
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, PORT_CHECK_TIMEOUT_MS)

      socket.on('connect', () => {
        clearTimeout(timer)
        socket.destroy()
        resolve(true)
      })

      socket.on('error', () => {
        clearTimeout(timer)
        socket.destroy()
        resolve(false)
      })
    })
  }

  private _findPid(port: number): number | null {
    try {
      const out = execSync(`lsof -ti :${port}`, { encoding: 'utf-8', timeout: 2000 })
      const pid = parseInt(out.trim().split('\n')[0], 10)
      return isNaN(pid) ? null : pid
    } catch {
      return null
    }
  }
}
