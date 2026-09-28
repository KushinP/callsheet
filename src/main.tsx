import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

/**
 * Supabase's OAuth server sends the user to `Site URL + Authorization Path` with an
 * `authorization_id`, and that path is a free-text dashboard field — `/oauth/consent`,
 * `/oauth-consent.html`, whatever was typed. Anything that is not the real page falls
 * through to the SPA router, matches no route, and hits the catch-all redirect to `/`,
 * which drops the query string. The user lands on the dashboard with no consent screen
 * and nothing explaining why.
 *
 * So: an `authorization_id` on ANY path means an OAuth approval is in flight. Forward it
 * to the consent page with the query intact, and the connector works regardless of what
 * that dashboard field says.
 */
const CONSENT_PAGE = '/oauth-consent.html'
const authorizationId = new URLSearchParams(window.location.search).get('authorization_id')

if (authorizationId && window.location.pathname !== CONSENT_PAGE) {
  window.location.replace(`${CONSENT_PAGE}${window.location.search}`)
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
