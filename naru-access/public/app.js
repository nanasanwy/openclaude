import {
  api, ask, bandBadge, clear, download, el, fmtDateTime, inviteCard, fmtDuration, fmtTime, liveSocket, phaseBadge, plural, rm,
  serverNow, session, setTimeContext, showError, toast, todayLocal,
} from './lib.js'

const app = document.getElementById('app')
const state = { me: null, permissions: [], meta: null, settings: null, socketClose: null, listeners: new Set() }
const can = p => state.permissions.includes(p)

// ------------------------------------------------------------ boot & routing

async function boot() {
  state.meta = await api('/api/meta')
  setTimeContext(state.meta.timeZone, state.meta.now)
  document.title = `${state.meta.venueName} access`
  if (session.token) {
    try {
      const me = await api('/api/me')
      await signedIn(me.staff, me.permissions)
      return
    } catch {
      session.token = null
    }
  }
  renderLogin()
}

async function signedIn(staff, permissions) {
  state.me = staff
  state.permissions = permissions
  state.settings = await api('/api/settings')
  state.socketClose?.()
  state.socketClose = liveSocket(`token=${session.token}`, msg => {
    if (msg.type === 'alert' && can('dashboard.view')) {
      const d = msg.decision
      toast(`Gate ${d.lane.toUpperCase()}: ${d.message} (${d.barcode})`, 'warn', 8000)
      navigator.vibrate?.([200, 100, 200])
    }
    for (const l of state.listeners) l(msg)
  })
  window.onhashchange = route
  route()
}

/** Subscribes the current screen to live events; cleared on navigation. */
function onLive(fn) {
  state.listeners.add(fn)
}

/** Re-runs `fn` when anything changes on the server (debounced), and every `everyMs`. */
function autoRefresh(fn, everyMs = 15000) {
  let pending = null
  onLive(msg => {
    if (msg.type !== 'changed' && msg.type !== 'lane') return
    clearTimeout(pending)
    pending = setTimeout(fn, 250)
  })
  const timer = setInterval(fn, everyMs)
  cleanups.push(() => { clearInterval(timer); clearTimeout(pending) })
}

let cleanups = []
const screens = {
  '': home,
  activate,
  checkin: partyCheckin,
  parties: partySetup,
  dashboard,
  group: groupDetail,
  handheld,
  packages,
  settings: settingsScreen,
  staff: staffScreen,
  reports,
}

function route() {
  for (const c of cleanups) c()
  cleanups = []
  state.listeners.clear()
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/')
  const screen = screens[name] ?? home
  const main = el('main')
  clear(app, topbar(), main)
  Promise.resolve(screen(main, arg)).catch(showError)
}

function topbar() {
  const cap = el('span', { class: 'badge' }, '…')
  const refreshCap = () =>
    api('/api/capacity').then(c => {
      cap.className = `badge ${c.full ? 'bad' : c.warn ? 'warn' : 'ok'}`
      cap.textContent = `${c.occupancy}/${c.capacity}`
      cap.title = `${c.inside} inside, ${c.pending} activated not yet in`
    }).catch(() => {})
  refreshCap()
  onLive(msg => msg.type === 'changed' && refreshCap())
  return el('header', { class: 'topbar' },
    el('a', { href: '#/', class: 'brand', 'aria-label': `${state.meta.venueName} home` }, el('img', { src: 'brand/naru-logo.png', alt: 'Naru Play Café' })),
    state.meta.sim ? el('span', { class: 'badge warn' }, 'SIMULATOR') : null,
    el('span', { class: 'row small' }, 'Capacity', cap),
    el('span', { class: 'spacer' }),
    el('span', { class: 'who' }, `${state.me.name} · ${state.me.role}`),
    el('button', { class: 'small', onclick: logout }, 'Switch user'),
  )
}

async function logout() {
  await api('/api/logout', { body: {} }).catch(() => {})
  session.token = null
  state.socketClose?.()
  state.socketClose = null
  state.me = null
  state.permissions = []
  // Stop routing before clearing the hash, or the hash change re-renders the old user's screens.
  window.onhashchange = null
  for (const c of cleanups) c()
  cleanups = []
  state.listeners.clear()
  history.replaceState(null, '', location.pathname + location.search)
  renderLogin()
}

function renderLogin() {
  let pin = ''
  const dots = el('div', { class: 'pin-dots', 'aria-live': 'polite' })
  const msg = el('p', { class: 'muted' }, 'Enter your staff PIN')
  const show = () => (dots.textContent = '•'.repeat(pin.length) || ' ')
  const submit = async () => {
    if (pin.length < 4) return
    try {
      const res = await api('/api/login', { body: { pin } })
      session.token = res.token
      await signedIn(res.staff, res.permissions)
    } catch (err) {
      pin = ''
      show()
      msg.textContent = err.message
    }
  }
  const press = k => {
    if (k === 'clear') pin = ''
    else if (k === 'go') return submit()
    else if (pin.length < 8) pin += k
    show()
  }
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'go']
  const pad = el('div', { class: 'pinpad' }, keys.map(k =>
    el('button', { type: 'button', class: k === 'go' ? 'primary' : '', onclick: () => press(k) }, k === 'clear' ? 'Clear' : k === 'go' ? 'Enter' : k)))
  document.onkeydown = e => {
    if (state.me) return
    if (/^\d$/.test(e.key)) press(e.key)
    else if (e.key === 'Enter') press('go')
    else if (e.key === 'Backspace') { pin = pin.slice(0, -1); show() }
  }
  show()
  clear(app, el('div', { class: 'login card' },
    el('img', { class: 'login-logo', src: 'brand/naru-logo.png', alt: 'Naru Play Café' }),
    el('h1', { style: { fontSize: '1.3rem' } }, `${state.meta.venueName} access`),
    state.meta.sim ? el('p', { class: 'banner warn small', style: { fontWeight: 600 } }, 'Simulator: test data only') : null,
    msg, dots, pad))
}

// ------------------------------------------------------------ home

function home(main) {
  const tiles = [
    ['walkin.activate', '#/activate', 'Activate bands', 'Walk-in families'],
    ['party.checkin', '#/checkin', 'Party check-in', 'Find by e-invite code'],
    ['party.manage', '#/parties', 'Party setup', 'Create parties and invite codes'],
    ['package.use', '#/packages', 'Packages', 'Accounts, balances, transfers'],
    ['dashboard.view', '#/dashboard', 'Live dashboard', 'Who is inside, overtime, alerts'],
    ['gate.override', '#/handheld', 'Handheld gate scan', 'Backup when a reader fails'],
    ['reports.view', '#/reports', 'Reports', 'Daily figures and exports'],
    ['settings.manage', '#/settings', 'Settings', 'Prices, times and rules'],
    ['staff.manage', '#/staff', 'Staff', 'Accounts and PINs'],
  ].filter(([p]) => can(p))
  clear(main,
    el('h3', {}, 'Play access'),
    el('h1', {}, `Hello, ${state.me.name}`),
    el('div', { class: 'tiles' }, tiles.map(([, href, title, sub]) => el('a', { class: 'tile', href }, title, el('span', {}, sub)))))
}

