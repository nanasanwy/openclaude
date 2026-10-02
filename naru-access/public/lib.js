// Shared helpers for the staff app, gate display and simulator. No framework, no build step.

export const session = {
  get token() {
    try { return localStorage.getItem('naru.token') } catch { return null }
  },
  set token(v) {
    try { v ? localStorage.setItem('naru.token', v) : localStorage.removeItem('naru.token') } catch {}
  },
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api(path, { method, body, raw } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (session.token) headers.authorization = `Bearer ${session.token}`
  const res = await fetch(path, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  if (raw && res.ok) return res
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Request failed (${res.status})`)
  return data
}

/** Creates an element. Children may be strings, nodes, arrays, or null. Strings are always text, never HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'class') node.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v)
    else if (k === 'value') node.value = v
    else if (v === true) node.setAttribute(k, '')
    else node.setAttribute(k, String(v))
  }
  const add = c => {
    if (c === null || c === undefined || c === false) return
    if (Array.isArray(c)) c.forEach(add)
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  children.forEach(add)
  return node
}

export function clear(node, ...children) {
  node.replaceChildren()
  for (const c of children.flat()) if (c) node.append(c)
  return node
}

// ---------- time ----------
let timeZone = 'Asia/Kuala_Lumpur'
let clockOffset = 0 // server time minus browser time (non-zero in the simulator)
export function setTimeContext(tz, serverNow) {
  timeZone = tz
  clockOffset = serverNow - Date.now()
}
export const serverNow = () => Date.now() + clockOffset

export function fmtTime(ms) {
  if (ms === null || ms === undefined) return '—'
  return new Intl.DateTimeFormat('en-MY', { timeZone, hour: 'numeric', minute: '2-digit' }).format(ms)
}
export function fmtDateTime(ms) {
  if (ms === null || ms === undefined) return '—'
  return new Intl.DateTimeFormat('en-MY', { timeZone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(ms)
}
export function fmtDateLong(ms) {
  return new Intl.DateTimeFormat('en-MY', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ms)
}
export function todayLocal(ms = serverNow()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}
export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—'
  const neg = ms < 0
  const mins = Math.floor(Math.abs(ms) / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const s = h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
  return neg ? `-${s}` : s
}
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
export const rm = n => `RM ${Number(n).toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

export const BAND_LABEL = { adult: 'Adult', kid: 'Kid', under2: 'Under 2' }
export const bandBadge = type => el('span', { class: `badge ${type}` }, BAND_LABEL[type] ?? type)

export const PHASE = {
  not_started: ['Not in yet', ''],
  playing: ['Playing', 'ok'],
  grace: ['Grace period', 'warn'],
  overtime: ['Overtime — exit held', 'bad'],
  cleared: ['Cleared to leave', 'ok'],
  closed: ['Closed', ''],
}
export const phaseBadge = phase => el('span', { class: `badge ${PHASE[phase]?.[1] ?? ''}` }, PHASE[phase]?.[0] ?? phase)

// ---------- feedback ----------
let toastHost
export function toast(message, kind = '', ms = 4000) {
  toastHost ??= document.body.appendChild(el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }))
  const t = el('div', { class: `toast ${kind}` }, message)
  toastHost.append(t)
  setTimeout(() => t.remove(), ms)
}

export function showError(err) {
  toast(err?.message ?? String(err), 'bad', 6000)
}

/**
 * Small form dialog. fields: [{ name, label, type?, required?, options?, value?, min? }]
 * Resolves with the values, or null when cancelled.
 */
export function ask({ title, message, fields = [], confirm = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const inputs = {}
    const form = el('form', { method: 'dialog' },
      el('h2', {}, title),
      message ? el('p', { class: 'muted' }, message) : null,
      fields.map(f => {
        const input = f.options
          ? el('select', { name: f.name, required: f.required }, f.options.map(o => el('option', { value: o.value, selected: o.value === f.value }, o.label)))
          : el(f.type === 'textarea' ? 'textarea' : 'input', { name: f.name, type: f.type ?? 'text', required: f.required, min: f.min, value: f.value ?? '', inputmode: f.inputmode, autocomplete: 'off' })
        inputs[f.name] = input
        return el('div', { class: 'field' }, el('label', {}, f.label), input)
      }),
      el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '8px' } },
        el('button', { type: 'button', onclick: () => { dialog.close(); resolve(null) } }, 'Cancel'),
        el('button', { type: 'submit', class: danger ? 'danger' : 'primary' }, confirm)),
    )
    const dialog = el('dialog', {}, form)
    form.addEventListener('submit', e => {
      e.preventDefault()
      const values = {}
      for (const [k, input] of Object.entries(inputs)) values[k] = input.type === 'number' ? Number(input.value) : input.value.trim()
      dialog.close()
      resolve(values)
    })
    dialog.addEventListener('close', () => setTimeout(() => dialog.remove(), 0))
    dialog.addEventListener('cancel', () => resolve(null))
    document.body.append(dialog)
    dialog.showModal()
    Object.values(inputs)[0]?.focus()
  })
}

