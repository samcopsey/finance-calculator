import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/geologica'
import './index.css'
import App from './App.jsx'
import { applyTheme, initialTheme } from './theme.js'

applyTheme(initialTheme())

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