// ------------------------------------------------------------ band activation (cashier)

function underTwoToggle() {
  const btn = el('button', { type: 'button', class: 'toggle', 'aria-pressed': 'false' }, 'Next kid band is under 2')
  btn.onclick = () => btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')
  return {
    node: btn,
    take() {
      const on = btn.getAttribute('aria-pressed') === 'true'
      btn.setAttribute('aria-pressed', 'false')
      return on
    },
  }
}

/** Scan box + band list for one group. Used by walk-in activation and party check-in. */
function bandScanner(groupId, { onAdded, initialBands = [] } = {}) {
  const list = el('ul', { class: 'list' })
  const capMsg = el('div')
  const input = el('input', { class: 'scan', placeholder: 'Scan band…', autocomplete: 'off', autocapitalize: 'characters', enterkeyhint: 'done' })
  const under2 = underTwoToggle()
  const addRow = band =>
    list.prepend(el('li', {}, bandBadge(band.type), el('span', { class: 'mono grow' }, band.barcode),
      el('button', { class: 'small', onclick: async () => {
        const r = await ask({ title: `Void ${band.barcode}?`, message: 'Use this if the band was scanned by mistake or damaged.', fields: [{ name: 'reason', label: 'Reason', required: true }], confirm: 'Void band', danger: true })
        if (!r) return
        try {
          await api(`/api/bands/${encodeURIComponent(band.barcode)}/void`, { body: r })
          toast(`${band.barcode} voided`)
          rowFor(band.barcode)?.remove()
        } catch (err) { showError(err) }
      } }, 'Void')))
  const rowFor = code => [...list.children].find(li => li.textContent.includes(code))
  initialBands.forEach(addRow)
  input.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return
    const barcode = input.value.trim()
    input.value = ''
    if (!barcode) return
    try {
      const isKidRoll = barcode.toUpperCase().startsWith(state.settings.bandPrefixes.kid)
      const type = isKidRoll && under2.take() ? 'under2' : undefined
      const res = await api(`/api/groups/${groupId}/bands`, { body: { barcode, type } })
      addRow(res.band)
      const c = res.capacity
      clear(capMsg, c.full
        ? el('div', { class: 'banner bad' }, `Paid zone is now FULL (${c.occupancy}/${c.capacity}). No more bands can be activated.`)
        : c.warn ? el('div', { class: 'banner warn' }, `Capacity warning: ${c.occupancy}/${c.capacity} (${c.percent}%)`) : null)
      onAdded?.(res)
    } catch (err) {
      showError(err)
      navigator.vibrate?.(300)
    }
    input.focus()
  })
  setTimeout(() => input.focus(), 50)
  return el('div', { class: 'stack' }, el('div', { class: 'row' }, el('div', { class: 'grow' }, input), under2.node), capMsg, list)
}

async function activate(main) {
  const receipt = el('input', { placeholder: 'e.g. 10442', autocomplete: 'off' })
  const table = el('input', { placeholder: 'e.g. 12', autocomplete: 'off' })
  const pkgArea = el('div')
  let pkg = null
  const kids = el('input', { type: 'number', min: 1, value: 1, inputmode: 'numeric' })

  const choosePackage = async () => {
    const phone = await ask({ title: 'Find package by phone', fields: [{ name: 'phone', label: 'Phone number', type: 'tel', required: true, inputmode: 'tel' }], confirm: 'Search' })
    if (!phone) return
    try {
      const results = await api(`/api/packages?phone=${encodeURIComponent(phone.phone)}`)
      if (!results.length) return toast('No package account with that phone number', 'warn')
      const pick = results.length === 1 ? results[0] : await new Promise(resolve => {
        const d = el('dialog', {}, el('h2', {}, 'Choose account'), el('ul', { class: 'list' }, results.map(r =>
          el('li', { class: 'clickable', onclick: () => { d.close(); resolve(r) } }, el('strong', { class: 'grow' }, r.name), `${r.phone} · ${r.visitsLeft} left`))),
          el('button', { onclick: () => { d.close(); resolve(null) } }, 'Cancel'))
        document.body.append(d)
        d.showModal()
      })
      if (!pick) return
      pkg = pick
      renderPkg()
    } catch (err) { showError(err) }
  }
  const renderPkg = () => clear(pkgArea, pkg
    ? el('div', { class: 'banner ok' },
        el('div', {}, `Package: ${pkg.name} (${pkg.phone}) — ${pkg.visitsLeft} visits left${pkg.expired ? ' — EXPIRED' : ''}`),
        el('div', { class: 'row', style: { marginTop: '8px' } }, el('label', { style: { margin: 0 } }, 'Kids on this visit'), el('div', { style: { width: '120px' } }, kids),
          el('button', { class: 'small', onclick: () => { pkg = null; renderPkg() } }, 'Remove')))
    : el('button', { onclick: choosePackage }, 'Use visit package…'))
  renderPkg()

  const start = async () => {
    try {
      const body = { receiptNo: receipt.value, tableNo: table.value }
      if (pkg) Object.assign(body, { packageAccountId: pkg.id, packageKids: Number(kids.value) })
      const group = await api('/api/groups', { body })
      if (pkg) toast(`${kids.value} visit(s) deducted from ${pkg.name}'s package`, 'ok')
      scanStep(group)
    } catch (err) { showError(err) }
  }

  const scanStep = group => {
    const counts = el('div', { class: 'row' })
    const tally = { adult: 0, kid: 0, under2: 0 }
    const renderCounts = () => clear(counts, el('span', { class: 'badge adult' }, `${tally.adult} adult`), el('span', { class: 'badge kid' }, `${tally.kid} kid`), el('span', { class: 'badge under2' }, `${tally.under2} under 2`))
    renderCounts()
    clear(main,
      el('h1', {}, `Group ${group.id}`),
      el('p', { class: 'muted' }, `Receipt ${group.receiptNo ?? '—'} · Table ${group.tableNo ?? '—'}. Scan one band for every person, including under-2s. Their timer starts at the gate.`),
      el('div', { class: 'card stack' }, counts, bandScanner(group.id, { onAdded: r => { tally[r.band.type]++; renderCounts() } })),
      el('div', { class: 'row', style: { marginTop: '16px' } },
        el('button', { class: 'primary', onclick: () => route() }, 'Done — next group'),
        can('group.view') ? el('a', { class: 'btn', href: `#/group/${group.id}` }, 'Group detail') : null))
  }

  clear(main,
    el('h1', {}, 'Activate bands'),
    el('div', { class: 'card', style: { maxWidth: '640px' } },
      el('p', { class: 'muted' }, 'Sell the play passes in StoreHub first, then start the group here.'),
      el('div', { class: 'field' }, el('label', {}, 'StoreHub receipt number'), receipt),
      el('div', { class: 'field' }, el('label', {}, 'Table number'), table),
      el('div', { class: 'field' }, pkgArea),
      el('button', { class: 'primary', onclick: start, style: { width: '100%' } }, 'Start group & scan bands')))
  receipt.focus()
}

