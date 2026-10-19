// First, so Eeronaut's own URLs carry Home Assistant's prefix before anything
// asks for one (lib/base.ts).
import './lib/base'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