/** Keeps a websocket open, reconnecting after drops. Returns a function that closes it. */
export function liveSocket(query, onMessage, onStatus = () => {}) {
  let ws
  let closed = false
  let retry = 500
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws?${query}`)
    ws.onopen = () => { retry = 500; onStatus(true) }
    ws.onmessage = e => { try { onMessage(JSON.parse(e.data)) } catch {} }
    ws.onclose = () => {
      onStatus(false)
      if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 5000)))
    }
  }
  open()
  return () => { closed = true; ws?.close() }
}

/** Downloads an authenticated file (CSV/JSON export). */
export async function download(path, filename) {
  const res = await api(path, { raw: true })
  const url = URL.createObjectURL(await res.blob())
  const a = el('a', { href: url, download: filename })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/**
 * Draws a shareable e-invite card (1080 x 1500 px, sized for phones and WhatsApp)
 * with the party details and a scannable QR code. `qr.rows` is the server's QR matrix.
 */
export function inviteCard({ venueName, party, qr }) {
  const rows = qr.rows
  const W = 1080
  const H = 1500
  const canvas = el('canvas', { width: W, height: H })
  const ctx = canvas.getContext('2d')
  const font = (weight, px, family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif') => `${weight} ${px}px ${family}`
  const centered = (text, y, f, color = '#16181d') => {
    ctx.font = f
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.fillText(text, W / 2, y)
  }
  const wrap = (text, f, maxWidth, maxLines) => {
    ctx.font = f
    const lines = []
    let line = ''
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      if (ctx.measureText(next).width <= maxWidth || !line) line = next
      else { lines.push(line); line = word }
    }
    if (line) lines.push(line)
    if (lines.length > maxLines) {
      lines.length = maxLines
      let last = lines[maxLines - 1]
      while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1)
      lines[maxLines - 1] = `${last}…`
    }
    return lines
  }

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#2456d6'
  ctx.fillRect(0, 0, W, 150)
  centered(venueName, 98, font(800, 56), '#ffffff')

  let y = 250
  centered("You're invited to", y, font(500, 40), '#5d6470')
  y += 86
  for (const line of wrap(party.name, font(800, 66), W - 120, 2)) {
    centered(line, y, font(800, 66))
    y += 80
  }
  y += 6
  centered(fmtDateLong(party.startAt), y, font(600, 40))
  y += 56
  centered(`${fmtTime(party.startAt)} – ${fmtTime(party.endAt)} · ${party.room}`, y, font(500, 40), '#5d6470')

  // QR with its 4-module quiet zone, scaled to whole pixels so every module stays sharp.
  const modules = rows.length + 8
  const scale = Math.floor(620 / modules)
  const qrPx = modules * scale
  const qx = Math.round((W - qrPx) / 2)
  const qy = y + 50
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(qx, qy, qrPx, qrPx)
  ctx.fillStyle = '#000000'
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) if (row[c] === '1') ctx.fillRect(qx + (c + 4) * scale, qy + (r + 4) * scale, scale, scale)
  })
  ctx.strokeStyle = '#d9dde3'
  ctx.lineWidth = 2
  ctx.strokeRect(qx - 1, qy - 1, qrPx + 2, qrPx + 2)

  y = qy + qrPx + 70
  centered('Invite code', y, font(500, 34), '#5d6470')
  y += 80
  centered(party.inviteCode.split('').join(' '), y, font(800, 76, 'ui-monospace, Menlo, Consolas, monospace'))
  y += 80
  centered('Show this at reception when you arrive', y, font(500, 36), '#5d6470')
  return canvas
}
