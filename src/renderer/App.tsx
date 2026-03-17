import React, { useEffect, useCallback, useRef, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Paperclip, Camera, HeadCircuit } from '@phosphor-icons/react'
import { TabStrip } from './components/TabStrip'
import { ConversationView } from './components/ConversationView'
import { InputBar } from './components/InputBar'
import { StatusBar, CircleProgress } from './components/StatusBar'
import { MarketplacePanel } from './components/MarketplacePanel'
import { PopoverLayerProvider, usePopoverLayer } from './components/PopoverLayer'
import { useClaudeEvents } from './hooks/useClaudeEvents'
import { useHealthReconciliation } from './hooks/useHealthReconciliation'
import { useSessionStore } from './stores/sessionStore'
import { useColors, useThemeStore, spacing } from './theme'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

/** Format a timestamp to "Resets Fri 11:00 AM" */
function formatResetDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const day = d.toLocaleDateString('en-US', { weekday: 'short' })
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  if (d.toDateString() === now.toDateString()) return `Resets ${time}`
  return `Resets ${day} ${time}`
}

/** Format ms to compact remaining string */
function formatTimeLeft(ms: number): string {
  if (ms <= 0) return 'now'
  const totalSec = Math.ceil(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}

/* ─── Usage Limit Circle (right of input, mirrors left attachment circles) ─── */

function UsageLimitCircle() {
  const usage = useSessionStore((s) => s.usageTracking)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [hovered, setHovered] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  // Tick every second while hovered so countdowns stay live
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!hovered) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [hovered])

  const now = Date.now()

  // ─── Current session ───
  // Based on actual tokens used. When rate limited we know we hit 100%.
  // Otherwise estimate against a reasonable per-session cap.
  const shortLimited = usage.shortTermLimit && usage.shortTermLimit.resetsAt > now
  const shortPct = shortLimited
    ? 100
    : usage.totalOutputTokens > 0
      ? Math.min(Math.round((usage.totalOutputTokens / 80_000) * 100), 99)
      : 0
  const shortProgress = shortPct / 100

  // ─── All models ───
  // Based on tokens in the rolling 4h window. Calibrates when rate limited.
  const longLimited = usage.longTermLimit && usage.longTermLimit.resetsAt > now
  const fourHrTokens = useMemo(() => {
    const cutoff = now - 4 * 60 * 60 * 1000
    return usage.usageHistory
      .filter((h) => h.timestamp > cutoff)
      .reduce((sum, h) => sum + h.outputTokens, 0)
  }, [usage.usageHistory, now])
  const longPct = longLimited
    ? 100
    : fourHrTokens > 0
      ? Math.min(Math.round((fourHrTokens / 500_000) * 100), 99)
      : 0
  const longProgress = longPct / 100

  // Main circle — show whichever is higher
  const mainPct = Math.max(shortPct, longPct)
  const mainProgress = mainPct / 100
  const mainColor = shortLimited ? '#ef4444' : longLimited ? '#f59e0b'
    : mainPct >= 80 ? '#f59e0b' : mainPct > 0 ? '#3b82f6' : colors.textMuted + '88'
  const shortColor = shortLimited ? '#ef4444' : shortPct >= 80 ? '#f59e0b' : '#3b82f6'
  const longColor = longLimited ? '#ef4444' : longPct >= 80 ? '#f59e0b' : '#3b82f6'

  const handleEnter = () => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setPos({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left + rect.width / 2 - 115,
      })
    }
    setHovered(true)
  }

  return (
    <>
      <button
        ref={btnRef}
        data-clui-ui
        className="glass-surface"
        onMouseEnter={handleEnter}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: 46,
          height: 46,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'default',
          border: 'none',
          padding: 0,
          position: 'relative',
        }}
        title="Usage limits"
      >
        <CircleProgress
          size={34} strokeWidth={3}
          progress={mainProgress}
          color={mainColor}
          trackColor={colors.textMuted + '33'}
        />
        <div
          className="absolute inset-0 flex items-center justify-center font-semibold"
          style={{ color: mainColor, fontSize: 9, letterSpacing: -0.3 }}
        >
          {mainPct}%
        </div>
      </button>

      {/* Hover popover — both limits with larger rings */}
      {popoverLayer && hovered && createPortal(
        <motion.div
          data-clui-ui
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.14 }}
          className="rounded-2xl"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: pos.left,
            width: 230,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          <div className="p-3 flex flex-col gap-3">
            {/* Current session */}
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0 relative" style={{ width: 44, height: 44 }}>
                <CircleProgress
                  size={44} strokeWidth={3.5}
                  progress={shortProgress}
                  color={shortColor}
                  trackColor={colors.textMuted + '22'}
                />
                <div
                  className="absolute inset-0 flex items-center justify-center font-semibold"
                  style={{ color: shortColor, fontSize: 10, letterSpacing: -0.3 }}
                >
                  {shortPct}%
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-semibold" style={{ color: colors.textPrimary }}>
                  Current session
                </div>
                <div className="text-[9px]" style={{ color: colors.textTertiary }}>
                  {shortLimited
                    ? formatResetDate(usage.shortTermLimit!.resetsAt)
                    : `${(usage.totalOutputTokens / 1000).toFixed(1)}k tokens used`}
                </div>
              </div>
            </div>

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* All models */}
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0 relative" style={{ width: 44, height: 44 }}>
                <CircleProgress
                  size={44} strokeWidth={3.5}
                  progress={longProgress}
                  color={longColor}
                  trackColor={colors.textMuted + '22'}
                />
                <div
                  className="absolute inset-0 flex items-center justify-center font-semibold"
                  style={{ color: longColor, fontSize: 10, letterSpacing: -0.3 }}
                >
                  {longPct}%
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-semibold" style={{ color: colors.textPrimary }}>
                  All models
                </div>
                <div className="text-[9px]" style={{ color: colors.textTertiary }}>
                  {longLimited
                    ? formatResetDate(usage.longTermLimit!.resetsAt)
                    : `${(fourHrTokens / 1000).toFixed(1)}k tokens (4h window)`}
                </div>
              </div>
            </div>

            {/* Cost summary */}
            {usage.totalCostUsd > 0 && (
              <>
                <div style={{ height: 1, background: colors.popoverBorder }} />
                <div className="text-[9px] text-center" style={{ color: colors.textTertiary }}>
                  ${usage.totalCostUsd.toFixed(4)} · {((usage.totalInputTokens + usage.totalOutputTokens) / 1000).toFixed(1)}k tokens
                </div>
              </>
            )}
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}

