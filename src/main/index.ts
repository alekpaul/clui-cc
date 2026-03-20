import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Tray, Menu, nativeImage, nativeTheme, shell } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, statSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
import { exec, execFile } from 'child_process'
import { homedir } from 'os'
import { ControlPlane } from './claude/control-plane'
import { launchBrowserInspector } from './browser-inspector'
import { ensureSkills, type SkillStatus } from './skills/installer'
import { fetchCatalog, listInstalled, installPlugin, uninstallPlugin } from './marketplace/catalog'
import { log as _log, LOG_FILE, flushLogs } from './logger'
import { IPC } from '../shared/types'
import type { RunOptions, NormalizedEvent, EnrichedError } from '../shared/types'

const IS_PRODUCTION = !process.env.ELECTRON_RENDERER_URL
const DEBUG_MODE = process.env.CLUI_DEBUG === '1'
const SPACES_DEBUG = DEBUG_MODE || process.env.CLUI_SPACES_DEBUG === '1'

function log(msg: string): void {
  _log('main', msg)
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let screenshotCounter = 0
let toggleSequence = 0

// ─── User-moved window position (resets on relaunch) ───
let userPosition: { x: number; y: number } | null = null

// Feature flag: enable PTY interactive permissions transport
const INTERACTIVE_PTY = process.env.CLUI_INTERACTIVE_PERMISSIONS_PTY === '1'

const controlPlane = new ControlPlane(INTERACTIVE_PTY)

// Window width: compact by default, expanded when expandedUI toggle is on.
const COMPACT_WIDTH = 820
const EXPANDED_WIDTH = 1040
let currentWidth = COMPACT_WIDTH
const PILL_HEIGHT = 720  // Initial height — dynamically resized by renderer via RESIZE_HEIGHT IPC
const PILL_BOTTOM_MARGIN = 24

// ─── Broadcast to renderer ───

function broadcast(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function snapshotWindowState(reason: string): void {
  if (!SPACES_DEBUG) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    log(`[spaces] ${reason} window=none`)
    return
  }

  const b = mainWindow.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const visibleOnAll = mainWindow.isVisibleOnAllWorkspaces()
  const wcFocused = mainWindow.webContents.isFocused()

  log(
    `[spaces] ${reason} ` +
    `vis=${mainWindow.isVisible()} focused=${mainWindow.isFocused()} wcFocused=${wcFocused} ` +
    `alwaysOnTop=${mainWindow.isAlwaysOnTop()} allWs=${visibleOnAll} ` +
    `bounds=(${b.x},${b.y},${b.width}x${b.height}) ` +
    `cursor=(${cursor.x},${cursor.y}) display=${display.id} ` +
    `workArea=(${display.workArea.x},${display.workArea.y},${display.workArea.width}x${display.workArea.height})`
  )
}

function scheduleToggleSnapshots(toggleId: number, phase: 'show' | 'hide'): void {
  if (!SPACES_DEBUG) return
  const probes = [0, 100, 400, 1200]
  for (const delay of probes) {
    setTimeout(() => {
      snapshotWindowState(`toggle#${toggleId} ${phase} +${delay}ms`)
    }, delay)
  }
}


// ─── Finder folder detection (macOS) ───

function detectFinderFolder(): void {
  if (process.platform !== 'darwin') return

  const script = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
end tell
if frontApp is "Finder" then
  tell application "Finder"
    if (count of windows) > 0 then
      -- Prefer a selected folder over the window's current directory
      set sel to selection
      if (count of sel) > 0 then
        set firstItem to item 1 of sel
        if class of firstItem is folder then
          return POSIX path of (firstItem as alias)
        end if
      end if
      set folderTarget to (target of front window) as alias
      return POSIX path of folderTarget
    end if
  end tell
end if
return ""
`

  execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => {
    if (err) {
      log(`Finder folder detection failed: ${err.message}`)
      return
    }
    const folder = stdout.trim()
    if (folder) {
      log(`Finder folder detected: ${folder}`)
      broadcast(IPC.FINDER_FOLDER_DETECTED, folder)
    }
  })
}

// ─── Wire ControlPlane events → renderer ───

controlPlane.on('event', (tabId: string, event: NormalizedEvent) => {
  broadcast('clui:normalized-event', tabId, event)
})

controlPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
  broadcast('clui:tab-status-change', tabId, newStatus, oldStatus)
})

controlPlane.on('error', (tabId: string, error: EnrichedError) => {
  broadcast('clui:enriched-error', tabId, error)
})

// Wire dev server status changes → renderer
controlPlane.devServerManager.on('status-change', (server: import('../shared/types').DevServer) => {
  broadcast(IPC.DEV_SERVER_STATUS, server)
})

// ─── Window Creation ───

function createWindow(): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: screenWidth, height: screenHeight } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea

  const x = dx + Math.round((screenWidth - currentWidth) / 2)
  const y = dy + screenHeight - PILL_HEIGHT - PILL_BOTTOM_MARGIN

  mainWindow = new BrowserWindow({
    width: currentWidth,
    height: PILL_HEIGHT,
    x,
    y,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),  // NSPanel — non-activating, joins all spaces
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    backgroundColor: '#00000000',
    show: false,
    icon: join(__dirname, '../../resources/icon.icns'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Belt-and-suspenders: panel already joins all spaces and floats,
  // but explicit flags ensure correct behavior on older Electron builds.
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.setAlwaysOnTop(true, 'screen-saver')

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    // Enable OS-level click-through for transparent regions.
    // { forward: true } ensures mousemove events still reach the renderer
    // so it can toggle click-through off when cursor enters interactive UI.
    mainWindow?.setIgnoreMouseEvents(true, { forward: true })
    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  // ─── Track user-dragged position & clamp to screen bounds ───
  // Clamp only runs after drag ends (triggered via IPC), not during drag.
  mainWindow.on('moved', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const bounds = mainWindow.getBounds()
    userPosition = { x: bounds.x, y: bounds.y }
  })

  let forceQuit = false
  app.on('before-quit', () => { forceQuit = true })
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function toggleWindow(source = 'unknown'): void {
  if (!mainWindow) return
  const toggleId = ++toggleSequence
  if (SPACES_DEBUG) {
    log(`[spaces] toggle#${toggleId} source=${source} start`)
    snapshotWindowState(`toggle#${toggleId} pre`)
  }

  // Pure toggle: visible → hide, not visible → show. No focus-based branching.
  if (mainWindow.isVisible()) {
    mainWindow.hide()
    if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'hide')
  } else {
    const currentHeight = mainWindow.getBounds().height || PILL_HEIGHT
    if (userPosition) {
      // Restore user-dragged position, keep current height
      mainWindow.setBounds({
        x: userPosition.x,
        y: userPosition.y,
        width: currentWidth,
        height: currentHeight,
      })
    } else {
      // Default: center-bottom on the display where the cursor is
      const cursor = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(cursor)
      const { width: sw, height: sh } = display.workAreaSize
      const { x: dx, y: dy } = display.workArea
      mainWindow.setBounds({
        x: dx + Math.round((sw - currentWidth) / 2),
        y: dy + sh - currentHeight - PILL_BOTTOM_MARGIN,
        width: currentWidth,
        height: currentHeight,
      })
    }
    if (SPACES_DEBUG) {
      log(`[spaces] toggle#${toggleId} move-to-display id=${display.id}`)
      snapshotWindowState(`toggle#${toggleId} pre-show`)
    }
    // Detect Finder folder BEFORE showing — once the window appears,
    // the frontmost app may change and the AppleScript check will miss Finder.
    detectFinderFolder()
    // As an accessory app (app.dock.hide), show() + focus gives keyboard
    // without deactivating the active app — hover preserved everywhere.
    mainWindow.show()
    mainWindow.webContents.focus()
    broadcast(IPC.WINDOW_SHOWN)
    if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'show')
  }
}

