import {
  BarChart3, ChevronsUpDown, FileText, ListChecks, LogOut, Phone, PhoneCall, Radio, Settings as SettingsIcon, Sparkles, Table2, TrendingUp, Users,
} from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger,
} from '@/components/ui/dropdown'
import { FloatingDialer } from '@/components/dialer/FloatingDialer'
import { useAuth } from '@/hooks/useAuth'
import { useDialer } from '@/hooks/useDialer'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn, initials } from '@/lib/utils'

const NAV = [
  { to: '/', label: 'Dashboard', icon: BarChart3, end: true },
  { to: '/leads', label: 'Leads', icon: Table2 },
  { to: '/scripts', label: 'Scripts', icon: FileText },
  { to: '/playbooks', label: 'Playbooks', icon: ListChecks },
  { to: '/sessions', label: 'Sessions', icon: Radio },
  { to: '/calls', label: 'Call Log', icon: PhoneCall },
  { to: '/analytics', label: 'Analytics', icon: TrendingUp },
  { to: '/reports', label: 'Reports', icon: Sparkles },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

export function AppShell() {
  const { user, signOut } = useAuth()
  const { workspace, workspaces, setWorkspaceId, twilioReady } = useWorkspace()
  const { openWidget, state } = useDialer()

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <div className="flex size-6 items-center justify-center rounded-[5px] bg-accent">
            <Phone className="size-3.5 text-black" />
          </div>
          <span className="text-[13px] font-semibold tracking-tight text-ink">
            Callsheet
          </span>
        </div>

        {/* Workspace switcher */}
        <div className="border-b border-line p-2">
          <Dropdown>
            <DropdownTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-[5px] border border-line bg-base px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-ink">
                    {workspace?.name ?? 'Loading…'}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-ink-faint">
                    {workspace?.role ?? '—'}
                  </p>
                </div>
                <ChevronsUpDown className="size-3.5 shrink-0 text-ink-faint" />
              </button>
            </DropdownTrigger>
            <DropdownContent align="start" className="w-52">
              <DropdownLabel>Workspaces</DropdownLabel>
              {workspaces.map((w) => (
                <DropdownItem key={w.id} onSelect={() => setWorkspaceId(w.id)}>
                  <Users />
                  <span className="truncate">{w.name}</span>
                </DropdownItem>
              ))}
            </DropdownContent>
          </Dropdown>
        </div>

        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-[5px] px-2.5 py-1.5 text-[13px] transition-colors',
                  isActive
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-ink-dim hover:bg-surface-2 hover:text-ink',
                )
              }
            >
              <Icon className="size-4" />
              {label}
              {to === '/settings' && !twilioReady && (
                <span className="ml-auto size-1.5 rounded-full bg-warn" title="Twilio not configured" />
              )}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-line p-2">
          <Button
            variant={state === 'idle' ? 'secondary' : 'primary'}
            className="w-full"
            onClick={() => openWidget()}
          >
            <Phone />
            {state === 'idle' ? 'Open dialer' : 'Call in progress'}
          </Button>
        </div>

        <div className="border-t border-line p-2">
          <Dropdown>
            <DropdownTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-elevated text-[10px] font-semibold text-ink-dim">
                  {initials(user?.user_metadata?.full_name ?? user?.email)}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink-dim">
                  {user?.email}
                </span>
              </button>
            </DropdownTrigger>
            <DropdownContent align="start" className="w-52">
              <DropdownLabel>{user?.email}</DropdownLabel>
              <DropdownSeparator />
              <DropdownItem onSelect={() => void signOut()}>
                <LogOut />
                Sign out
              </DropdownItem>
            </DropdownContent>
          </Dropdown>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>

      <FloatingDialer />
    </div>
  )
}

/** Consistent page chrome: dense title bar, then a scrolling body. */
export function PageHeader({
  title,
  description,
  actions,
  badge,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  badge?: React.ReactNode
}) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="truncate text-sm font-semibold text-ink">{title}</h1>
        {badge}
        {description && (
          <span className="hidden truncate text-xs text-ink-faint lg:inline">
            {description}
          </span>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

export function PageBody({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    // pb-24 reserves the corner the floating dialer sits in. It is fixed to the
    // viewport, not to this scroller, so without the extra room the last thing
    // on any page — a table's Next button, most visibly — ends up underneath it
    // at full scroll with no way to reach it.
    <div className={cn('min-h-0 flex-1 overflow-y-auto p-5 pb-24', className)}>{children}</div>
  )
}

export { Badge }
