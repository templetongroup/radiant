import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import SettingsWindow from './SettingsWindow.jsx'
import Hud from './components/Hud.jsx'
import './styles.css'
import '@xterm/xterm/css/xterm.css'
import 'highlight.js/styles/atom-one-dark.css'

const hash = window.location.hash.replace(/^#/, '')
const [route, tab] = hash.split('/')
createRoot(document.getElementById('root')).render(
  route === 'settings' ? <SettingsWindow initialTab={tab || 'providers'} />
    // The HUD is its own window, so it is its own route — same shape as
    // Settings, and it never mounts the whole app just to draw six rows.
    : route === 'hud' ? <Hud />
      : <App />
)