// ------------------------------------------------------------ party check-in (reception)

async function partyCheckin(main, partyId) {
  if (partyId) return showParty(main, Number(partyId))
  const code = el('input', { class: 'scan', placeholder: 'Scan QR or type invite code', autocomplete: 'off', autocapitalize: 'characters' })
  const today = el('ul', { class: 'list' })
  code.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || !code.value.trim()) return
    try {
      const p = await api(`/api/parties/by-code/${encodeURIComponent(code.value.trim())}`)
      location.hash = `#/checkin/${p.id}`
    } catch (err) { showError(err); code.select() }
  })
  clear(main, el('h1', {}, 'Party check-in'),
    el('div', { class: 'card stack' }, el('label', {}, 'E-invite code'), code),
    el('div', { class: 'card', style: { marginTop: '16px' } }, el('h3', {}, "Today's parties"), today))
  code.focus()
  const parties = await api(`/api/parties?date=${todayLocal()}`)
  clear(today, parties.length ? parties.map(p => el('li', { class: 'clickable', onclick: () => (location.hash = `#/checkin/${p.id}`) },
    el('strong', { class: 'grow' }, p.name), el('span', {}, `${p.room} · ${fmtTime(p.startAt)}–${fmtTime(p.endAt)}`),
    el('span', { class: 'badge' }, `${p.checkedIn.total}/${p.expectedGuests}`))) : el('li', { class: 'empty' }, 'No parties today'))
}

async function showParty(main, id) {
  const p = await api(`/api/parties/${id}`)
  const counter = el('div', { class: 'stat' })
  let checked = p.checkedIn.total
  const renderCounter = () => (counter.textContent = `${checked} / ${p.expectedGuests}`)
  renderCounter()
  const group = await api(`/api/groups/${p.groupId}`)
  clear(main,
    el('h1', {}, p.name),
    el('div', { class: 'grid' },
      el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Checked in / expected'), counter),
      el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Room & time'), el('div', { class: 'stat', style: { fontSize: '1.4rem' } }, p.room), `${fmtTime(p.startAt)} – ${fmtTime(p.endAt)}`),
      el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Host'), el('strong', {}, p.hostName), el('div', {}, p.hostPhone), el('div', { class: 'mono small muted' }, `Code ${p.inviteCode}`), el('button', { class: 'small', style: { marginTop: '8px' }, onclick: () => showInvite(p.id) }, 'E-invite & QR'))),
    el('div', { class: 'card', style: { marginTop: '16px' } },
      el('p', { class: 'muted' }, 'Scan one band per guest. Party bands only open the gate during the party time.'),
      bandScanner(p.groupId, { initialBands: group.bands.filter(b => b.status !== 'void'), onAdded: () => { checked++; renderCounter() } })),
    el('div', { class: 'row', style: { marginTop: '16px' } }, el('a', { class: 'btn', href: '#/checkin' }, 'Back to parties')))
}

/** Shows the e-invite card with download, share and print. */
async function showInvite(partyId) {
  let invite
  try {
    invite = await api(`/api/parties/${partyId}/invite`)
  } catch (err) {
    return showError(err)
  }
  const canvas = await inviteCard(invite)
  const filename = `naru-invite-${invite.party.inviteCode}.png`
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  const file = new File([blob], filename, { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  const preview = el('img', { src: url, alt: `E-invite for ${invite.party.name}, code ${invite.party.inviteCode}`, style: { width: '100%', borderRadius: '12px', boxShadow: 'var(--shadow-ambient)' } })
  const canShare = !!navigator.canShare?.({ files: [file] })
  const print = () => {
    const w = window.open('', '_blank')
    if (!w) return toast('Allow pop-ups to print', 'warn')
    w.document.title = filename
    const img = w.document.createElement('img')
    img.style.cssText = 'width:100%;max-width:540px;display:block;margin:0 auto'
    img.onload = () => w.print()
    img.src = canvas.toDataURL('image/png')
    w.document.body.append(img)
  }
  const dialog = el('dialog', { style: { width: 'min(520px, calc(100vw - 32px))' } },
    el('h2', {}, 'E-invite'),
    el('p', { class: 'muted small' }, 'Send this image to the host to share with guests. Reception scans the QR, or types the code.'),
    preview,
    el('div', { class: 'row', style: { marginTop: '12px' } },
      canShare ? el('button', { class: 'primary', onclick: () => navigator.share({ files: [file], title: invite.party.name }).catch(() => {}) }, 'Share…') : null,
      el('a', { class: `btn ${canShare ? '' : 'primary'}`, href: url, download: filename }, 'Download image'),
      el('button', { onclick: print }, 'Print'),
      el('span', { class: 'spacer', style: { flex: 1 } }),
      el('button', { onclick: () => dialog.close() }, 'Close')))
  dialog.addEventListener('close', () => { URL.revokeObjectURL(url); dialog.remove() })
  document.body.append(dialog)
  dialog.showModal()
}

// ------------------------------------------------------------ party setup (events coordinator)

async function partySetup(main) {
  const s = state.settings
  const f = {
    name: el('input', { placeholder: "e.g. Aisha's 6th birthday" }),
    room: el('select', {}, s.partyRooms.map(r => el('option', { value: r }, r))),
    date: el('input', { type: 'date', value: todayLocal() }),
    startTime: el('input', { type: 'time', value: '14:00' }),
    endTime: el('input', { type: 'time' }),
    expectedGuests: el('input', { type: 'number', min: 1, value: 20, inputmode: 'numeric' }),
    hostName: el('input', {}),
    hostPhone: el('input', { type: 'tel', inputmode: 'tel' }),
    receiptNo: el('input', { placeholder: 'Deposit receipt (optional)' }),
  }
  const fillEnd = () => {
    if (!f.startTime.value) return
    const [h, m] = f.startTime.value.split(':').map(Number)
    const total = h * 60 + m + s.partyBlockMinutes
    f.endTime.value = `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }
  fillEnd()
  f.startTime.addEventListener('change', fillEnd)
  const result = el('div')
  const list = el('ul', { class: 'list' })
  const listDate = el('input', { type: 'date', value: todayLocal() })
  const loadList = async () => {
    const parties = await api(`/api/parties?date=${listDate.value}`)
    clear(list, parties.length ? parties.map(p => el('li', {},
      el('div', { class: 'grow' }, el('strong', {}, p.name), el('div', { class: 'small muted' }, `${p.room} · ${fmtTime(p.startAt)}–${fmtTime(p.endAt)} · host ${p.hostName} ${p.hostPhone}`)),
      el('span', { class: 'mono badge' }, p.inviteCode), el('span', { class: 'badge' }, `${p.checkedIn.total}/${p.expectedGuests}`),
      el('button', { class: 'small', onclick: () => showInvite(p.id) }, 'Invite'),
      el('a', { class: 'btn small', href: `#/checkin/${p.id}` }, 'Bands'))) : el('li', { class: 'empty' }, 'No parties on this date'))
  }
  listDate.addEventListener('change', () => loadList().catch(showError))
  const create = async () => {
    try {
      const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, k === 'expectedGuests' ? Number(v.value) : v.value]))
      const p = await api('/api/parties', { body })
      clear(result, el('div', { class: 'banner ok', style: { marginTop: '12px' } },
        el('div', {}, `Created "${p.name}". E-invite code:`),
        el('div', { class: 'stat mono' }, p.inviteCode),
        el('button', { class: 'primary', style: { marginTop: '8px' }, onclick: () => showInvite(p.id) }, 'Show e-invite with QR code')))
      f.name.value = ''
      loadList()
      showInvite(p.id)
    } catch (err) { showError(err) }
  }
  const field = (label, input) => el('div', { class: 'field' }, el('label', {}, label), input)
  clear(main, el('h1', {}, 'Party setup'),
    el('div', { class: 'grid' },
      el('div', { class: 'card' }, el('h2', {}, 'New party'),
        field('Party name', f.name), field('Room', f.room), field('Date', f.date),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, field('Start', f.startTime)), el('div', { class: 'grow' }, field('End', f.endTime))),
        field('Expected guests (adults + kids)', f.expectedGuests), field('Host name', f.hostName), field('Host phone', f.hostPhone), field('StoreHub receipt', f.receiptNo),
        el('button', { class: 'primary', style: { width: '100%' }, onclick: create }, 'Create party & invite code'), result),
      el('div', { class: 'card' }, el('div', { class: 'row' }, el('h2', { class: 'grow', style: { margin: 0 } }, 'Parties'), el('div', { style: { width: '190px' } }, listDate)), list)))
  await loadList()
}