// ─── Resize ───
// Dynamic height: renderer reports content height, we resize keeping bottom anchored.

ipcMain.on(IPC.RESIZE_HEIGHT, () => {
  // No-op — fixed height window
})

// Pre-size window before expand animation: grow window, clamp to screen, then resolve.
ipcMain.handle(IPC.PRESIZE_WINDOW, (_e, targetHeight: number) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const bounds = mainWindow.getBounds()
  const h = Math.max(100, Math.round(targetHeight))
  if (!Number.isFinite(h) || h <= bounds.height) return

  try {
    // Grow upward (anchor bottom)
    const deltaH = h - bounds.height
    let newY = bounds.y - deltaH

    // Clamp to screen
    const display = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
    const wa = display.workArea

    // If top goes above work area, push down
    if (newY < wa.y) newY = wa.y
    // If bottom goes below work area, push up
    if (newY + h > wa.y + wa.height) newY = wa.y + wa.height - h
    // Final clamp top
    if (newY < wa.y) newY = wa.y

    mainWindow.setBounds({ x: bounds.x, y: newY, width: bounds.width, height: h })
    userPosition = { x: bounds.x, y: newY }
  } catch (err) {
    log(`PRESIZE_WINDOW error: ${err}`)
  }
})

ipcMain.on(IPC.SET_WINDOW_WIDTH, (_e, wide: boolean) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const newWidth = wide ? EXPANDED_WIDTH : COMPACT_WIDTH
  if (newWidth === currentWidth) return
  currentWidth = newWidth
  const bounds = mainWindow.getBounds()
  // Center the width change
  const deltaW = newWidth - bounds.width
  mainWindow.setBounds({
    x: bounds.x - Math.round(deltaW / 2),
    y: bounds.y,
    width: newWidth,
    height: bounds.height,
  })
})

ipcMain.handle(IPC.ANIMATE_HEIGHT, () => {
  // No-op — kept for API compat, animation handled purely in renderer
})

ipcMain.on(IPC.START_WINDOW_DRAG, (_e, deltaX: number, deltaY: number) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (typeof deltaX !== 'number' || typeof deltaY !== 'number') return
  const [x, y] = mainWindow.getPosition()
  const newX = x + deltaX
  const newY = y + deltaY
  if (!Number.isFinite(newX) || !Number.isFinite(newY)) return
  try {
    mainWindow.setPosition(newX, newY)
  } catch {}
})

