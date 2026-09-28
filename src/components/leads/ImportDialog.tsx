import { AlertTriangle, CheckCircle2, FileUp, Loader2, Upload } from 'lucide-react'
import Papa from 'papaparse'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useImportLeads } from '@/hooks/useLeads'
import { IMPORT_FIELDS, type ImportField, type ImportResult } from '@/lib/types'
import { cn, errorMessage, guessColumn, normalizePhone, plural } from '@/lib/utils'

type Mapping = Partial<Record<ImportField, string>>

/** Header aliases used to pre-fill the mapping so most CSVs need no edits. */
const HEADER_HINTS: Record<ImportField, string[]> = {
  business_name: ['businessname', 'business', 'company', 'companyname', 'account'],
  contact_name: [
    'contactname', 'contact', 'owner', 'ownername', 'innkeeper', 'manager',
    'firstname', 'fullname', 'person', 'primarycontact',
  ],
  phone: ['phone', 'phonenumber', 'mobile', 'tel', 'telephone', 'contactnumber'],
  room_count: ['rooms', 'roomcount', 'numrooms', 'units', 'keys', 'roomsavailable'],
  address: ['address', 'street', 'address1', 'streetaddress'],
  city: ['city', 'town', 'locality'],
  state: ['state', 'province', 'region'],
  zip: ['zip', 'zipcode', 'postal', 'postalcode'],
  website: ['website', 'url', 'site', 'domain'],
  email: ['email', 'emailaddress', 'contactemail'],
  notes: ['notes', 'note', 'comment', 'comments', 'description'],
}

const NONE = '__none__'

