import { Loader2, Phone } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { useAuth } from '@/hooks/useAuth'
import { isSupabaseConfigured } from '@/lib/supabase'
import { errorMessage } from '@/lib/utils'

export function AuthPage() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const isSignUp = mode === 'signup'

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)

    try {
      if (isSignUp) {
        await signUp(email, password, fullName, workspaceName)
        toast.success('Workspace created. Check your inbox if email confirmation is on.')
      } else {
        await signIn(email, password)
      }
    } catch (error) {
      toast.error(errorMessage(error, 'Could not sign you in'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid-noise flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-[6px] bg-accent">
            <Phone className="size-4 text-black" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight text-ink">Callsheet</h1>
            <p className="text-xs text-ink-faint">Power-dialer CRM</p>
          </div>
        </div>

        {!isSupabaseConfigured && (
          <div className="mb-4 rounded-[6px] border border-danger/30 bg-danger/10 px-3 py-2.5 text-xs leading-relaxed text-danger">
            <strong className="font-semibold">Backend not connected.</strong> Copy{' '}
            <code className="tabular">.env.example</code> to{' '}
            <code className="tabular">.env.local</code> and fill in your Supabase
            project URL and anon key, then restart the dev server.
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-lg border border-line bg-surface p-5"
        >
          <div>
            <h2 className="text-[13px] font-semibold text-ink">
              {isSignUp ? 'Create your workspace' : 'Sign in'}
            </h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              {isSignUp
                ? 'Signing up creates a private workspace only you can see.'
                : 'Welcome back.'}
            </p>
          </div>

          {isSignUp && (
            <>
              <Field label="Your name">
                <Input
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="Jordan Reyes"
                  autoComplete="name"
                  required
                />
              </Field>
              <Field label="Workspace name" hint="Usually your agency or team name.">
                <Input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="Northside Roofing"
                  required
                />
              </Field>
            </>
          )}

          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              required
            />
          </Field>

          <Field
            label="Password"
            hint={isSignUp ? 'At least 6 characters.' : undefined}
          >
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
              minLength={6}
              required
            />
          </Field>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={submitting || !isSupabaseConfigured}
          >
            {submitting && <Loader2 className="animate-spin" />}
            {isSignUp ? 'Create workspace' : 'Sign in'}
          </Button>

          <p className="text-center text-xs text-ink-faint">
            {isSignUp ? 'Already have an account?' : 'Need an account?'}{' '}
            <button
              type="button"
              onClick={() => setMode(isSignUp ? 'signin' : 'signup')}
              className="font-medium text-accent hover:underline"
            >
              {isSignUp ? 'Sign in' : 'Sign up'}
            </button>
          </p>
        </form>
      </div>
    </div>
  )
}
