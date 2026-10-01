import { api, BAND_LABEL, clear, el, fmtTime, liveSocket, serverNow, setTimeContext, showError, toast } from './lib.js'

const root = document.getElementById('sim')
const meta = await api('/api/meta')
setTimeContext(meta.timeZone, meta.now)

const clockText = el('div', { class: 'clock' })
const fireBtn = el('button', { class: 'danger' }, 'Trigger fire alarm')
const log = el('ul', { class: 'list log' })
const bandsBox = el('div')
let fire = false
let refreshTimer = null

function lanePanel(lane) {
  const gate = el('div', { class: 'gate' }, el('div', { class: 'post l' }), el('div', { class: 'flap l' }), el('div', { class: 'flap r' }), el('div', { class: 'post r' }),
    el('div', { class: 'dir' }, lane === 'in' ? 'free zone → paid zone' : 'paid zone → free zone'))
  const screen = el('div', { class: 'screen' }, 'Scan your band')
  const input = el('input', { class: 'scan', placeholder: `Type a barcode and press Enter`, autocomplete: 'off' })
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && input.value.trim()) {
      scan(lane, input.value.trim())
      input.value = ''
    }
  })
  let held = false
  let timer
  return {
    node: el('div', { class: 'card' }, el('h2', {}, `${lane.toUpperCase()} lane`), gate, screen, el('div', { style: { marginTop: '10px' } }, input)),
    decision(d) {
      if (held) return
      screen.className = `screen ${d.color}`
      screen.textContent = d.message
      if (d.open) gate.classList.add('open')
      clearTimeout(timer)
      timer = setTimeout(() => {
        gate.classList.toggle('open', held)
        screen.className = 'screen'
        screen.textContent = 'Scan your band'
      }, d.open ? 2500 : 4000)
    },
    hold(isHeld, isFire) {
      held = isHeld
      gate.classList.toggle('open', isHeld)
      screen.className = `screen ${isFire ? 'red' : isHeld ? 'held' : ''}`
      screen.textContent = isFire ? 'Emergency — gates open' : isHeld ? 'Gate held open' : 'Scan your band'
    },
  }
}

const lanes = { in: lanePanel('in'), out: lanePanel('out') }

async function scan(lane, barcode) {
  try {
    await api(`/api/lanes/${lane}/scan`, { body: { barcode } })
  } catch (err) { showError(err) }
}

async function advance(minutes) {
  try {
    const r = await api('/api/sim/clock', { body: { advanceMinutes: minutes } })
    setTimeContext(meta.timeZone, r.now)
    tickClock()
    refresh()
  } catch (err) { showError(err) }
}

function tickClock() {
  clockText.textContent = fmtTime(serverNow())
}

async function refresh() {
  const s = await api('/api/sim/state')
  setTimeContext(meta.timeZone, s.now)
  tickClock()
  fire = s.fire
  fireBtn.textContent = fire ? 'Reset fire alarm' : 'Trigger fire alarm'
  const groups = new Map()
  for (const b of s.bands) {
    if (!groups.has(b.groupId)) groups.set(b.groupId, [])
    groups.get(b.groupId).push(b)
  }
  clear(bandsBox, groups.size ? [...groups.entries()].map(([gid, bands]) => el('div', { class: 'band-group' },
    el('div', { class: 'row small muted' }, el('strong', {}, bands[0].partyName ?? `Group ${gid}`), bands[0].groupType === 'party' ? el('span', { class: 'badge' }, 'party') : null,
      el('a', { href: `/#/group/${gid}`, target: '_blank' }, 'detail')),
    bands.map(b => el('div', { class: 'band-row' },
      el('span', { class: `badge ${b.type}` }, BAND_LABEL[b.type]), el('span', { class: 'mono' }, b.barcode),
      el('span', { class: `badge ${b.inside ? 'ok' : ''}` }, b.inside ? 'inside' : b.firstInAt ? 'out' : 'not in yet'),
      el('button', { class: 'small', onclick: () => scan('in', b.barcode) }, 'Scan IN'),
      el('button', { class: 'small', onclick: () => scan('out', b.barcode) }, 'Scan OUT'))))) : el('p', { class: 'empty' }, 'No active bands. Add a family above or activate bands in the staff app.'))
}

