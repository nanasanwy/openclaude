// Test drive only: routes this screen's /api calls and live updates to the access system
// running in the parent page, so every screen shares one set of data.
;(function () {
  var host = window.parent !== window && window.parent.naruDemo
  if (!host) return
  var realFetch = window.fetch.bind(window)
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url
    if (url.indexOf('/api/') === 0) return host.fetch(url, init)
    return realFetch(input, init)
  }
  function DemoSocket(url) {
    var self = this
    this.readyState = 0
    setTimeout(function () {
      var query = url.split('?')[1] || ''
      self._close = host.connect(query, function (data) {
        if (self.readyState === 1 && self.onmessage) self.onmessage({ data: data })
      })
      if (!self._close) {
        self.readyState = 3
        if (self.onclose) self.onclose({})
        return
      }
      self.readyState = 1
      if (self.onopen) self.onopen({})
    }, 0)
  }
  DemoSocket.prototype.send = function () {}
  DemoSocket.prototype.close = function () {
    if (this._close) this._close()
    this.readyState = 3
  }
  window.WebSocket = DemoSocket
  // Links that would open another screen in a new tab switch the test drive's tab instead.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[target="_blank"]')
    if (!a) return
    var href = a.getAttribute('href') || ''
    if (/^(index|staff|gate)\.html/.test(href)) {
      e.preventDefault()
      host.navigate(href)
    }
  })
})()