// ------------------------------------------------------------ live dashboard (supervisor)

async function dashboard(main) {
  const body = el('div', { class: 'stack' })
  clear(main, el('h1', {}, 'Live dashboard'), body)
  const render = async () => {
    const d = await api('/api/dashboard')
    setTimeContext(state.meta.timeZone, d.now)
    const c = d.capacity
    const groupRow = g => el('li', { class: 'clickable', onclick: () => (location.hash = `#/group/${g.id}`) },
      el('div', { class: 'grow' }, el('strong', {}, g.partyName ?? `Group ${g.id}`), el('div', { class: 'small muted' }, `${g.type === 'party' ? 'Party' : `Table ${g.tableNo ?? '—'}`} · receipt ${g.receiptNo ?? '—'} · ${g.counts.inside} inside`)),
      phaseBadge(g.phase),
      g.phase === 'playing' ? el('span', { class: 'badge' }, `${fmtDuration(g.msLeft)} left`) : null)
    clear(body,
      d.fire ? el('div', { class: 'fire-banner' }, 'FIRE ALARM — ALL GATES OPEN') : null,
      el('div', { class: 'grid' },
        el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Inside now'), el('div', { class: 'stat' }, d.inside.total),
          el('div', { class: 'row small' }, el('span', { class: 'badge adult' }, `${d.inside.adult} adults`), el('span', { class: 'badge kid' }, `${d.inside.kid} kids`), el('span', { class: 'badge under2' }, `${d.inside.under2} under 2`))),
        el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Capacity used'), el('div', { class: 'stat' }, `${c.percent}%`),
          el('div', { class: 'small muted' }, `${c.occupancy} of ${c.capacity} (${c.pending} activated, not in yet)`),
          el('div', { class: `meter ${c.full ? 'bad' : c.warn ? 'warn' : ''}` }, el('div', { style: { width: `${Math.min(100, c.percent)}%` } }))),
        el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Gates'),
          d.lanes.map(l => el('div', { class: 'row', style: { marginTop: '8px' } },
            el('strong', { style: { width: '44px' } }, l.lane.toUpperCase()),
            el('span', { class: `badge ${l.held ? 'warn' : 'ok'} grow` }, l.held ? (d.fire ? 'Fire: open' : 'Held open') : 'Normal'),
            el('button', { class: 'small', onclick: () => laneOpen(l.lane) }, 'Open once'),
            el('button', { class: 'small', onclick: () => laneMode(l.lane, l.mode === 'held_open' ? 'normal' : 'held_open') }, l.mode === 'held_open' ? 'Back to normal' : 'Hold open'))))),
      el('div', { class: 'grid' },
        el('div', { class: 'card' }, el('h3', {}, `Overtime — exit held (${d.overtime.length})`),
          el('ul', { class: 'list' }, d.overtime.length ? d.overtime.map(g => el('li', { class: 'clickable', onclick: () => (location.hash = `#/group/${g.id}`) },
            el('div', { class: 'grow' }, el('strong', {}, g.partyName ?? `Group ${g.id}`), el('div', { class: 'small muted' }, `Receipt ${g.receiptNo ?? '—'} · table ${g.tableNo ?? '—'}`)),
            g.atGate ? el('span', { class: 'badge bad' }, 'AT GATE') : null,
            el('span', { class: 'badge bad' }, `${plural(g.blocksOwed, 'block')} × ${plural(g.counts.kidsInside, 'kid')} = ${rm(g.amountOwed)}`))) : el('li', { class: 'empty' }, 'None'))),
        el('div', { class: 'card' }, el('h3', {}, `Kids blocked at the gate (${d.blockedKids.length})`),
          el('ul', { class: 'list' }, d.blockedKids.length ? d.blockedKids.map(k => el('li', { class: 'clickable', onclick: () => (location.hash = `#/group/${k.groupId}`) },
            el('span', { class: 'mono grow' }, k.barcode), el('span', { class: 'small muted' }, `Group ${k.groupId} · ${fmtTime(k.at)}`))) : el('li', { class: 'empty' }, 'None'))),
        el('div', { class: 'card' }, el('h3', {}, `Ending in the next 15 minutes (${d.endingSoon.length})`),
          el('ul', { class: 'list' }, d.endingSoon.length ? d.endingSoon.map(groupRow) : el('li', { class: 'empty' }, 'None'))),
        el('div', { class: 'card' }, el('h3', {}, 'Parties'),
          el('ul', { class: 'list' }, d.parties.length ? d.parties.map(p => el('li', { class: 'clickable', onclick: () => (location.hash = `#/group/${p.groupId}`) },
            el('div', { class: 'grow' }, el('strong', {}, p.name), el('div', { class: 'small muted' }, `${p.room} · ${fmtTime(p.startAt)}–${fmtTime(p.endAt)}`)),
            el('span', { class: `badge ${p.running ? 'ok' : ''}` }, p.running ? 'Running' : 'Upcoming'), el('span', { class: 'badge' }, `${p.inside} in · ${p.checkedIn.total}/${p.expectedGuests}`))) : el('li', { class: 'empty' }, 'None')))),
      el('div', { class: 'card' }, el('h3', {}, `All active groups (${d.groups.length})`), el('ul', { class: 'list' }, d.groups.length ? d.groups.map(groupRow) : el('li', { class: 'empty' }, 'None'))),
      el('div', { class: 'card' }, el('h3', {}, 'Recent gate alerts'), el('ul', { class: 'list' }, d.alerts.length ? d.alerts.map(a => el('li', {},
        el('span', { class: 'small muted' }, fmtTime(a.at)), el('span', { class: 'badge' }, a.lane.toUpperCase()), el('span', { class: 'mono' }, a.barcode), el('span', { class: 'grow' }, a.message))) : el('li', { class: 'empty' }, 'None'))),
    )
  }
  await render()
  autoRefresh(() => render().catch(showError))
}

