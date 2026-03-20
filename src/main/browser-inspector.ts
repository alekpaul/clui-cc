import { BrowserWindow } from 'electron'
import { log as _log } from './logger'
import type { ElementInspection } from '../shared/types'

function log(msg: string): void {
  _log('BrowserInspector', msg)
}

/** Track active inspector window to prevent duplicates */
let activeInspectorWindow: BrowserWindow | null = null

// Injected once on page load. Uses console.log to send selections back to Node.
// The picker re-arms automatically after each selection (1.5 s flash, then re-arm).
// Esc cleans up the overlay but leaves the window open.
const PICKER_SCRIPT = `
(function () {
  if (window.__cluiPickerActive) return;
  window.__cluiPickerActive = true;

  var style = document.createElement('style');
  style.textContent = [
    '.__clui_h { outline: 2px solid #6366f1 !important; outline-offset: 2px !important; cursor: crosshair !important; }',
    '#__clui_banner {',
    '  position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;',
    '  background: rgba(79,70,229,0.96); color: #fff;',
    '  font-family: -apple-system,BlinkMacSystemFont,sans-serif; font-size: 13px; font-weight: 500;',
    '  padding: 9px 16px; display: flex; align-items: center; gap: 10px;',
    '  box-shadow: 0 2px 12px rgba(0,0,0,0.3); user-select: none;',
    '}',
    '#__clui_tip {',
    '  position: fixed; bottom: 12px; left: 12px; z-index: 2147483647;',
    '  background: rgba(0,0,0,0.72); color: #fff;',
    '  font-family: monospace; font-size: 11px; padding: 4px 8px; border-radius: 4px;',
    '  pointer-events: none; max-width: 480px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '}',
  ].join('\\n');
  document.head.appendChild(style);

  var banner = document.createElement('div');
  banner.id = '__clui_banner';
  document.body.appendChild(banner);

  var tip = document.createElement('div');
  tip.id = '__clui_tip';
  tip.textContent = 'Hover over elements…';
  document.body.appendChild(tip);

  var hovered = null;
  var armed = false;

  function setArmedBanner() {
    banner.innerHTML = '\\uD83D\\uDD0D <strong>Clui CC Inspector</strong> \\u2014 Click any element &nbsp;|&nbsp; <span style="opacity:.75;font-size:12px">Esc to stop</span>';
    banner.style.background = 'rgba(79,70,229,0.96)';
  }

  function arm() {
    armed = true;
    setArmedBanner();
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('click', onClick, true);
  }

  function disarm() {
    armed = false;
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('click', onClick, true);
    if (hovered) { try { hovered.classList.remove('__clui_h'); } catch(e){} hovered = null; }
  }

  function cleanup() {
    disarm();
    window.__cluiPickerActive = false;
    document.removeEventListener('keydown', onKey, true);
    try { if (style.parentNode) style.parentNode.removeChild(style); } catch (e) {}
    try { if (banner.parentNode) banner.parentNode.removeChild(banner); } catch (e) {}
    try { if (tip.parentNode) tip.parentNode.removeChild(tip); } catch (e) {}
  }

  function onHover(e) {
    var t = e.target;
    if (t === banner || banner.contains(t) || t === tip) return;
    if (hovered && hovered !== t) { try { hovered.classList.remove('__clui_h'); } catch(e){} }
    try { t.classList.add('__clui_h'); } catch(e){}
    hovered = t;
    var label = t.tagName.toLowerCase();
    if (t.id) label += '#' + t.id;
    var cls = Array.from(t.classList).filter(function(c) { return !c.startsWith('__clui'); }).slice(0, 3);
    if (cls.length) label += '.' + cls.join('.');
    tip.textContent = label;
  }

  function getReact(el) {
    try {
      var key = Object.keys(el).find(function(k) {
        return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
      });
      if (!key) return null;
      var f = el[key]; var depth = 0;
      while (f && depth++ < 25) {
        var t = f.type;
        if (t && (typeof t === 'function' || (typeof t === 'object' && t !== null))) {
          var name = (typeof t === 'function') ? (t.displayName || t.name) : t.displayName;
          if (name && name.length > 1 && !/^(div|span|button|a|p|ul|li|h[1-6]|input|form|nav|main|header|footer|section|article)$/.test(name)) {
            return {
              name: name,
              file: f._debugSource ? f._debugSource.fileName : null,
              line: f._debugSource ? f._debugSource.lineNumber : null,
              propKeys: f.memoizedProps ? Object.keys(f.memoizedProps).filter(function(k) { return k !== 'children'; }) : [],
            };
          }
        }
        f = f.return;
      }
    } catch (e) {}
    return null;
  }

  function getSelector(el) {
    try {
      var parts = []; var cur = el;
      while (cur && cur !== document.body && parts.length < 6) {
        var seg = cur.tagName.toLowerCase();
        if (cur.id) { seg += '#' + cur.id; parts.unshift(seg); break; }
        var cls = Array.from(cur.classList).filter(function(c) { return !c.startsWith('__clui'); }).slice(0, 2);
        if (cls.length) seg += '.' + cls.join('.');
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    } catch (e) { return el.tagName.toLowerCase(); }
  }

  function onClick(e) {
    if (!armed) return;
    var t = e.target;
    if (t === banner || banner.contains(t)) return;
    e.preventDefault(); e.stopPropagation();
    disarm();

    var result = {
      url: window.location.href,
      tagName: t.tagName.toLowerCase(),
      id: t.id || '',
      classes: Array.from(t.classList).filter(function(c) { return !c.startsWith('__clui'); }),
      selector: getSelector(t),
      outerHTML: t.outerHTML.substring(0, 800),
      innerText: (t.innerText || '').substring(0, 200).trim(),
      reactComponent: getReact(t) || undefined,
      timestamp: Date.now(),
    };

    // Send result back to Node via console.log (intercepted by webContents event)
    console.log('__clui_select:' + JSON.stringify(result));

    // Show success flash
    banner.innerHTML = '\\u2713 <strong>Element captured!</strong> \\u2014 ' + result.selector + ' &nbsp;|&nbsp; <span style="opacity:.75;font-size:12px">Click another or close window</span>';
    banner.style.background = 'rgba(16,185,129,0.96)';
    tip.textContent = result.selector;

    // Re-arm after flash
    setTimeout(function() { arm(); }, 1500);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
  }

  document.addEventListener('keydown', onKey, true);
  arm();
})()
`