ipcMain.on(IPC.DRAG_END, () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const bounds = mainWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
  const wa = display.workArea

  // Clamp so the window stays fully within the work area
  const clamped = {
    x: Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - bounds.width)),
    y: Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - bounds.height)),
  }

  if (clamped.x === bounds.x && clamped.y === bounds.y) {
    userPosition = { x: bounds.x, y: bounds.y }
    return
  }

  // Smooth snap-back to nearest valid point
  const startX = bounds.x
  const startY = bounds.y
  const steps = 8
  let step = 0
  const interval = setInterval(() => {
    step++
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(interval); return }
    const t = step / steps
    const ease = t * (2 - t)
    const newX = Math.round(startX + (clamped.x - startX) * ease)
    const newY = Math.round(startY + (clamped.y - startY) * ease)
    if (!Number.isFinite(newX) || !Number.isFinite(newY)) {
      clearInterval(interval)
      userPosition = { x: clamped.x, y: clamped.y }
      return
    }
    try {
      mainWindow.setPosition(newX, newY)
    } catch {
      clearInterval(interval)
      userPosition = { x: clamped.x, y: clamped.y }
      return
    }
    if (step >= steps) {
      clearInterval(interval)
      userPosition = { x: clamped.x, y: clamped.y }
    }
  }, 15)
})

ipcMain.on(IPC.HIDE_WINDOW, () => {
  mainWindow?.hide()
})

ipcMain.handle(IPC.IS_VISIBLE, () => {
  return mainWindow?.isVisible() ?? false
})

// OS-level click-through toggle — renderer calls this on mousemove
// to enable clicks on interactive UI while passing through transparent areas
ipcMain.on(IPC.SET_IGNORE_MOUSE_EVENTS, (event, ignore: boolean, options?: { forward?: boolean }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore, options || {})
  }
})

// ─── IPC Handlers (typed, strict) ───