async function laneOpen(lane) {
  const r = await ask({ title: `Open ${lane.toUpperCase()} gate once`, fields: [{ name: 'reason', label: 'Reason', required: true }], confirm: 'Open gate' })
  if (r) await api(`/api/lanes/${lane}/open`, { body: r }).then(() => toast('Gate opened', 'ok')).catch(showError)
}

async function laneMode(lane, mode) {
  const r = await ask({
    title: mode === 'held_open' ? `Hold ${lane.toUpperCase()} gate open` : `Return ${lane.toUpperCase()} gate to normal`,
    message: mode === 'held_open' ? 'The gate stays open until you set it back to normal. Use when a reader fails and you are scanning with the handheld, or for an emergency.' : null,
    fields: [{ name: 'reason', label: 'Reason', required: true }],
  })
  if (r) await api(`/api/lanes/${lane}/mode`, { body: { mode, reason: r.reason } }).catch(showError)
}

// ------------------------------------------------------------ group detail (supervisor)

async function groupDetail(main, id) {
  const body = el('div', { class: 'stack' })
  clear(main, body)
  const render = async () => {
    const g = await api(`/api/groups/${id}`)
    const override = can('group.override')
    clear(body,
      el('div', { class: 'row' }, el('h1', { class: 'grow', style: { margin: 0 } }, g.partyName ?? `Group ${g.id}`), phaseBadge(g.phase)),
      el('div', { class: 'grid' },
        el('div', { class: 'card' }, el('div', { class: 'stat-label' }, g.phase === 'not_started' ? 'Timer' : g.msLeft >= 0 ? 'Time left' : 'Over time by'),
          el('div', { class: 'stat' }, g.phase === 'not_started' ? 'Not started' : fmtDuration(Math.abs(g.msLeft))),
          el('div', { class: 'small muted' }, `First scan ${fmtTime(g.firstScanAt)} · ends ${fmtTime(g.effectiveEnd)}${g.extensionMinutes ? ` (+${g.extensionMinutes} min extended)` : ''}`)),
        el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Overtime due'),
          el('div', { class: 'stat' }, rm(g.amountOwed)),
          el('div', { class: 'small muted' }, `${plural(g.blocksOwed, 'block')} × ${plural(g.counts.kidsInside, 'kid')} inside${g.blocksPaid ? ` · ${g.blocksPaid} block(s) already paid` : ''}`)),
        el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'People'),
          el('div', { class: 'stat' }, `${g.counts.inside} / ${g.counts.total}`), el('div', { class: 'small muted' }, `inside now · ${plural(g.counts.adult, 'adult')}, ${plural(g.counts.kid, 'kid')}, ${g.counts.under2} under 2`),
          el('div', { class: 'small muted' }, `${g.type === 'party' ? 'Party' : 'Walk-in'} · receipt ${g.receiptNo ?? '—'} · table ${g.tableNo ?? '—'}`))),
      override && g.status === 'active' ? el('div', { class: 'row' },
        el('button', { class: g.exitLocked ? 'danger' : '', onclick: () => clearGroup(g) }, g.amountOwed ? `Overtime paid — clear (${rm(g.amountOwed)})` : 'Clear group to leave'),
        el('button', { onclick: () => extend(g) }, 'Extend time'),
        el('button', { onclick: () => closeGroup(g) }, 'Close group')) : null,
      el('div', { class: 'card' }, el('h3', {}, 'Bands'), el('ul', { class: 'list' }, g.bands.map(b => el('li', {},
        bandBadge(b.type), el('span', { class: 'mono grow' }, b.barcode),
        el('span', { class: `badge ${b.inside ? 'ok' : ''}` }, b.status !== 'active' ? b.status : b.inside ? 'Inside' : b.firstInAt ? 'Out' : 'Not in yet'),
        override ? el('button', { class: 'small', onclick: () => release(b) }, 'Let through…') : null)))),
      el('div', { class: 'card' }, el('h3', {}, 'Scan history'), el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Lane'), el('th', {}, 'Band'), el('th', {}, 'Result'))),
        el('tbody', {}, g.scans.map(s => el('tr', {}, el('td', {}, fmtTime(s.at)), el('td', {}, s.lane.toUpperCase()), el('td', { class: 'mono' }, s.barcode),
          el('td', {}, el('span', { class: `badge ${s.result === 'opened' ? 'ok' : 'bad'}` }, s.message), s.source !== 'reader' ? el('span', { class: 'small muted' }, ` ${s.source}`) : null))))))),
      g.overrides.length || g.payments.length ? el('div', { class: 'card' }, el('h3', {}, 'Overrides & payments'), el('ul', { class: 'list' },
        g.payments.map(p => el('li', {}, el('span', { class: 'small muted' }, fmtTime(p.at)), el('span', { class: 'grow' }, `Overtime ${p.blocks} block(s) × ${p.kids} = ${rm(p.amount)} · receipt ${p.receiptNo ?? '—'}`), el('span', {}, p.staff))),
        g.overrides.map(o => el('li', {}, el('span', { class: 'small muted' }, fmtTime(o.at)), el('span', { class: 'grow' }, `${o.action.replace(/_/g, ' ')}${o.barcode ? ` ${o.barcode}` : ''} — ${o.reason}`), el('span', {}, o.staff))))) : null,
    )
  }
  const act = fn => async (...a) => { try { await fn(...a); await render() } catch (err) { showError(err) } }
  const clearGroup = act(async g => {
    const r = await ask({
      title: 'Clear group to leave',
      message: g.amountOwed ? `Take ${rm(g.amountOwed)} in StoreHub first (${g.blocksOwed} block × ${g.counts.kidsInside} kids), then enter the receipt.` : 'No overtime is due.',
      fields: [...(g.amountOwed ? [{ name: 'receiptNo', label: 'StoreHub receipt number', required: true }] : []), { name: 'reason', label: 'Note', required: true, value: g.amountOwed ? 'Overtime paid' : '' }],
      confirm: 'Clear & open exit',
    })
    if (!r) return
    const res = await api(`/api/groups/${id}/clear`, { body: r })
    toast(res.amount ? `Cleared — ${rm(res.amount)} recorded` : 'Cleared', 'ok')
  })
  const extend = act(async () => {
    const r = await ask({ title: 'Extend play time', fields: [{ name: 'minutes', label: 'Minutes', type: 'number', required: true, value: 15, min: 1 }, { name: 'reason', label: 'Reason', required: true }], confirm: 'Extend' })
    if (r) await api(`/api/groups/${id}/extend`, { body: r })
  })
  const closeGroup = act(async () => {
    const r = await ask({ title: 'Close this group?', message: 'All its bands stop working. Anyone still inside can still leave.', fields: [{ name: 'reason', label: 'Reason', required: true }], confirm: 'Close group', danger: true })
    if (r) await api(`/api/groups/${id}/close`, { body: r })
  })
  const release = act(async b => {
    const r = await ask({ title: `Let ${b.barcode} through`, fields: [
      { name: 'lane', label: 'Gate', options: [{ value: 'out', label: 'OUT' }, { value: 'in', label: 'IN' }], value: b.inside ? 'out' : 'in' },
      { name: 'reason', label: 'Reason', required: true }], confirm: 'Open gate' })
    if (r) await api(`/api/bands/${encodeURIComponent(b.barcode)}/release`, { body: r })
  })
  await render()
  autoRefresh(() => render().catch(showError), 10000)
}

