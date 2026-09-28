import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AppShell } from '@/components/layout/AppShell'
import { ErrorBoundary } from '@/components/ui/error-state'
import { TooltipProvider } from '@/components/ui/misc'
import { AuthProvider, useAuth } from '@/hooks/useAuth'
import { DialerProvider } from '@/hooks/useDialer'
import { WorkspaceProvider } from '@/hooks/useWorkspace'
import { AuthPage } from '@/pages/Auth'
import { CallLogPage } from '@/pages/CallLog'
import { AnalyticsPage } from '@/pages/Analytics'
import { ReportsPage } from '@/pages/Reports'
import { DashboardPage } from '@/pages/Dashboard'
import { LeadsPage } from '@/pages/Leads'
import { SessionDialerPage } from '@/pages/SessionDialer'
import { ScriptsPage } from '@/pages/Scripts'
import { PlaybooksPage } from '@/pages/Playbooks'
import { SessionsPage } from '@/pages/Sessions'
import { SettingsPage } from '@/pages/Settings'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

function FullScreenLoader() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-5 animate-spin text-ink-faint" />
    </div>
  )
}

/**
 * Route guards wait for `initialized` before deciding anything. Redirecting
 * while the session is still unknown is what causes login/dashboard loops.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, initialized } = useAuth()

  if (!initialized) return <FullScreenLoader />
  if (!session) return <Navigate to="/auth" replace />
  return <>{children}</>
}

function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { session, initialized } = useAuth()

  if (!initialized) return <FullScreenLoader />
  if (session) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <WorkspaceProvider>
            <DialerProvider>
              <TooltipProvider delayDuration={300}>
                <Routes>
                  <Route
                    path="/auth"
                    element={
                      <RedirectIfAuthed>
                        <AuthPage />
                      </RedirectIfAuthed>
                    }
                  />
                  <Route
                    element={
                      <RequireAuth>
                        {/* One bad component should show a message, not blank
                            the whole app. */}
                        <ErrorBoundary>
                          <AppShell />
                        </ErrorBoundary>
                      </RequireAuth>
                    }
                  >
                    <Route index element={<DashboardPage />} />
                    <Route path="leads" element={<LeadsPage />} />
                    <Route path="scripts" element={<ScriptsPage />} />
                    <Route path="playbooks" element={<PlaybooksPage />} />
                    <Route path="sessions" element={<SessionsPage />} />
                    <Route path="sessions/:sessionId" element={<SessionDialerPage />} />
                    <Route path="calls" element={<CallLogPage />} />
                    <Route path="analytics" element={<AnalyticsPage />} />
                    <Route path="reports" element={<ReportsPage />} />
                    <Route path="settings" element={<SettingsPage />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>

                <Toaster
                  theme="dark"
                  position="top-right"
                  toastOptions={{
                    style: {
                      background: '#1f232b',
                      border: '1px solid #262a33',
                      color: '#e7e9ee',
                      fontSize: '13px',
                    },
                  }}
                />
              </TooltipProvider>
            </DialerProvider>
          </WorkspaceProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