export default function App() {
  useClaudeEvents()
  useHealthReconciliation()

  const activeTabStatus = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.status)
  const addAttachments = useSessionStore((s) => s.addAttachments)
  const colors = useColors()
  const setSystemTheme = useThemeStore((s) => s.setSystemTheme)
  const expandedUI = useThemeStore((s) => s.expandedUI)

  // ─── Theme initialization ───
  useEffect(() => {
    // Get initial OS theme — setSystemTheme respects themeMode (system/light/dark)
    window.clui.getTheme().then(({ isDark }) => {
      setSystemTheme(isDark)
    }).catch(() => {})

    // Listen for OS theme changes
    const unsub = window.clui.onThemeChange((isDark) => {
      setSystemTheme(isDark)
    })
    return unsub
  }, [setSystemTheme])

  useEffect(() => {
    useSessionStore.getState().initStaticInfo().then(() => {
      const homeDir = useSessionStore.getState().staticInfo?.homePath || '~'
      const tab = useSessionStore.getState().tabs[0]
      if (tab) {
        // If the tab already has a saved directory (from localStorage), keep it;
        // otherwise fall back to the user's home directory.
        if (!tab.hasChosenDirectory) {
          useSessionStore.setState((s) => ({
            tabs: s.tabs.map((t, i) => (i === 0 ? { ...t, workingDirectory: homeDir, hasChosenDirectory: false } : t)),
          }))
        }
        window.clui.createTab().then(({ tabId }) => {
          useSessionStore.setState((s) => ({
            tabs: s.tabs.map((t, i) => (i === 0 ? { ...t, id: tabId } : t)),
            activeTabId: tabId,
          }))
        }).catch(() => {})
      }
    })
  }, [])

  // OS-level click-through (RAF-throttled to avoid per-pixel IPC)
  useEffect(() => {
    if (!window.clui?.setIgnoreMouseEvents) return
    let lastIgnored: boolean | null = null

    const onMouseMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const isUI = !!(el && el.closest('[data-clui-ui]'))
      const shouldIgnore = !isUI
      if (shouldIgnore !== lastIgnored) {
        lastIgnored = shouldIgnore
        if (shouldIgnore) {
          window.clui.setIgnoreMouseEvents(true, { forward: true })
        } else {
          window.clui.setIgnoreMouseEvents(false)
        }
      }
    }

    const onMouseLeave = () => {
      if (lastIgnored !== true) {
        lastIgnored = true
        window.clui.setIgnoreMouseEvents(true, { forward: true })
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseleave', onMouseLeave)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [])

  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    const filePaths = files.map((f) => f.path).filter(Boolean)
    if (filePaths.length === 0) return

    const attachments = await window.clui.processDroppedFiles(filePaths)
    if (attachments && attachments.length > 0) {
      addAttachments(attachments)
    }
  }, [addAttachments])

  const isExpanded = useSessionStore((s) => s.isExpanded)
  const marketplaceOpen = useSessionStore((s) => s.marketplaceOpen)
  const isRunning = activeTabStatus === 'running' || activeTabStatus === 'connecting'

  // Layout dimensions — expandedUI widens and heightens the panel
  const contentWidth = expandedUI ? 700 : spacing.contentWidth
  const cardExpandedWidth = expandedUI ? 700 : 460
  const cardCollapsedWidth = expandedUI ? 670 : 430
  const cardCollapsedMargin = expandedUI ? 15 : 15
  const bodyMaxHeight = expandedUI ? 520 : 400

  const handleScreenshot = useCallback(async () => {
    const result = await window.clui.takeScreenshot()
    if (!result) return
    addAttachments([result])
  }, [addAttachments])

  const handleAttachFile = useCallback(async () => {
    const files = await window.clui.attachFiles()
    if (!files || files.length === 0) return
    addAttachments(files)
  }, [addAttachments])

  const handleDragMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    // Don't drag if clicking on an interactive element
    const el = e.target as HTMLElement
    if (el.closest('button, input, textarea, select, a, [role="button"], [data-no-drag], .prose-cloud, .conversation-selectable')) return
    e.preventDefault()
    let lastX = e.screenX
    let lastY = e.screenY
    const onMove = (ev: MouseEvent) => {
      const dx = ev.screenX - lastX
      const dy = ev.screenY - lastY
      lastX = ev.screenX
      lastY = ev.screenY
      window.clui.dragWindow(dx, dy)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      window.clui.dragEnd()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const contentRef = useRef<HTMLDivElement>(null)

  return (
    <PopoverLayerProvider>
      <div
        className="flex flex-col justify-end h-full"
        style={{ background: 'transparent' }}
      >

        {/* ─── 460px content column, centered. Circles overflow left. ─── */}
        <div ref={contentRef} style={{ width: contentWidth, position: 'relative', margin: '0 auto', transition: 'width 0.26s cubic-bezier(0.4, 0, 0.1, 1)' }}>

          <AnimatePresence initial={false}>
            {marketplaceOpen && (
              <div
                data-clui-ui
                style={{
                  width: 720,
                  maxWidth: 720,
                  marginLeft: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 14,
                  position: 'relative',
                  zIndex: 30,
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.985 }}
                  transition={TRANSITION}
                >
                  <div
                    data-clui-ui
                    className="glass-surface overflow-hidden no-drag"
                    style={{
                      borderRadius: 24,
                      maxHeight: 470,
                    }}
                  >
                    <MarketplacePanel />
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          {/*
            ─── Tabs / message shell ───
            This always remains the chat shell. The marketplace is a separate
            panel rendered above it, never inside it.
          */}
          <motion.div
            data-clui-ui
            className="overflow-hidden flex flex-col"
            onMouseDown={handleDragMouseDown}
            animate={{
              width: isExpanded ? cardExpandedWidth : cardCollapsedWidth,
              marginBottom: isExpanded ? 10 : -14,
              marginLeft: isExpanded ? 0 : cardCollapsedMargin,
              marginRight: isExpanded ? 0 : cardCollapsedMargin,
              background: isExpanded ? colors.containerBg : colors.containerBgCollapsed,
              borderColor: colors.containerBorder,
              boxShadow: isExpanded ? colors.cardShadow : colors.cardShadowCollapsed,
            }}
            transition={TRANSITION}
            style={{
              borderWidth: 1,
              borderStyle: 'solid',
              borderRadius: 20,
              position: 'relative',
              zIndex: isExpanded ? 20 : 10,
            }}
          >
            {/* Tab strip — always mounted */}
            <div className="no-drag">
              <TabStrip />
            </div>

            {/* Body — chat history only; the marketplace is a separate overlay above */}
            <motion.div
              initial={false}
              animate={{
                height: isExpanded ? 'auto' : 0,
                opacity: isExpanded ? 1 : 0,
              }}
              transition={TRANSITION}
              className="overflow-hidden no-drag"
            >
              <div style={{ maxHeight: bodyMaxHeight }}>
                <ConversationView />
                <StatusBar />
              </div>
            </motion.div>
          </motion.div>

          {/* ─── Input row — circles float outside left & right ─── */}
          {/* marginBottom: shadow buffer so the glass-surface drop shadow isn't clipped at the native window edge */}
          <div data-clui-ui className="relative" style={{ minHeight: 46, zIndex: 15, marginBottom: 10 }}>
            {/* Left — stacked circle buttons (attach, screenshot, skills) */}
            <div
              data-clui-ui
              className="circles-out"
            >
              <div className="btn-stack">
                {/* btn-1: Attach (front, rightmost) */}
                <button
                  className="stack-btn stack-btn-1 glass-surface"
                  title="Attach file"
                  onClick={handleAttachFile}
                  disabled={isRunning}
                >
                  <Paperclip size={17} />
                </button>
                {/* btn-2: Screenshot (middle) */}
                <button
                  className="stack-btn stack-btn-2 glass-surface"
                  title="Take screenshot"
                  onClick={handleScreenshot}
                  disabled={isRunning}
                >
                  <Camera size={17} />
                </button>
                {/* btn-3: Skills (back, leftmost) */}
                <button
                  className="stack-btn stack-btn-3 glass-surface"
                  title="Skills & Plugins"
                  onClick={() => useSessionStore.getState().toggleMarketplace()}
                  disabled={isRunning}
                >
                  <HeadCircuit size={17} />
                </button>
              </div>
            </div>

            {/* TODO: Usage limit circle — hidden until Anthropic exposes an account usage API endpoint
            <div
              data-clui-ui
              className="circle-out-right"
            >
              <UsageLimitCircle />
            </div>
            */}

            {/* Input pill */}
            <div
              data-clui-ui
              className="glass-surface w-full"
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              style={{
                minHeight: 50,
                borderRadius: 25,
                padding: '0 6px 0 16px',
                background: colors.inputPillBg,
                position: 'relative',
                transition: 'border-color 0.15s ease',
                ...(isDragOver ? {
                  borderColor: colors.accent,
                  borderWidth: 2,
                  borderStyle: 'dashed',
                } : {}),
              }}
            >
              <InputBar />
              <AnimatePresence>
                {isDragOver && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: 25,
                      background: `${colors.accent}18`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      pointerEvents: 'none',
                      zIndex: 10,
                    }}
                  >
                    <Paperclip size={18} weight="bold" style={{ color: colors.accent }} />
                    <span style={{ color: colors.accent, fontSize: 13, fontWeight: 600 }}>
                      Drop here
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </PopoverLayerProvider>
  )
}