// ------------------------------------------------------------ handheld backup scanner

function handheld(main) {
  let lane = 'out'
  const laneBtns = ['in', 'out'].map(l => el('button', { class: 'toggle grow', 'aria-pressed': String(l === lane), onclick: () => {
    lane = l
    laneBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(['in', 'out'][i] === lane)))
    input.focus()
  } }, `${l.toUpperCase()} gate`))
  const input = el('input', { class: 'scan', placeholder: 'Scan band…', autocomplete: 'off' })
  const result = el('div')
  input.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || !input.value.trim()) return
    const barcode = input.value.trim()
    input.value = ''
    try {
      const d = await api(`/api/lanes/${lane}/scan`, { body: { barcode, source: 'handheld' } })
      clear(result, el('div', { class: `decision ${d.color}` }, d.message, el('div', { class: 'small mono' }, `${d.barcode} · ${lane.toUpperCase()}`)))
      if (!d.open) navigator.vibrate?.([200, 100, 200])
    } catch (err) { showError(err) }
  })
  clear(main, el('h1', {}, 'Handheld gate scan'),
    el('p', { class: 'muted' }, 'Use when a gate reader fails. The same rules apply and the gate opens automatically when allowed.'),
    el('div', { class: 'card stack' }, el('div', { class: 'row' }, laneBtns), input, result,
      el('button', { onclick: () => laneOpen(lane) }, 'Open this gate once (no band)…')))
  input.focus()
}

// ------------------------------------------------------------ packages

async function packages(main, accountId) {
  if (accountId) return packageDetail(main, Number(accountId))
  const phone = el('input', { type: 'tel', inputmode: 'tel', placeholder: 'Phone number' })
  const results = el('ul', { class: 'list' })
  const search = async () => {
    try {
      const rows = await api(`/api/packages?phone=${encodeURIComponent(phone.value)}`)
      clear(results, rows.length ? rows.map(r => el('li', { class: 'clickable', onclick: () => (location.hash = `#/packages/${r.id}`) },
        el('strong', { class: 'grow' }, r.name), el('span', {}, r.phone), el('span', { class: `badge ${r.visitsLeft ? 'ok' : ''}` }, `${r.visitsLeft} visits left`))) : el('li', { class: 'empty' }, 'No accounts found'))
    } catch (err) { showError(err) }
  }
  phone.addEventListener('keydown', e => e.key === 'Enter' && search())
  const nf = { name: el('input', {}), phone: el('input', { type: 'tel', inputmode: 'tel' }), receiptNo: el('input', {}) }
  const create = async () => {
    try {
      const a = await api('/api/packages', { body: { name: nf.name.value, phone: nf.phone.value, receiptNo: nf.receiptNo.value } })
      toast(`Package created: ${a.visitsLeft} visits`, 'ok')
      location.hash = `#/packages/${a.id}`
    } catch (err) { showError(err) }
  }
  clear(main, el('h1', {}, 'Packages'),
    el('div', { class: 'grid' },
      el('div', { class: 'card' }, el('h2', {}, 'Find account'), el('div', { class: 'row' }, el('div', { class: 'grow' }, phone), el('button', { class: 'primary', onclick: search }, 'Search')), results),
      el('div', { class: 'card' }, el('h2', {}, 'New package account'),
        el('p', { class: 'muted small' }, `Sell the package in StoreHub first. The account starts with ${state.settings.packageVisits} visits.`),
        el('div', { class: 'field' }, el('label', {}, 'Name'), nf.name), el('div', { class: 'field' }, el('label', {}, 'Phone'), nf.phone),
        el('div', { class: 'field' }, el('label', {}, 'StoreHub receipt number'), nf.receiptNo),
        el('button', { class: 'primary', style: { width: '100%' }, onclick: create }, 'Create account'))))
  phone.focus()
}

async function packageDetail(main, id) {
  const a = await api(`/api/packages/${id}`)
  const KIND = { purchase: 'Package bought', visit: 'Visit', transfer_out: 'Transferred out', transfer_in: 'Transferred in' }
  const transfer = async () => {
    const r = await ask({ title: 'Transfer remaining visits', message: `Moves all ${a.visitsLeft} visits. Take the RM ${state.settings.packageTransferFee} fee in StoreHub first.`, fields: [
      { name: 'name', label: 'New holder name', required: true }, { name: 'phone', label: 'New holder phone', type: 'tel', required: true },
      { name: 'receiptNo', label: 'StoreHub receipt for the fee', required: true }, { name: 'reason', label: 'Reason', required: true }], confirm: 'Approve transfer' })
    if (!r) return
    try {
      const existing = await api(`/api/packages?phone=${encodeURIComponent(r.phone)}`)
      const target = existing.find(x => x.id !== a.id && x.name.toLowerCase() === r.name.toLowerCase())
      const res = await api(`/api/packages/${id}/transfer`, { body: { ...(target ? { toAccountId: target.id } : { newAccount: { name: r.name, phone: r.phone } }), receiptNo: r.receiptNo, reason: r.reason } })
      toast(`${res.visits} visits moved`, 'ok')
      location.hash = `#/packages/${res.toId}`
    } catch (err) { showError(err) }
  }
  clear(main,
    el('h1', {}, a.name),
    el('div', { class: 'grid' },
      el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Visits left'), el('div', { class: 'stat' }, a.visitsLeft),
        el('div', { class: 'small muted' }, `${a.phone}${a.expiresAt ? ` · expires ${fmtDateTime(a.expiresAt)}` : ''}${a.expired ? ' · EXPIRED' : ''}`)),
      el('div', { class: 'card stack' },
        el('p', { class: 'muted small', style: { margin: 0 } }, 'Visits are normally deducted when you start a group on Activate bands.'),
        can('package.transfer') && a.visitsLeft > 0 ? el('button', { onclick: transfer }, 'Transfer to someone else…') : null,
        !can('package.transfer') ? el('p', { class: 'small muted' }, 'Transfers need a manager.') : null)),
    el('div', { class: 'card', style: { marginTop: '16px' } }, el('h3', {}, 'History'), el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'What'), el('th', { class: 'num' }, 'Visits'), el('th', {}, 'Details'), el('th', {}, 'Staff'))),
      el('tbody', {}, a.history.map(h => el('tr', {}, el('td', {}, fmtDateTime(h.at)), el('td', {}, KIND[h.kind] ?? h.kind), el('td', { class: 'num' }, h.delta > 0 ? `+${h.delta}` : h.delta),
        el('td', { class: 'small' }, [h.groupId ? `group ${h.groupId}` : '', h.counterpartyAccountId ? `account ${h.counterpartyAccountId}` : '', h.receiptNo ? `receipt ${h.receiptNo}` : '', h.note ?? ''].filter(Boolean).join(' · ')),
        el('td', {}, h.staff))))))),
    el('div', { class: 'row', style: { marginTop: '16px' } }, el('a', { class: 'btn', href: '#/packages' }, 'Back')))
}

