import { installMainGenerationTransport } from './services/generation/generation-runtime'
import { mainGenerationTransport } from './services/generation/main-generation-transport'
import React from 'react'
import ReactDOM from 'react-dom/client'
import RendererStartup from './components/startup/RendererStartup'
import './styles/paper-ink/index.css'
import './index.css'
import './components/stage/stage.css'


installMainGenerationTransport(mainGenerationTransport)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererStartup />
  </React.StrictMode>,
)