export function ImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [fileName, setFileName] = useState<string | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [mapping, setMapping] = useState<Mapping>({})
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [parsing, setParsing] = useState(false)

  const importLeads = useImportLeads()

  const reset = useCallback(() => {
    setFileName(null)
    setHeaders([])
    setRows([])
    setMapping({})
    setProgress(null)
    setResult(null)
  }, [])

  const handleFile = useCallback((file: File) => {
    setParsing(true)
    setResult(null)

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header) => header.trim(),
      complete: (parsed) => {
        setParsing(false)

        const detected = (parsed.meta.fields ?? []).filter(Boolean)
        if (detected.length === 0) {
          toast.error('No column headers found in that file.')
          return
        }

        // Pre-map on best-guess header names; the user still confirms below.
        const guessed: Mapping = {}
        for (const field of IMPORT_FIELDS) {
          const match = detected.find((header) =>
            guessColumn(header, HEADER_HINTS[field.key]),
          )
          if (match) guessed[field.key] = match
        }

        setFileName(file.name)
        setHeaders(detected)
        setRows(parsed.data)
        setMapping(guessed)
      },
      error: (error) => {
        setParsing(false)
        toast.error(`Could not read that CSV: ${error.message}`)
      },
    })
  }, [])

  const preview = useMemo(() => rows.slice(0, 5), [rows])

  /** How many rows carry a phone number we could actually dial. */
  const dialableCount = useMemo(() => {
    const column = mapping.phone
    if (!column) return 0
    return rows.filter((row) => normalizePhone(row[column]).length >= 10).length
  }, [rows, mapping.phone])

  const uniquePhoneCount = useMemo(() => {
    const column = mapping.phone
    if (!column) return 0
    const seen = new Set<string>()
    for (const row of rows) {
      const normalized = normalizePhone(row[column])
      if (normalized.length >= 10) seen.add(normalized)
    }
    return seen.size
  }, [rows, mapping.phone])

  const canImport = Boolean(mapping.business_name && mapping.phone && dialableCount > 0)

  const handleImport = async () => {
    const payload = rows.map((row) => {
      const mapped: Record<string, unknown> = {}
      for (const field of IMPORT_FIELDS) {
        const column = mapping[field.key]
        if (column) mapped[field.key] = row[column] ?? null
      }
      // Everything from the original file is preserved, mapped or not.
      mapped.metadata_json = row
      return mapped
    })

    try {
      const totals = await importLeads.mutateAsync({
        rows: payload,
        onProgress: (done, total) => setProgress({ done, total }),
      })
      setResult(totals)
      setProgress(null)
      toast.success(
        `Imported ${totals.inserted.toLocaleString()} new leads` +
          (totals.updated ? `, refreshed ${totals.updated.toLocaleString()}` : ''),
      )
    } catch (error) {
      setProgress(null)
      toast.error(errorMessage(error, 'Import failed'))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent
        title="Import leads"
        description="Map your CSV columns, check the preview, then import."
        size="xl"
      >
        <DialogBody className="space-y-5">
          {/* Step 1 — file */}
          {!fileName ? (
            <label
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg',
                'border border-dashed border-line bg-base px-6 py-12 text-center',
                'transition-colors hover:border-accent/40 hover:bg-surface-2',
              )}
            >
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) handleFile(file)
                }}
              />
              {parsing ? (
                <Loader2 className="size-5 animate-spin text-accent" />
              ) : (
                <FileUp className="size-5 text-ink-faint" />
              )}
              <div>
                <p className="text-[13px] font-medium text-ink">
                  {parsing ? 'Reading file…' : 'Choose a CSV file'}
                </p>
                <p className="mt-0.5 text-xs text-ink-faint">
                  Headers are detected automatically. Nothing is uploaded until you confirm.
                </p>
              </div>
            </label>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-[6px] border border-line bg-base px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-ink">{fileName}</p>
                <p className="tabular mt-0.5 text-xs text-ink-faint">
                  {rows.length.toLocaleString()} rows · {headers.length} columns
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={reset}>
                Choose another
              </Button>
            </div>
          )}

          {/* Step 2 — column mapping */}
          {headers.length > 0 && !result && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Column mapping</Label>
                <p className="text-[11px] text-ink-faint">
                  Business Name and Phone are required
                </p>
              </div>

              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {IMPORT_FIELDS.map((field) => (
                  <div key={field.key} className="space-y-1">
                    <span className="flex items-center gap-1 text-[11px] text-ink-dim">
                      {field.label}
                      {field.required && <span className="text-accent">*</span>}
                    </span>
                    <Select
                      value={mapping[field.key] ?? NONE}
                      onValueChange={(value) =>
                        setMapping((prev) => ({
                          ...prev,
                          [field.key]: value === NONE ? undefined : value,
                        }))
                      }
                      options={[
                        { value: NONE, label: '— Not mapped —' },
                        ...headers.map((header) => ({ value: header, label: header })),
                      ]}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 3 — preview */}
          {preview.length > 0 && !result && (
            <div className="space-y-2">
              <Label>Preview — first 5 rows</Label>
              <div className="overflow-x-auto rounded-[6px] border border-line">
                <table className="w-full border-collapse text-left">
                  <thead className="bg-surface-2">
                    <tr>
                      {IMPORT_FIELDS.filter((f) => mapping[f.key]).map((field) => (
                        <th
                          key={field.key}
                          className="whitespace-nowrap border-b border-line px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint"
                        >
                          {field.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {preview.map((row, index) => (
                      <tr key={index}>
                        {IMPORT_FIELDS.filter((f) => mapping[f.key]).map((field) => {
                          const value = row[mapping[field.key]!] ?? ''
                          const isPhone = field.key === 'phone'
                          const invalid = isPhone && normalizePhone(value).length < 10
                          return (
                            <td
                              key={field.key}
                              className={cn(
                                'max-w-52 truncate px-3 py-1.5 text-xs',
                                isPhone && 'tabular',
                                invalid ? 'text-danger' : 'text-ink-dim',
                              )}
                            >
                              {value || '—'}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {mapping.phone && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-faint">
                  <span className="tabular">
                    {plural(dialableCount, 'row')} with a valid phone
                  </span>
                  <span className="tabular">
                    {plural(uniquePhoneCount, 'unique number')}
                  </span>
                  {dialableCount > uniquePhoneCount && (
                    <span className="flex items-center gap-1 text-warn">
                      <AlertTriangle className="size-3" />
                      {plural(dialableCount - uniquePhoneCount, 'duplicate')} will collapse
                    </span>
                  )}
                  {rows.length > dialableCount && (
                    <span className="flex items-center gap-1 text-warn">
                      <AlertTriangle className="size-3" />
                      {plural(rows.length - dialableCount, 'row')} skipped (no valid phone)
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 4 — result */}
          {result && (
            <div className="rounded-[6px] border border-accent/30 bg-accent/5 p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-accent" />
                <p className="text-[13px] font-medium text-ink">Import complete</p>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['New leads', result.inserted, 'text-accent'],
                  ['Refreshed', result.updated, 'text-info'],
                  ['Skipped', result.skipped, 'text-ink-dim'],
                  ['Rows read', result.received, 'text-ink-dim'],
                ].map(([label, value, tone]) => (
                  <div key={label as string}>
                    <dt className="text-[10px] uppercase tracking-wider text-ink-faint">
                      {label}
                    </dt>
                    <dd className={cn('tabular mt-0.5 text-lg font-semibold', tone as string)}>
                      {(value as number).toLocaleString()}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
                Re-importing an overlapping list is safe: leads are matched by
                normalized phone number, so refreshed rows keep their stage,
                outcome, notes, and Do Not Call flag.
              </p>
            </div>
          )}

          {progress && (
            <div className="space-y-1.5">
              <div className="h-1 overflow-hidden rounded-full bg-elevated">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
              <p className="tabular text-[11px] text-ink-faint">
                {progress.done.toLocaleString()} / {progress.total.toLocaleString()} rows
              </p>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {result ? 'Done' : 'Cancel'}
          </Button>
          {!result && (
            <Button
              variant="primary"
              onClick={() => void handleImport()}
              disabled={!canImport || importLeads.isPending}
            >
              {importLeads.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
              Import {dialableCount > 0 ? `${dialableCount.toLocaleString()} leads` : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
