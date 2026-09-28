import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { useImportLeads } from '@/hooks/useLeads'
import { errorMessage } from '@/lib/utils'

const EMPTY = {
  business_name: '',
  contact_name: '',
  phone: '',
  address: '',
  city: '',
  state: '',
  zip: '',
  website: '',
  email: '',
  notes: '',
}

/**
 * One lead, by hand.
 *
 * Routed through the same import_leads RPC the CSV path uses rather than a
 * direct insert: phone normalisation, the 10-digit floor, and dedupe on the
 * normalised number all come free, and a number already in the list updates
 * instead of silently creating a duplicate.
 *
 * No stage, tier or tag fields on purpose — a new lead is 'new' by definition,
 * tier is Claude's opening move, and import_leads carries none of them anyway.
 */
export function AddLeadDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [form, setForm] = useState({ ...EMPTY })
  const importLeads = useImportLeads()

  const set = (key: keyof typeof EMPTY) => (event: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }))

  const digits = form.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  const dialable = digits.length >= 10

  const save = async () => {
    try {
      const result = await importLeads.mutateAsync({ rows: [{ ...form }] })

      // Say which of the three things actually happened. import_leads
      // deliberately leaves notes and stage alone on a conflict, so a
      // returning number is an update, not a new lead — claiming otherwise
      // would be the kind of small lie that erodes trust in the whole list.
      if (result.inserted) {
        toast.success(`Added ${form.business_name || 'lead'}.`)
      } else if (result.updated) {
        toast.success(
          'That number was already in your list — details updated. ' +
          'Its notes and stage were left alone.',
        )
      } else {
        toast.error('Nothing saved — that phone number has fewer than 10 digits.')
        return
      }

      setForm({ ...EMPTY })
      onOpenChange(false)
    } catch (error) {
      toast.error(errorMessage(error, 'Could not save that lead'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add a lead"
        description="Only the phone number is required."
        size="md"
      >
        <DialogBody className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Business name">
              <Input value={form.business_name} onChange={set('business_name')} />
            </Field>
            <Field
              label="Phone"
              hint={
                form.phone && !dialable
                  ? 'Needs at least 10 digits to be dialable.'
                  : undefined
              }
            >
              <Input
                value={form.phone}
                onChange={set('phone')}
                inputMode="tel"
                placeholder="(802) 555-0100"
                className="tabular"
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Contact" hint="Who to ask for.">
              <Input value={form.contact_name} onChange={set('contact_name')} />
            </Field>
            <Field label="Address">
              <Input value={form.address} onChange={set('address')} />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="City"><Input value={form.city} onChange={set('city')} /></Field>
            <Field label="State"><Input value={form.state} onChange={set('state')} /></Field>
            <Field label="ZIP"><Input value={form.zip} onChange={set('zip')} /></Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Website"><Input value={form.website} onChange={set('website')} /></Field>
            <Field label="Email"><Input value={form.email} onChange={set('email')} /></Field>
          </div>

          <Field label="Notes" hint="What you already know. Claude reads these when it writes the brief.">
            <Textarea value={form.notes} onChange={set('notes')} rows={3} />
          </Field>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!dialable || importLeads.isPending}
            onClick={() => void save()}
          >
            {importLeads.isPending ? 'Saving…' : 'Add lead'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
