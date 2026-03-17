import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Terminal, CaretDown, Check, FolderOpen, Plus, X, ShieldCheck, Warning, Notepad } from '@phosphor-icons/react'
import { useSessionStore, AVAILABLE_MODELS } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'

/* ─── Circular Progress Ring (shared primitive) ─── */

export function CircleProgress({
  size,
  strokeWidth,
  progress,
  color,
  trackColor,
}: {
  size: number
  strokeWidth: number
  progress: number // 0–1
  color: string
  trackColor: string
}) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.min(Math.max(progress, 0), 1))
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke={trackColor} strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke={color} strokeWidth={strokeWidth}
        strokeDasharray={circumference} strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
    </svg>
  )
}

/* ─── Model Picker (inline — tightly coupled to StatusBar) ─── */

function ModelPicker() {
  const preferredModel = useSessionStore((s) => s.preferredModel)
  const setPreferredModel = useSessionStore((s) => s.setPreferredModel)
  const tab = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId),
    (a, b) => a === b || (!!a && !!b && a.status === b.status && a.sessionModel === b.sessionModel),
  )
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  const isBusy = tab?.status === 'running' || tab?.status === 'connecting'

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      left: rect.left,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggle = () => {
    if (isBusy) return
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  const activeLabel = (() => {
    const resolveLabel = (id: string) => {
      const exact = AVAILABLE_MODELS.find((m) => m.id === id)
      if (exact) return exact.label
      // Fallback: match by prefix (e.g. "claude-opus-4-6-somesuffix" → "Opus 4.6")
      const prefix = AVAILABLE_MODELS.find((m) => id.startsWith(m.id))
      if (prefix) return prefix.label
      // Last resort: strip "claude-" prefix and format nicely
      return id.replace(/^claude-/, '').replace(/-/g, ' ')
    }
    if (preferredModel) return resolveLabel(preferredModel)
    if (tab?.sessionModel) return resolveLabel(tab.sessionModel)
    return AVAILABLE_MODELS[0].label
  })()

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 transition-colors"
        style={{
          color: colors.textTertiary,
          cursor: isBusy ? 'not-allowed' : 'pointer',
        }}
        title={isBusy ? 'Stop the task to change model' : 'Switch model'}
      >
        {activeLabel}
        <CaretDown size={10} style={{ opacity: 0.6 }} />
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-clui-ui
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: pos.left,
            width: 192,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          <div className="py-1">
            {AVAILABLE_MODELS.map((m) => {
              const isSelected = preferredModel === m.id || (!preferredModel && m.id === AVAILABLE_MODELS[0].id)
              return (
                <button
                  key={m.id}
                  onClick={() => { setPreferredModel(m.id); setOpen(false) }}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
                  style={{
                    color: isSelected ? colors.textPrimary : colors.textSecondary,
                    fontWeight: isSelected ? 600 : 400,
                  }}
                >
                  {m.label}
                  {isSelected && <Check size={12} style={{ color: colors.accent }} />}
                </button>
              )
            })}
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}

/* ─── Permission Mode Picker (global — affects all tabs) ─── */