/**
 * Launch browser inspector window. Resolves once the window has opened and loaded
 * (not when it closes). If an inspector window is already open, focuses it instead.
 */
export async function launchBrowserInspector(
  url: string,
  onSelect: (result: ElementInspection) => void,
): Promise<null> {
  // If an inspector window is already open, focus it and return immediately
  if (activeInspectorWindow && !activeInspectorWindow.isDestroyed()) {
    log('Inspector already open — focusing existing window')
    activeInspectorWindow.focus()
    return null
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      title: 'Clui CC — Element Inspector',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    activeInspectorWindow = win
    win.setMenuBarVisibility(false)
    log(`Launching inspector: ${url}`)

    // Listen for selections via console messages
    win.webContents.on('console-message', (_e, _level, message) => {
      if (!message.startsWith('__clui_select:')) return
      try {
        const result = JSON.parse(message.slice('__clui_select:'.length)) as ElementInspection
        log(`Element selected: ${result.selector}`)
        onSelect(result)
      } catch (err) {
        log(`Inspector parse error: ${err}`)
      }
    })

    // Clear the active window reference when closed
    win.on('closed', () => {
      activeInspectorWindow = null
    })

    const inject = async () => {
      await new Promise((r) => setTimeout(r, 250))
      try {
        await win.webContents.executeJavaScript(PICKER_SCRIPT)
      } catch (err: any) {
        log(`Inspector inject error: ${err?.message}`)
      }
    }

    // Re-inject picker on every navigation (user navigates within the site)
    // Resolve the promise on first load (window is ready)
    let resolved = false
    win.webContents.on('did-finish-load', () => {
      inject()
      if (!resolved) {
        resolved = true
        resolve(null)
      }
    })

    win.loadURL(url).catch((err: Error) => {
      log(`Inspector load error: ${err.message}`)
      if (!resolved) {
        resolved = true
        resolve(null)
      }
    })
  })
}