// ------------------------------------------------------------ settings (manager)

const SETTINGS_FORM = [
  ['Play time', [
    ['sessionMinutes', 'Session length (minutes)', 'number'],
    ['graceMinutes', 'Grace period for walk-ins (minutes)', 'number'],
    ['overtimeBlockMinutes', 'Overtime block (minutes)', 'number'],
    ['overtimeBlockPrice', 'Overtime price per kid per block (RM)', 'number'],
    ['overtimeChargesUnder2', 'Charge overtime for under-2s', 'checkbox'],
    ['clearExitWindowMinutes', 'Exit stays open after clearing (minutes)', 'number'],
    ['kidExitWindowSeconds', 'Kids exit window after an adult (seconds)', 'number'],
    ['antiPassback', 'Refuse IN scan for a band already inside', 'checkbox'],
  ]],
  ['Prices (for reports; payment happens in StoreHub)', [
    ['playPassPrice.weekday', 'Kid play pass, weekday (RM)', 'number'],
    ['playPassPrice.weekend', 'Kid play pass, weekend & public holiday (RM)', 'number'],
  ]],
  ['Capacity', [
    ['capacity', 'Paid zone capacity (people)', 'number'],
    ['capacityWarnPercent', 'Warn at (% of capacity)', 'number'],
  ]],
  ['Bands', [
    ['bandPrefixes.adult', 'Adult barcode prefix', 'text'],
    ['bandPrefixes.kid', 'Kid barcode prefix', 'text'],
    ['bandPrefixes.under2', 'Under-2 barcode prefix (if a separate roll)', 'text'],
    ['bandColours.adult', 'Adult band colour', 'text'],
    ['bandColours.kid', 'Kid band colour', 'text'],
  ]],
  ['Birthday parties', [
    ['partyRooms', 'Rooms (one per line)', 'list'],
    ['partyBlockMinutes', 'Default party length (minutes)', 'number'],
    ['partyGraceMinutes', 'Grace after party ends (minutes)', 'number'],
    ['partyEarlyEntryMinutes', 'Guests may enter early by (minutes)', 'number'],
  ]],
  ['Visit packages', [
    ['packageVisits', 'Visits per package', 'number'],
    ['packagePrice', 'Package price (RM, for reference)', 'number?'],
    ['packageExpiryMonths', 'Expiry (months, 0 = never)', 'number'],
    ['packageWeekdayOnly', 'Weekdays only', 'checkbox'],
    ['packageTransferFee', 'Transfer fee (RM)', 'number'],
  ]],
  ['Venue', [
    ['venueName', 'Venue name', 'text'],
    ['openingHours.weekday.open', 'Weekday opening', 'time'],
    ['openingHours.weekday.close', 'Weekday closing', 'time'],
    ['openingHours.weekend.open', 'Weekend opening', 'time'],
    ['openingHours.weekend.close', 'Weekend closing', 'time'],
    ['endOfDayTime', 'Close all groups at (end of day)', 'time'],
    ['publicHolidays', 'Public holidays (YYYY-MM-DD, one per line)', 'list'],
  ]],
]

async function settingsScreen(main) {
  const s = await api('/api/settings')
  const get = path => path.split('.').reduce((o, k) => o?.[k], s)
  const inputs = []
  const sections = SETTINGS_FORM.map(([title, fields]) => el('div', { class: 'card' }, el('h2', {}, title), fields.map(([path, label, type]) => {
    const v = get(path)
    let input
    if (type === 'checkbox') input = el('input', { type: 'checkbox', checked: v })
    else if (type === 'list') input = el('textarea', { rows: 3 }, (v ?? []).join('\n'))
    else input = el('input', { type: type.replace('?', ''), value: v ?? '', step: 'any' })
    inputs.push({ path, type, input })
    return type === 'checkbox' ? el('label', { class: 'check' }, input, label) : el('div', { class: 'field' }, el('label', {}, label), input)
  })))
  const save = async () => {
    const patch = {}
    for (const { path, type, input } of inputs) {
      let value
      if (type === 'checkbox') value = input.checked
      else if (type === 'list') value = input.value.split('\n').map(x => x.trim()).filter(Boolean)
      else if (type === 'number') value = Number(input.value)
      else if (type === 'number?') value = input.value === '' ? null : Number(input.value)
      else value = input.value
      const keys = path.split('.')
      let o = patch
      keys.slice(0, -1).forEach(k => (o = o[k] ??= {}))
      o[keys.at(-1)] = value
    }
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: patch })
      toast('Settings saved', 'ok')
    } catch (err) { showError(err) }
  }
  clear(main, el('div', { class: 'row' }, el('h1', { class: 'grow', style: { margin: 0 } }, 'Settings'), el('button', { class: 'primary', onclick: save }, 'Save all')),
    el('p', { class: 'muted' }, 'Every change is recorded in the audit log with your name.'),
    el('div', { class: 'grid' }, sections),
    el('div', { class: 'row', style: { marginTop: '16px' } }, el('button', { class: 'primary', onclick: save }, 'Save all')))
}

// ------------------------------------------------------------ staff (manager)