fireBtn.onclick = async () => {
  try { await api('/api/sim/fire', { body: { active: !fire } }) } catch (err) { showError(err) }
}

const famAdults = el('input', { type: 'number', min: 0, max: 6, value: 2, style: { width: '90px' } })
const famKids = el('input', { type: 'number', min: 0, max: 8, value: 3, style: { width: '90px' } })
const setTime = el('input', { type: 'time', style: { width: '150px' } })

clear(root,
  el('div', { class: 'grid' },
    el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Simulated venue time'), clockText,
      el('div', { class: 'row', style: { marginTop: '10px' } },
        [1, 5, 15, 30, 60].map(m => el('button', { class: 'small', onclick: () => advance(m) }, m < 60 ? `+${m} min` : '+1 hour'))),
      el('div', { class: 'row', style: { marginTop: '10px' } }, setTime, el('button', { class: 'small', onclick: async () => {
        if (!setTime.value) return
        const now = serverNow()
        const [h, m] = setTime.value.split(':').map(Number)
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: meta.timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now)
        const cur = Number(parts.find(p => p.type === 'hour').value) * 60 + Number(parts.find(p => p.type === 'minute').value)
        const diff = h * 60 + m - cur
        if (diff < 0) return toast('Time can only move forward in the simulator', 'warn')
        advance(diff)
      } }, 'Jump to time'))),
    el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'New walk-in family (activated as if by the cashier)'),
      el('div', { class: 'row', style: { marginTop: '10px' } }, el('label', { style: { margin: 0 } }, 'Adults'), famAdults, el('label', { style: { margin: 0 } }, 'Kids'), famKids,
        el('button', { class: 'primary', onclick: async () => {
          try {
            const r = await api('/api/sim/family', { body: { adults: Number(famAdults.value), kids: Number(famKids.value) } })
            toast(`Group ${r.groupId}: ${r.bands.join(', ')}`, 'ok')
            refresh()
          } catch (err) { showError(err) }
        } }, 'Add family'))),
    el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Safety'), el('p', { class: 'small muted' }, 'In the venue the fire panel opens the gates through a hard-wired input. This simulates that signal.'), fireBtn)),
  el('div', { class: 'lanes' }, lanes.in.node, lanes.out.node),
  el('div', { class: 'grid' },
    el('div', { class: 'card' }, el('h2', {}, 'Bands'), bandsBox),
    el('div', { class: 'card' }, el('h2', {}, 'Gate log'), log)),
)

liveSocket('sim=1', msg => {
  if (msg.type === 'gate') {
    lanes[msg.lane].decision(msg.decision)
    const d = msg.decision
    log.prepend(el('li', {}, el('span', { class: 'small muted' }, fmtTime(d.at)), el('span', { class: 'badge' }, d.lane.toUpperCase()),
      el('span', { class: 'mono' }, d.barcode || '(staff)'), el('span', { class: `badge ${d.open ? 'ok' : 'bad'}` }, d.message), el('span', { class: 'small muted' }, `${d.decisionMs.toFixed(1)} ms`)))
    while (log.children.length > 100) log.lastChild.remove()
  } else if (msg.type === 'lane') {
    for (const l of msg.lanes) lanes[l.lane].hold(l.held, msg.fire)
    fire = msg.fire
    fireBtn.textContent = fire ? 'Reset fire alarm' : 'Trigger fire alarm'
  } else if (msg.type === 'changed') {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(refresh, 200)
  }
})

setInterval(tickClock, 1000)
refresh()