ipcMain.handle(IPC.START, async () => {
  log('IPC START — fetching static CLI info')
  const { execSync } = require('child_process')

  // Resolve full path to claude binary — packaged apps have minimal PATH
  const claudeBinCandidates = [
    join(homedir(), '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    join(homedir(), '.npm-global/bin/claude'),
  ]
  let claudeBin = 'claude'
  for (const c of claudeBinCandidates) {
    if (existsSync(c)) { claudeBin = c; break }
  }

  let version = 'unknown'
  try {
    version = execSync(`"${claudeBin}" -v`, { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch {}

  let auth: { email?: string; subscriptionType?: string; authMethod?: string } = {}
  try {
    const raw = execSync(`"${claudeBin}" auth status`, { encoding: 'utf-8', timeout: 5000 }).trim()
    auth = JSON.parse(raw)
  } catch {}

  let mcpServers: string[] = []
  try {
    const raw = execSync(`"${claudeBin}" mcp list`, { encoding: 'utf-8', timeout: 5000 }).trim()
    if (raw) mcpServers = raw.split('\n').filter(Boolean)
  } catch {}

  return { version, auth, mcpServers, projectPath: process.cwd(), homePath: require('os').homedir() }
})

ipcMain.handle(IPC.CREATE_TAB, () => {
  const tabId = controlPlane.createTab()
  log(`IPC CREATE_TAB → ${tabId}`)
  return { tabId }
})

ipcMain.on(IPC.INIT_SESSION, (_event, tabId: string) => {
  log(`IPC INIT_SESSION: ${tabId}`)
  controlPlane.initSession(tabId)
})

ipcMain.on(IPC.RESET_TAB_SESSION, (_event, tabId: string) => {
  log(`IPC RESET_TAB_SESSION: ${tabId}`)
  controlPlane.resetTabSession(tabId)
})

ipcMain.handle(IPC.PROMPT, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  if (DEBUG_MODE) {
    log(`IPC PROMPT: tab=${tabId} req=${requestId} prompt="${options.prompt.substring(0, 100)}"`)
  } else {
    log(`IPC PROMPT: tab=${tabId} req=${requestId}`)
  }

  if (!tabId) {
    throw new Error('No tabId provided — prompt rejected')
  }
  if (!requestId) {
    throw new Error('No requestId provided — prompt rejected')
  }

  try {
    await controlPlane.submitPrompt(tabId, requestId, options)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`PROMPT error: ${msg}`)
    throw err
  }
})

ipcMain.handle(IPC.CANCEL, (_event, requestId: string) => {
  log(`IPC CANCEL: ${requestId}`)
  return controlPlane.cancel(requestId)
})

ipcMain.handle(IPC.STOP_TAB, (_event, tabId: string) => {
  log(`IPC STOP_TAB: ${tabId}`)
  return controlPlane.cancelTab(tabId)
})

ipcMain.handle(IPC.RETRY, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  log(`IPC RETRY: tab=${tabId} req=${requestId}`)
  return controlPlane.retry(tabId, requestId, options)
})

ipcMain.handle(IPC.STATUS, () => {
  return controlPlane.getHealth()
})

ipcMain.handle(IPC.TAB_HEALTH, () => {
  return controlPlane.getHealth()
})

ipcMain.handle(IPC.CLOSE_TAB, (_event, tabId: string) => {
  log(`IPC CLOSE_TAB: ${tabId}`)
  controlPlane.closeTab(tabId)
})

ipcMain.on(IPC.SET_PERMISSION_MODE, (_event, mode: string) => {
  if (mode !== 'ask' && mode !== 'auto' && mode !== 'skip') {
    log(`IPC SET_PERMISSION_MODE: invalid mode "${mode}" — ignoring`)
    return
  }
  log(`IPC SET_PERMISSION_MODE: ${mode}`)
  controlPlane.setPermissionMode(mode)
})

ipcMain.on(IPC.SET_PLAN_MODE, (_event, enabled: boolean) => {
  log(`IPC SET_PLAN_MODE: ${enabled}`)
  controlPlane.setPlanMode(enabled)
})

ipcMain.handle(IPC.RESPOND_PERMISSION, (_event, { tabId, questionId, optionId }: { tabId: string; questionId: string; optionId: string }) => {
  log(`IPC RESPOND_PERMISSION: tab=${tabId} question=${questionId} option=${optionId}`)
  return controlPlane.respondToPermission(tabId, questionId, optionId)
})

ipcMain.handle(IPC.LIST_SESSIONS, async (_e, projectPath?: string) => {
  log(`IPC LIST_SESSIONS ${projectPath ? `(path=${projectPath})` : ''}`)
  try {
    const cwd = projectPath || process.cwd()
    // Claude stores project sessions at ~/.claude/projects/<encoded-path>/
    // Path encoding: replace all '/' with '-' (leading '/' becomes leading '-')
    const encodedPath = cwd.replace(/\//g, '-')
    const sessionsDir = join(homedir(), '.claude', 'projects', encodedPath)
    if (!existsSync(sessionsDir)) {
      log(`LIST_SESSIONS: directory not found: ${sessionsDir}`)
      return []
    }
    const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith('.jsonl'))

    const sessions: Array<{ sessionId: string; slug: string | null; firstMessage: string | null; lastTimestamp: string; size: number }> = []

    // UUID v4 regex — only consider files named as valid UUIDs
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    for (const file of files) {
      // The filename (without .jsonl) IS the canonical resume ID for `claude --resume`
      const fileSessionId = file.replace(/\.jsonl$/, '')
      if (!UUID_RE.test(fileSessionId)) continue // skip non-UUID files

      const filePath = join(sessionsDir, file)
      const stat = statSync(filePath)
      if (stat.size < 100) continue // skip trivially small files

      // Read lines to extract metadata and validate transcript schema
      const meta: { validated: boolean; slug: string | null; firstMessage: string | null; lastTimestamp: string | null } = {
        validated: false, slug: null, firstMessage: null, lastTimestamp: null,
      }

      await new Promise<void>((resolve) => {
        const rl = createInterface({ input: createReadStream(filePath) })
        rl.on('line', (line: string) => {
          try {
            const obj = JSON.parse(line)
            // Validate: must have expected Claude transcript fields
            if (!meta.validated && obj.type && obj.uuid && obj.timestamp) {
              meta.validated = true
            }
            if (obj.slug && !meta.slug) meta.slug = obj.slug
            if (obj.timestamp) meta.lastTimestamp = obj.timestamp
            if (obj.type === 'user' && !meta.firstMessage) {
              const content = obj.message?.content
              if (typeof content === 'string') {
                meta.firstMessage = content.substring(0, 100)
              } else if (Array.isArray(content)) {
                const textPart = content.find((p: any) => p.type === 'text')
                meta.firstMessage = textPart?.text?.substring(0, 100) || null
              }
            }
          } catch {}
          // Read all lines to get the last timestamp
        })
        rl.on('close', () => resolve())
      })

      if (meta.validated) {
        sessions.push({
          sessionId: fileSessionId,
          slug: meta.slug,
          firstMessage: meta.firstMessage,
          lastTimestamp: meta.lastTimestamp || stat.mtime.toISOString(),
          size: stat.size,
        })
      }
    }

    // Sort by last timestamp, most recent first
    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
    return sessions.slice(0, 20) // Return top 20
  } catch (err) {
    log(`LIST_SESSIONS error: ${err}`)
    return []
  }
})

// Load conversation history from a session's JSONL file
ipcMain.handle(IPC.LOAD_SESSION, async (_e, arg: { sessionId: string; projectPath?: string } | string) => {
  const sessionId = typeof arg === 'string' ? arg : arg.sessionId
  const projectPath = typeof arg === 'string' ? undefined : arg.projectPath
  log(`IPC LOAD_SESSION ${sessionId}${projectPath ? ` (path=${projectPath})` : ''}`)
  try {
    const cwd = projectPath || process.cwd()
    const encodedPath = cwd.replace(/\//g, '-')
    const filePath = join(homedir(), '.claude', 'projects', encodedPath, `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return []

    const messages: Array<{ role: string; content: string; toolName?: string; timestamp: number }> = []
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(filePath) })
      rl.on('line', (line: string) => {
        try {
          const obj = JSON.parse(line)
          if (obj.type === 'user') {
            const content = obj.message?.content
            let text = ''
            if (typeof content === 'string') {
              text = content
            } else if (Array.isArray(content)) {
              text = content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n')
            }
            if (text) {
              messages.push({ role: 'user', content: text, timestamp: new Date(obj.timestamp).getTime() })
            }
          } else if (obj.type === 'assistant') {
            const content = obj.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  messages.push({ role: 'assistant', content: block.text, timestamp: new Date(obj.timestamp).getTime() })
                } else if (block.type === 'tool_use' && block.name) {
                  messages.push({
                    role: 'tool',
                    content: '',
                    toolName: block.name,
                    timestamp: new Date(obj.timestamp).getTime(),
                  })
                }
              }
            }
          }
        } catch {}
      })
      rl.on('close', () => resolve())
    })
    return messages
  } catch (err) {
    log(`LOAD_SESSION error: ${err}`)
    return []
  }
})

ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
  if (!mainWindow) return null
  // macOS: activate app so unparented dialog appears on top (not behind other apps).
  // Unparented avoids modal dimming on the transparent overlay.
  // Activation is fine here — user is actively interacting with CLUI.
  if (process.platform === 'darwin') app.focus()
  const options = { properties: ['openDirectory'] as const }
  const result = process.platform === 'darwin'
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options)
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
  try {
    // Only allow http(s) links from markdown content.
    if (!/^https?:\/\//i.test(url)) return false
    await shell.openExternal(url)
    return true
  } catch {
    return false
  }
})

ipcMain.handle(IPC.INSPECT_ELEMENT, async (_event, url: string) => {
  if (!url || typeof url !== 'string') return null
  log(`IPC INSPECT_ELEMENT: ${url}`)
  try {
    return await launchBrowserInspector(url, (result) => {
      broadcast(IPC.ELEMENT_SELECTED, result)
    })
  } catch (err: unknown) {
    log(`INSPECT_ELEMENT error: ${err}`)
    return null
  }
})

ipcMain.handle(IPC.STOP_DEV_SERVER, async (_event, serverId: string) => {
  return controlPlane.devServerManager.stopServer(serverId)
})

ipcMain.handle(IPC.ATTACH_FILES, async () => {
  if (!mainWindow) return null
  // macOS: activate app so unparented dialog appears on top
  if (process.platform === 'darwin') app.focus()
  const options = {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
      { name: 'Code', extensions: ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'md', 'json', 'yaml', 'toml'] },
    ],
  }
  const result = process.platform === 'darwin'
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options)
  if (result.canceled || result.filePaths.length === 0) return null

  const { basename, extname } = require('path')
  const { readFileSync, statSync } = require('fs')

  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.yaml': 'text/yaml', '.toml': 'text/toml',
  }

  return result.filePaths.map((fp: string) => {
    const ext = extname(fp).toLowerCase()
    const mime = mimeMap[ext] || 'application/octet-stream'
    const stat = statSync(fp)
    let dataUrl: string | undefined

    // Generate preview data URL for images (max 2MB to keep IPC fast)
    if (IMAGE_EXTS.has(ext) && stat.size < 2 * 1024 * 1024) {
      try {
        const buf = readFileSync(fp)
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      } catch {}
    }

    return {
      id: crypto.randomUUID(),
      type: IMAGE_EXTS.has(ext) ? 'image' : 'file',
      name: basename(fp),
      path: fp,
      mimeType: mime,
      dataUrl,
      size: stat.size,
    }
  })
})

ipcMain.handle(IPC.TAKE_SCREENSHOT, async () => {
  if (!mainWindow) return null

  if (SPACES_DEBUG) snapshotWindowState('screenshot pre-hide')
  mainWindow.hide()
  await new Promise((r) => setTimeout(r, 300))

  try {
    const { execSync } = require('child_process')
    const { join } = require('path')
    const { tmpdir } = require('os')
    const { readFileSync, existsSync } = require('fs')

    const timestamp = Date.now()
    const screenshotPath = join(tmpdir(), `clui-screenshot-${timestamp}.png`)

    execSync(`/usr/sbin/screencapture -i "${screenshotPath}"`, {
      timeout: 30000,
      stdio: 'ignore',
    })

    if (!existsSync(screenshotPath)) {
      return null
    }

    // Return structured attachment with data URL preview
    const buf = readFileSync(screenshotPath)
    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: `screenshot ${++screenshotCounter}.png`,
      path: screenshotPath,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      size: buf.length,
    }
  } catch {
    return null
  } finally {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.webContents.focus()
    }
    broadcast(IPC.WINDOW_SHOWN)
    if (SPACES_DEBUG) {
      log('[spaces] screenshot restore show+focus')
      snapshotWindowState('screenshot restore immediate')
      setTimeout(() => snapshotWindowState('screenshot restore +200ms'), 200)
    }
  }
})

let pasteCounter = 0
ipcMain.handle(IPC.PASTE_IMAGE, async (_event, dataUrl: string) => {
  try {
    const { writeFileSync } = require('fs')
    const { join } = require('path')
    const { tmpdir } = require('os')

    // Parse data URL: "data:image/png;base64,..."
    const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/)
    if (!match) return null

    const [, mimeType, ext, base64Data] = match
    const buf = Buffer.from(base64Data, 'base64')
    const timestamp = Date.now()
    const filePath = join(tmpdir(), `clui-paste-${timestamp}.${ext}`)
    writeFileSync(filePath, buf)

    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: `pasted image ${++pasteCounter}.${ext}`,
      path: filePath,
      mimeType,
      dataUrl,
      size: buf.length,
    }
  } catch {
    return null
  }
})

ipcMain.handle(IPC.TRANSCRIBE_AUDIO, async (_event, audioBase64: string) => {
  const { writeFileSync, existsSync, unlinkSync, readFileSync } = require('fs')
  const { execSync } = require('child_process')
  const { join } = require('path')
  const { tmpdir } = require('os')

  const tmpWav = join(tmpdir(), `clui-voice-${Date.now()}.wav`)
  try {
    const buf = Buffer.from(audioBase64, 'base64')
    writeFileSync(tmpWav, buf)

    // Find whisper-cli (whisper-cpp homebrew) or whisper (python)
    const candidates = [
      '/opt/homebrew/bin/whisper-cli',
      '/usr/local/bin/whisper-cli',
      '/opt/homebrew/bin/whisper',
      '/usr/local/bin/whisper',
      join(homedir(), '.local/bin/whisper'),
    ]

    let whisperBin = ''
    for (const c of candidates) {
      if (existsSync(c)) { whisperBin = c; break }
    }

    if (!whisperBin) {
      try {
        whisperBin = execSync('/bin/zsh -lc "whence -p whisper-cli"', { encoding: 'utf-8' }).trim()
      } catch {}
    }
    if (!whisperBin) {
      try {
        whisperBin = execSync('/bin/zsh -lc "whence -p whisper"', { encoding: 'utf-8' }).trim()
      } catch {}
    }

    if (!whisperBin) {
      return {
        error: 'Whisper not found. Install with: brew install whisper-cpp',
        transcript: null,
      }
    }

    const isWhisperCpp = whisperBin.includes('whisper-cli')

    // Find model file — prefer multilingual (auto-detect language) over .en (English-only)
    const modelCandidates = [
      join(homedir(), '.local/share/whisper/ggml-tiny.bin'),
      join(homedir(), '.local/share/whisper/ggml-base.bin'),
      '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.bin',
      '/opt/homebrew/share/whisper-cpp/models/ggml-base.bin',
      // Fall back to English-only models if multilingual not available
      join(homedir(), '.local/share/whisper/ggml-tiny.en.bin'),
      join(homedir(), '.local/share/whisper/ggml-base.en.bin'),
      '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.en.bin',
      '/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin',
    ]

    let modelPath = ''
    for (const m of modelCandidates) {
      if (existsSync(m)) { modelPath = m; break }
    }

    // Detect if using an English-only model (.en suffix) — force English if so
    const isEnglishOnly = modelPath.includes('.en.')
    log(`Transcribing with: ${whisperBin} (model: ${modelPath || 'default'}, lang: ${isEnglishOnly ? 'en' : 'auto'})`)

    let output: string
    if (isWhisperCpp) {
      // whisper-cpp: whisper-cli -m model -f file --no-timestamps
      if (!modelPath) {
        return {
          error: 'Whisper model not found. Download with:\nmkdir -p ~/.local/share/whisper && curl -L -o ~/.local/share/whisper/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
          transcript: null,
        }
      }
      const langFlag = isEnglishOnly ? '-l en' : '-l auto'
      output = execSync(
        `"${whisperBin}" -m "${modelPath}" -f "${tmpWav}" --no-timestamps ${langFlag}`,
        { encoding: 'utf-8', timeout: 30000 }
      )
    } else {
      // Python whisper: auto-detect language unless English-only model
      const langFlag = isEnglishOnly ? '--language en' : ''
      output = execSync(
        `"${whisperBin}" "${tmpWav}" --model tiny ${langFlag} --output_format txt --output_dir "${tmpdir()}"`,
        { encoding: 'utf-8', timeout: 30000 }
      )
      // Python whisper writes .txt file
      const txtPath = tmpWav.replace('.wav', '.txt')
      if (existsSync(txtPath)) {
        const transcript = readFileSync(txtPath, 'utf-8').trim()
        try { unlinkSync(txtPath) } catch {}
        return { error: null, transcript }
      }
    }

    // whisper-cpp prints to stdout directly
    // Strip any leading [timestamp] patterns and whitespace
    const transcript = output
      .replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/g, '')
      .trim()

    return { error: null, transcript: transcript || '' }
  } catch (err: any) {
    log(`Transcription error: ${err.message}`)
    return {
      error: `Transcription failed: ${err.message}`,
      transcript: null,
    }
  } finally {
    try { unlinkSync(tmpWav) } catch {}
  }
})

ipcMain.handle(IPC.GET_DIAGNOSTICS, () => {
  const { readFileSync, existsSync } = require('fs')
  const health = controlPlane.getHealth()

  let recentLogs = ''
  if (existsSync(LOG_FILE)) {
    try {
      const content = readFileSync(LOG_FILE, 'utf-8')
      const lines = content.split('\n')
      recentLogs = lines.slice(-100).join('\n')
    } catch {}
  }

  return {
    health,
    logPath: LOG_FILE,
    recentLogs,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    appVersion: app.getVersion(),
    transport: INTERACTIVE_PTY ? 'pty' : 'stream-json',
  }
})

ipcMain.handle(IPC.OPEN_IN_TERMINAL, (_event, arg: string | null | { sessionId?: string | null; projectPath?: string }) => {
  const { execFile } = require('child_process')
  const claudeBin = 'claude'

  // Support both old (string) and new ({ sessionId, projectPath }) calling convention
  let sessionId: string | null = null
  let projectPath: string = process.cwd()
  if (typeof arg === 'string') {
    sessionId = arg
  } else if (arg && typeof arg === 'object') {
    sessionId = arg.sessionId ?? null
    projectPath = arg.projectPath && arg.projectPath !== '~' ? arg.projectPath : process.cwd()
  }

  // Escape for AppleScript: double quotes → backslash-escaped, backslashes doubled
  const projectDir = projectPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  let cmd: string
  if (sessionId) {
    cmd = `cd \\"${projectDir}\\" && ${claudeBin} --resume ${sessionId}`
  } else {
    cmd = `cd \\"${projectDir}\\" && ${claudeBin}`
  }

  const script = `tell application "Terminal"
  activate
  do script "${cmd}"
end tell`

  try {
    execFile('/usr/bin/osascript', ['-e', script], (err: Error | null) => {
      if (err) log(`Failed to open terminal: ${err.message}`)
      else log(`Opened terminal with: ${cmd}`)
    })
    return true
  } catch (err: unknown) {
    log(`Failed to open terminal: ${err}`)
    return false
  }
})

// ─── Marketplace IPC ───

ipcMain.handle(IPC.MARKETPLACE_FETCH, async (_event, { forceRefresh } = {}) => {
  log('IPC MARKETPLACE_FETCH')
  return fetchCatalog(forceRefresh)
})

ipcMain.handle(IPC.MARKETPLACE_INSTALLED, async () => {
  log('IPC MARKETPLACE_INSTALLED')
  return listInstalled()
})

ipcMain.handle(IPC.MARKETPLACE_INSTALL, async (_event, { repo, pluginName, marketplace, sourcePath, isSkillMd }: { repo: string; pluginName: string; marketplace: string; sourcePath?: string; isSkillMd?: boolean }) => {
  log(`IPC MARKETPLACE_INSTALL: ${pluginName} from ${repo} (isSkillMd=${isSkillMd})`)
  return installPlugin(repo, pluginName, marketplace, sourcePath, isSkillMd)
})

ipcMain.handle(IPC.MARKETPLACE_UNINSTALL, async (_event, { pluginName }: { pluginName: string }) => {
  log(`IPC MARKETPLACE_UNINSTALL: ${pluginName}`)
  return uninstallPlugin(pluginName)
})

// ─── Theme Detection ───

ipcMain.handle(IPC.GET_THEME, () => {
  return { isDark: nativeTheme.shouldUseDarkColors }
})

nativeTheme.on('updated', () => {
  broadcast(IPC.THEME_CHANGED, nativeTheme.shouldUseDarkColors)
})

// ─── Dependency Provisioning ───

function ensureDependencies(): void {
  // Delay to let the renderer mount and subscribe to IPC events
  setTimeout(() => ensureDependenciesImpl(), 3000)
}

function ensureDependenciesImpl(): void {
  // Check if whisper-cli binary exists at known paths
  const whisperCandidates = [
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
    '/opt/homebrew/bin/whisper',
    '/usr/local/bin/whisper',
    join(homedir(), '.local/bin/whisper'),
  ]

  const whisperExists = whisperCandidates.some((c: string) => existsSync(c))
  if (whisperExists) {
    log('Whisper binary found — skipping install')
    ensureWhisperModel()
    return
  }

  // Shell lookup (async to avoid EPIPE in Electron main process)
  exec(
    '/bin/zsh -lc "whence -p whisper-cli 2>/dev/null || whence -p whisper 2>/dev/null"',
    { encoding: 'utf-8', timeout: 5000 },
    (lookupErr, stdout) => {
      const found = (stdout || '').trim()
      if (!lookupErr && found) {
        log(`Whisper found via shell: ${found}`)
        ensureWhisperModel()
        return
      }

      log('Whisper not found — starting auto-install via brew')
      broadcast(IPC.DEP_STATUS, { name: 'whisper-cpp', state: 'installing' })

      exec(
        '/bin/zsh -lc "brew install whisper-cpp"',
        { timeout: 300000 },
        (err: Error | null, _stdout: string, stderr: string) => {
          if (err) {
            log(`Whisper install failed: ${err.message}`)
            broadcast(IPC.DEP_STATUS, {
              name: 'whisper-cpp',
              state: 'failed',
              error: stderr?.split('\n').filter(Boolean).pop() || err.message,
            })
            return
          }

          log('Whisper installed successfully')
          broadcast(IPC.DEP_STATUS, { name: 'whisper-cpp', state: 'installed' })

          // Also ensure a model file exists
          ensureWhisperModel()
        },
      )
    },
  )
}

function ensureWhisperModel(): void {
  const modelCandidates = [
    join(homedir(), '.local/share/whisper/ggml-tiny.bin'),
    join(homedir(), '.local/share/whisper/ggml-base.bin'),
    '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.bin',
    '/opt/homebrew/share/whisper-cpp/models/ggml-base.bin',
    join(homedir(), '.local/share/whisper/ggml-tiny.en.bin'),
    join(homedir(), '.local/share/whisper/ggml-base.en.bin'),
    '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.en.bin',
    '/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin',
  ]

  if (modelCandidates.some((m: string) => existsSync(m))) {
    log('Whisper model found — skipping download')
    return
  }

  const modelDir = join(homedir(), '.local/share/whisper')
  const modelPath = join(modelDir, 'ggml-tiny.bin')
  const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'

  log('Whisper model not found — downloading ggml-tiny.bin')
  broadcast(IPC.DEP_STATUS, { name: 'whisper-model', state: 'installing' })

  exec(
    `mkdir -p "${modelDir}" && curl -L -o "${modelPath}" "${modelUrl}"`,
    { timeout: 120000 },
    (err: Error | null) => {
      if (err) {
        log(`Whisper model download failed: ${err.message}`)
        broadcast(IPC.DEP_STATUS, {
          name: 'whisper-model',
          state: 'failed',
          error: err.message,
        })
        return
      }
      log('Whisper model downloaded successfully')
      broadcast(IPC.DEP_STATUS, { name: 'whisper-model', state: 'installed' })
    },
  )
}

// ─── App Lifecycle ───

app.whenReady().then(() => {
  // macOS: become an accessory app. Accessory apps can have key windows (keyboard works)
  // without deactivating the currently active app (hover preserved in browsers).
  // This is how Spotlight, Alfred, Raycast work.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide()
  }

  // Skill provisioning — non-blocking, streams status to renderer
  ensureSkills((status: SkillStatus) => {
    log(`Skill ${status.name}: ${status.state}${status.error ? ` — ${status.error}` : ''}`)
    broadcast(IPC.SKILL_STATUS, status)
  }).catch((err: Error) => log(`Skill provisioning error: ${err.message}`))

  createWindow()

  // Dependency provisioning — auto-install whisper-cpp if missing (deferred to let renderer mount)
  ensureDependencies()
  snapshotWindowState('after createWindow')

  if (SPACES_DEBUG) {
    mainWindow?.on('show', () => snapshotWindowState('event window show'))
    mainWindow?.on('hide', () => snapshotWindowState('event window hide'))
    mainWindow?.on('focus', () => snapshotWindowState('event window focus'))
    mainWindow?.on('blur', () => snapshotWindowState('event window blur'))
    mainWindow?.webContents.on('focus', () => snapshotWindowState('event webContents focus'))
    mainWindow?.webContents.on('blur', () => snapshotWindowState('event webContents blur'))

    app.on('browser-window-focus', () => snapshotWindowState('event app browser-window-focus'))
    app.on('browser-window-blur', () => snapshotWindowState('event app browser-window-blur'))

    screen.on('display-added', (_e, display) => {
      log(`[spaces] event display-added id=${display.id}`)
      snapshotWindowState('event display-added')
    })
    screen.on('display-removed', (_e, display) => {
      log(`[spaces] event display-removed id=${display.id}`)
      snapshotWindowState('event display-removed')
    })
    screen.on('display-metrics-changed', (_e, display, changedMetrics) => {
      log(`[spaces] event display-metrics-changed id=${display.id} changed=${changedMetrics.join(',')}`)
      snapshotWindowState('event display-metrics-changed')
    })
  }


  // Primary: Option+Space (2 keys, doesn't conflict with shell)
  // Fallback: Cmd+Shift+K kept as secondary shortcut
  const registered = globalShortcut.register('Alt+Space', () => toggleWindow('shortcut Alt+Space'))
  if (!registered) {
    log('Alt+Space shortcut registration failed — another app may have claimed it')
  }
  globalShortcut.register('CommandOrControl+Shift+K', () => toggleWindow('shortcut Cmd/Ctrl+Shift+K'))

  const trayIconPath = join(__dirname, '../../resources/trayTemplate.png')
  const trayIcon = nativeImage.createFromPath(trayIconPath)
  trayIcon.setTemplateImage(true)
  tray = new Tray(trayIcon)
  tray.setToolTip('Clui CC — Claude Code UI')
  tray.on('click', () => toggleWindow('tray click'))
  // Auto-start: enable login item in production builds
  if (IS_PRODUCTION) {
    const loginSettings = app.getLoginItemSettings()
    if (!loginSettings.openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true })
      log('Auto-start enabled (first launch)')
    }
  }

  const buildTrayMenu = () => {
    const loginEnabled = app.getLoginItemSettings().openAtLogin
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Clui CC', click: () => toggleWindow('tray menu Show Clui CC') },
        { type: 'separator' },
        {
          label: 'Launch at Login',
          type: 'checkbox',
          checked: loginEnabled,
          click: () => {
            app.setLoginItemSettings({ openAtLogin: !loginEnabled })
            log(`Auto-start ${!loginEnabled ? 'enabled' : 'disabled'} via tray menu`)
            buildTrayMenu()
          },
        },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.quit() } },
      ])
    )
  }
  buildTrayMenu()

  app.on('activate', () => toggleWindow('app activate'))
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  controlPlane.shutdown()
  flushLogs()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