async function staffScreen(main) {
  const roles = state.meta.roles
  const list = el('ul', { class: 'list' })
  const load = async () => {
    const staff = await api('/api/staff')
    clear(list, staff.map(s => el('li', {},
      el('strong', { class: 'grow' }, s.name), el('span', { class: 'badge' }, roles.find(r => r.id === s.role)?.label ?? s.role),
      el('span', { class: `badge ${s.active ? 'ok' : 'bad'}` }, s.active ? 'Active' : 'Disabled'),
      el('button', { class: 'small', onclick: () => edit(s) }, 'Edit'))))
  }
  const edit = async s => {
    const r = await ask({ title: s ? `Edit ${s.name}` : 'Add staff member', fields: [
      { name: 'name', label: 'Name', required: true, value: s?.name ?? '' },
      { name: 'role', label: 'Role', options: roles.map(x => ({ value: x.id, label: x.label })), value: s?.role ?? 'cashier' },
      { name: 'pin', label: s ? 'New PIN (leave empty to keep)' : 'PIN (4–8 digits)', type: 'password', inputmode: 'numeric', required: !s },
      ...(s ? [{ name: 'active', label: 'Status', options: [{ value: 'yes', label: 'Active' }, { value: 'no', label: 'Disabled' }], value: s.active ? 'yes' : 'no' }] : []),
    ], confirm: 'Save' })
    if (!r) return
    try {
      if (s) await api(`/api/staff/${s.id}`, { method: 'PUT', body: { name: r.name, role: r.role, pin: r.pin || undefined, active: r.active === 'yes' } })
      else await api('/api/staff', { body: r })
      toast('Saved', 'ok')
      load()
    } catch (err) { showError(err) }
  }
  clear(main, el('div', { class: 'row' }, el('h1', { class: 'grow', style: { margin: 0 } }, 'Staff'), el('button', { class: 'primary', onclick: () => edit(null) }, 'Add staff')),
    el('p', { class: 'muted' }, 'Everyone logs in with their own PIN so every action is traceable.'),
    el('div', { class: 'card' }, list))
  await load()
}

// ------------------------------------------------------------ reports (manager)

async function reports(main) {
  const date = el('input', { type: 'date', value: todayLocal() })
  const body = el('div', { class: 'stack' })
  const load = async () => {
    const r = await api(`/api/reports/daily?date=${date.value}`)
    const maxHour = Math.max(1, ...r.visitsByHour.map(h => h.people))
    // Opening hours always show; earlier or later hours only when someone actually entered then.
    const hours = r.visitsByHour.filter(h => h.people > 0 || (h.hour >= 9 && h.hour <= 23))
    const stat = (label, value, sub) => el('div', { class: 'card' }, el('div', { class: 'stat-label' }, label), el('div', { class: 'stat' }, value), sub ? el('div', { class: 'small muted' }, sub) : null)
    clear(body,
      el('div', { class: 'grid' },
        stat('Visitors', r.people.total, `${r.people.adult} adults · ${r.people.kid} kids · ${r.people.under2} under 2 · ${r.dayType}`),
        stat('Walk-in vs party', `${r.people.walkin} / ${r.people.party}`, `${r.groups.walkin} walk-in groups · ${r.groups.party} parties`),
        stat('Average stay', r.averageStayMinutes === null ? '—' : fmtDuration(r.averageStayMinutes * 60000), 'groups that have left'),
        stat('Peak headcount', r.peak.headcount, r.peak.at ? `at ${fmtTime(r.peak.at)}` : ''),
        stat('Overtime', rm(r.overtime.amount), `${r.overtime.groups} groups · ${r.overtime.blocks} blocks — match against StoreHub`),
        stat('Play passes expected in StoreHub', rm(r.playPasses.expectedStoreHubTotal), `${r.playPasses.paidWalkinKids} walk-in kids × ${rm(r.playPasses.price)}`),
        stat('Kids blocked at the gate', r.gate.kidsBlocked, `${r.gate.scans} scans · ${r.gate.refused} refused`),
        stat('Package visits used', r.packages.visitsUsed, `${r.packages.sold} sold · ${r.packages.transfers.length} transfers`)),
      el('div', { class: 'card' }, el('h3', {}, 'Visitors by hour of entry'), el('div', { class: 'bars' }, hours.map(h => el('div', { class: 'bar-row' },
        el('span', { class: 'muted' }, `${String(h.hour).padStart(2, '0')}:00`), el('div', {}, el('div', { class: 'bar', style: { width: `${(h.people / maxHour) * 100}%` } })), el('span', { class: 'num' }, h.people))))),
      el('div', { class: 'card' }, el('h3', {}, 'Overtime collected'), r.overtime.items.length ? el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Group'), el('th', { class: 'num' }, 'Blocks'), el('th', { class: 'num' }, 'Kids'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Receipt'), el('th', {}, 'Staff'))),
        el('tbody', {}, r.overtime.items.map(o => el('tr', {}, el('td', {}, fmtTime(o.at)), el('td', {}, el('a', { href: `#/group/${o.groupId}` }, o.groupId)), el('td', { class: 'num' }, o.blocks), el('td', { class: 'num' }, o.kids), el('td', { class: 'num' }, rm(o.amount)), el('td', {}, o.receiptNo ?? '—'), el('td', {}, o.staff))))))
        : el('p', { class: 'empty' }, 'None')),
      el('div', { class: 'card' }, el('h3', {}, 'Overrides'), r.overrides.length ? el('ul', { class: 'list' }, r.overrides.map(o => el('li', {},
        el('span', { class: 'small muted' }, fmtTime(o.at)), el('strong', {}, o.staff), el('span', { class: 'grow' }, `${o.action.replace(/_/g, ' ')}${o.lane ? ` (${o.lane})` : ''}${o.groupId ? ` · group ${o.groupId}` : ''} — ${o.reason}`)))) : el('p', { class: 'empty' }, 'None')),
      el('div', { class: 'card' }, el('h3', {}, 'Package balances'), r.packages.balances.length ? el('ul', { class: 'list' }, r.packages.balances.map(b => el('li', {},
        el('a', { class: 'grow', href: `#/packages/${b.id}` }, b.name), el('span', {}, b.phone), el('span', { class: 'badge' }, `${b.visitsLeft} left`)))) : el('p', { class: 'empty' }, 'None')),
    )
  }
  date.addEventListener('change', () => load().catch(showError))
  clear(main, el('h1', {}, 'Reports'),
    el('div', { class: 'card row' },
      el('div', { style: { width: '200px' } }, date),
      el('button', { onclick: () => download(`/api/reports/daily.csv?date=${date.value}`, `naru-daily-${date.value}.csv`).catch(showError) }, 'Daily summary CSV'),
      el('button', { onclick: () => download(`/api/reports/scans.csv?date=${date.value}`, `naru-scans-${date.value}.csv`).catch(showError) }, 'All scans CSV'),
      can('data.export') ? el('button', { onclick: () => download('/api/export', `naru-export-${date.value}.json`).catch(showError) }, 'Export all data') : null),
    el('p', { class: 'small muted' }, 'CSV files open directly in Google Sheets (File → Import) or Excel.'),
    body)
  await load()
}

boot().catch(err => {
  clear(app, el('main', {}, el('div', { class: 'banner bad' }, `Cannot reach the access server: ${err.message}`)))
})
