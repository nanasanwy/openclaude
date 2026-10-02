import { liveSocket } from './lib.js'

// ?lane=out on the venue screens; #out also works where a query string is not available.
const lane = new URLSearchParams(location.search).get('lane') === 'out' || location.hash === '#out' ? 'out' : 'in'
const icon = document.getElementById('icon')
const message = document.getElementById('message')
const sub = document.getElementById('sub')
const status = document.getElementById('status')
const idleText = lane === 'in' ? 'Scan your band to enter' : 'Scan your band to leave'
const subIdle = lane === 'in' ? 'Play zone entrance' : 'Adults first, then kids'

let held = null // 'fire' | 'held' | null
let timer = null

function show(kind, iconText, text, subText) {
  document.body.className = kind
  icon.textContent = iconText
  message.textContent = text
  sub.textContent = subText
}

function idle() {
  if (held === 'fire') show('red', '!', 'Emergency', 'Gates are open. Please leave calmly.')
  else if (held === 'held') show('held', '', 'Gate open', 'Please walk through')
  else show('idle', '', idleText, subIdle)
}

idle()
liveSocket(`lane=${lane}`, msg => {
  if (msg.type === 'lane') {
    const me = msg.lanes.find(l => l.lane === lane)
    held = msg.fire ? 'fire' : me?.held ? 'held' : null
    idle()
  } else if (msg.type === 'gate' && msg.lane === lane && held !== 'fire') {
    const d = msg.decision
    show(d.color, d.open ? '✓' : '✕', d.message, d.open ? '' : d.code === 'adult_first' ? 'An adult from your group must scan out first' : '')
    clearTimeout(timer)
    timer = setTimeout(idle, d.open ? 3000 : 5000)
  }
}, online => {
  status.textContent = online ? `${lane.toUpperCase()} lane · online` : `${lane.toUpperCase()} lane · reconnecting…`
})