function PermissionModePicker() {
  const permissionMode = useSessionStore((s) => s.permissionMode)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const planMode = useSessionStore((s) => s.planMode)
  const setPlanMode = useSessionStore((s) => s.setPlanMode)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      left: rect.left,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggle = () => {
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  const isSkip = !planMode && permissionMode === 'skip'
  const isPlan = planMode

  const triggerIcon = isPlan
    ? <Notepad size={11} weight="fill" style={{ color: '#22c55e' }} />
    : isSkip
      ? <Warning size={11} weight="fill" style={{ color: '#ef4444' }} />
      : <ShieldCheck size={11} weight={permissionMode === 'auto' ? 'fill' : 'regular'} />

  const triggerLabel = isPlan ? 'Plan' : permissionMode === 'ask' ? 'Ask' : permissionMode === 'auto' ? 'Auto' : 'Skip'
  const triggerColor = isPlan ? '#22c55e' : isSkip ? '#ef4444' : colors.textTertiary

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 transition-colors"
        style={{
          color: triggerColor,
          cursor: 'pointer',
        }}
        title="Permission mode (global)"
      >
        {triggerIcon}
        {triggerLabel}
        <CaretDown size={10} style={{ opacity: 0.6 }} />
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-clui-ui
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: pos.left,
            width: 180,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          <div className="py-1">
            <button
              onClick={() => { setPlanMode(true); setOpen(false) }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
              style={{
                color: isPlan ? '#22c55e' : colors.textSecondary,
                fontWeight: isPlan ? 600 : 400,
              }}
            >
              <span className="flex items-center gap-1.5">
                <Notepad size={12} weight="fill" style={{ color: '#22c55e' }} />
                Plan
              </span>
              {isPlan && <Check size={12} style={{ color: '#22c55e' }} />}
            </button>

            <div className="mx-2 my-0.5" style={{ height: 1, background: colors.popoverBorder }} />

            <button
              onClick={() => { setPlanMode(false); setPermissionMode('ask'); setOpen(false) }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
              style={{
                color: !isPlan && permissionMode === 'ask' ? colors.textPrimary : colors.textSecondary,
                fontWeight: !isPlan && permissionMode === 'ask' ? 600 : 400,
              }}
            >
              <span className="flex items-center gap-1.5">
                <ShieldCheck size={12} />
                Ask
              </span>
              {!isPlan && permissionMode === 'ask' && <Check size={12} style={{ color: colors.accent }} />}
            </button>

            <div className="mx-2 my-0.5" style={{ height: 1, background: colors.popoverBorder }} />

            <button
              onClick={() => { setPlanMode(false); setPermissionMode('auto'); setOpen(false) }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
              style={{
                color: !isPlan && permissionMode === 'auto' ? colors.textPrimary : colors.textSecondary,
                fontWeight: !isPlan && permissionMode === 'auto' ? 600 : 400,
              }}
            >
              <span className="flex items-center gap-1.5">
                <ShieldCheck size={12} weight="fill" />
                Auto
              </span>
              {!isPlan && permissionMode === 'auto' && <Check size={12} style={{ color: colors.accent }} />}
            </button>

            <div className="mx-2 my-0.5" style={{ height: 1, background: colors.popoverBorder }} />

            <button
              onClick={() => { setPlanMode(false); setPermissionMode('skip'); setOpen(false) }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
              style={{
                color: !isPlan && permissionMode === 'skip' ? '#ef4444' : colors.textSecondary,
                fontWeight: !isPlan && permissionMode === 'skip' ? 600 : 400,
              }}
            >
              <span className="flex items-center gap-1.5">
                <Warning size={12} weight="fill" style={{ color: '#ef4444' }} />
                Skip
              </span>
              {!isPlan && permissionMode === 'skip' && <Check size={12} style={{ color: '#ef4444' }} />}
            </button>
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}

/* ─── StatusBar ─── */

/** Get a compact display path: basename for deep paths, ~ for home */
function compactPath(fullPath: string): string {
  if (fullPath === '~') return '~'
  const parts = fullPath.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || fullPath
}

export function StatusBar() {
  const tab = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId),
    (a, b) => a === b || (!!a && !!b
      && a.status === b.status
      && a.additionalDirs === b.additionalDirs
      && a.hasChosenDirectory === b.hasChosenDirectory
      && a.workingDirectory === b.workingDirectory
      && a.claudeSessionId === b.claudeSessionId
    ),
  )
  const addDirectory = useSessionStore((s) => s.addDirectory)
  const removeDirectory = useSessionStore((s) => s.removeDirectory)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [dirOpen, setDirOpen] = useState(false)
  const dirRef = useRef<HTMLButtonElement>(null)
  const dirPopRef = useRef<HTMLDivElement>(null)
  const [dirPos, setDirPos] = useState({ bottom: 0, left: 0 })

  // Close popover on outside click
  useEffect(() => {
    if (!dirOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (dirRef.current?.contains(target)) return
      if (dirPopRef.current?.contains(target)) return
      setDirOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dirOpen])

  if (!tab) return null

  const isRunning = tab.status === 'running' || tab.status === 'connecting'
  const isEmpty = tab.messages.length === 0
  const hasExtraDirs = tab.additionalDirs.length > 0

  const handleOpenInTerminal = () => {
    window.clui.openInTerminal(tab.claudeSessionId, tab.workingDirectory)
  }

  const handleDirClick = () => {
    if (isRunning) return
    if (!dirOpen && dirRef.current) {
      const rect = dirRef.current.getBoundingClientRect()
      setDirPos({
        bottom: window.innerHeight - rect.top + 6,
        left: rect.left,
      })
    }
    setDirOpen((o) => !o)
  }

  const handleAddDir = async () => {
    const dir = await window.clui.selectDirectory()
    if (dir) {
      addDirectory(dir)
    }
  }

  const dirTooltip = tab.hasChosenDirectory
    ? [tab.workingDirectory, ...tab.additionalDirs].join('\n')
    : 'Using home directory by default — click to choose a folder'

  return (
    <div
      className="flex items-center justify-between px-4 py-1.5"
      style={{ minHeight: 28 }}
    >
      {/* Left — directory + model picker */}
      <div className="flex items-center gap-2 text-[11px] min-w-0" style={{ color: colors.textTertiary }}>
        {/* Directory button */}
        <button
          ref={dirRef}
          onClick={handleDirClick}
          className="flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors flex-shrink-0"
          style={{
            color: colors.textTertiary,
            cursor: isRunning ? 'not-allowed' : 'pointer',
            maxWidth: 140,
          }}
          title={dirTooltip}
          disabled={isRunning}
        >
          <FolderOpen size={11} className="flex-shrink-0" />
          <span className="truncate">{tab.hasChosenDirectory ? compactPath(tab.workingDirectory) : '—'}</span>
          {hasExtraDirs && (
            <span style={{ color: colors.textTertiary, fontWeight: 600 }}>+{tab.additionalDirs.length}</span>
          )}
        </button>

        {/* Directory popover */}
        {popoverLayer && dirOpen && createPortal(
          <motion.div
            ref={dirPopRef}
            data-clui-ui
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.12 }}
            className="rounded-xl"
            style={{
              position: 'fixed',
              bottom: dirPos.bottom,
              left: dirPos.left,
              width: 220,
              pointerEvents: 'auto',
              background: colors.popoverBg,
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              boxShadow: colors.popoverShadow,
              border: `1px solid ${colors.popoverBorder}`,
            }}
          >
            <div className="py-1.5 px-1">
              {/* Base directory */}
              <div className="px-2 py-1">
                <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: colors.textTertiary }}>
                  Base directory
                </div>
                <div className="text-[11px] truncate" style={{ color: tab.hasChosenDirectory ? colors.textSecondary : colors.textMuted }} title={tab.hasChosenDirectory ? tab.workingDirectory : 'No folder selected — defaults to home directory'}>
                  {tab.hasChosenDirectory ? tab.workingDirectory : 'None (defaults to ~)'}
                </div>
              </div>

              {/* Additional directories */}
              {hasExtraDirs && (
                <>
                  <div className="mx-2 my-1" style={{ height: 1, background: colors.popoverBorder }} />
                  <div className="px-2 py-1">
                    <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: colors.textTertiary }}>
                      Added directories
                    </div>
                    {tab.additionalDirs.map((dir) => (
                      <div key={dir} className="flex items-center justify-between py-0.5 group">
                        <span className="text-[11px] truncate mr-2" style={{ color: colors.textSecondary }} title={dir}>
                          {compactPath(dir)}
                        </span>
                        <button
                          onClick={() => removeDirectory(dir)}
                          className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity"
                          style={{ color: colors.textTertiary }}
                          title="Remove directory"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="mx-2 my-1" style={{ height: 1, background: colors.popoverBorder }} />

              {/* Add directory button */}
              <button
                onClick={handleAddDir}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] transition-colors rounded-lg"
                style={{ color: colors.accent }}
              >
                <Plus size={10} />
                Add directory...
              </button>
            </div>
          </motion.div>,
          popoverLayer,
        )}

        <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>

        <ModelPicker />

        <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>

        <PermissionModePicker />
      </div>

      {/* Right — Open in CLI */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={handleOpenInTerminal}
          className="flex items-center gap-1 text-[11px] rounded-full px-2 py-0.5 transition-colors"
          style={{ color: colors.textTertiary }}
          title="Open this session in Terminal"
        >
          Open in CLI
          <Terminal size={11} />
        </button>
      </div>
    </div>
  )
}
