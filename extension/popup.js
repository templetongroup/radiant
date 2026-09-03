chrome.runtime.sendMessage({ op: 'status' }, r => {
  const s = document.getElementById('s')
  const hint = document.getElementById('hint')
  const on = r && r.connected
  s.innerHTML = `<span class="dot ${on ? 'on' : 'off'}"></span>${on ? 'Connected to Radiant on port ' + r.port : 'Not connected'}`
  hint.textContent = on
    ? 'Radiant can see this browser: your tabs, the page you are on, and it can click and type here.'
    : 'Open Radiant. This reconnects on its own within about 30 seconds.'
})
