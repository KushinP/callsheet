import {
  Bookmark, CalendarClock, Check, ChevronDown, Search, Star, X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger,
} from '@/components/ui/dropdown'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/misc'
import { useLeadFilterOptions } from '@/hooks/useLeads'
import {
  ALL_OUTCOMES, OUTCOME_LABELS,
  type CallOutcome, type LeadFilters, ALL_STAGES, ALL_TIERS, STAGE_LABELS, type LeadTier, type PipelineStage,
} from '@/lib/types'
import { cn } from '@/lib/utils'

const PRESETS_KEY = 'cs.filter_presets'

interface Preset {
  name: string
  filters: LeadFilters
}

function loadPresets(): Preset[] {
  try {
    return JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]') as Preset[]
  } catch {
    return []
  }
}

const TIER_LABELS: Record<LeadTier, string> = {
  a: 'Tier A — call today',
  b: 'Tier B — worth a call',
  c: 'Tier C — if the list dries up',
}

function MultiSelect<T extends string>({
  label,
  values,
  selected,
  labels,
  onChange,
}: {
  label: string
  values: T[]
  selected: T[]
  labels: Record<T, string>
  onChange: (next: T[]) => void
}) {
  const toggle = (value: T) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <Button variant="outline" size="md" className="gap-1.5">
          {label}
          {selected.length > 0 && (
            <span className="tabular rounded-[3px] bg-accent/15 px-1 text-[10px] text-accent">
              {selected.length}
            </span>
          )}
          <ChevronDown />
        </Button>
      </DropdownTrigger>
      <DropdownContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownLabel>{label}</DropdownLabel>
        {values.map((value) => (
          <DropdownItem
            key={value}
            onSelect={(event) => {
              // Keep the menu open so several can be picked in one go.
              event.preventDefault()
              toggle(value)
            }}
          >
            <Checkbox checked={selected.includes(value)} className="pointer-events-none" />
            {labels[value]}
          </DropdownItem>
        ))}
        {selected.length > 0 && (
          <>
            <DropdownSeparator />
            <DropdownItem onSelect={() => onChange([])}>
              <X />
              Clear
            </DropdownItem>
          </>
        )}
      </DropdownContent>
    </Dropdown>
  )
}

/**
 * "Not called in N days" as an absolute cutoff, which is the shape
 * `useLeads` already filters on. Leads never called are included: the query
 * ORs on `last_called_at is null`.
 */
/*
 * Truncated to the start of the local day, not to the millisecond.
 *
 * This was `new Date(Date.now() - days * 86_400_000).toISOString()` computed
 * fresh on every call, so comparing a stored cutoff against a newly generated
 * one never matched: the button always fell back to the generic "Not called
 * recently" and the check mark never rendered, leaving no way to tell whether
 * you had picked 7 days or 90.
 *
 * A day boundary is the honest cutoff for a filter labelled in days, and it
 * holds still — so a saved preset keeps meaning what its name says.
 */
function cutoffFor(days: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

/*
 * Bands rather than a min/max pair of inputs: nobody filters on "between 11 and
 * 14 rooms", they filter on "the small ones". Chosen off the actual spread —
 * 152 leads run 2 to 45, median 12.
 */
const ROOM_BANDS: { label: string; min?: number; max?: number }[] = [
  { label: '1-5 rooms', min: 1, max: 5 },
  { label: '6-12 rooms', min: 6, max: 12 },
  { label: '13-25 rooms', min: 13, max: 25 },
  { label: '26+ rooms', min: 26 },
]

const COOLDOWNS = [7, 14, 30, 60, 90].map((days) => ({
  days,
  label: `${days} days`,
  iso: () => cutoffFor(days),
}))

export function LeadFilterBar({
  filters,
  onChange,
  extra,
}: {
  filters: LeadFilters
  onChange: (filters: LeadFilters) => void
  extra?: React.ReactNode
}) {
  const options = useLeadFilterOptions()
  const availableTags = options.data?.tags ?? []
  const [presets, setPresets] = useState<Preset[]>(loadPresets)
  const [searchDraft, setSearchDraft] = useState(filters.search ?? '')

  /*
   * Resync when the search changes from outside — applying a saved preset, or
   * a deep link. The draft used to be seeded once at mount, so the debounce
   * below wrote it straight back out 280ms later and silently erased the term
   * a preset carried, without ever displaying it.
   */
  const lastPushed = useRef(filters.search ?? '')
  useEffect(() => {
    const incoming = filters.search ?? ''
    if (incoming !== lastPushed.current) {
      lastPushed.current = incoming
      setSearchDraft(incoming)
    }
  }, [filters.search])

  // Debounce so a fast typist does not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filters.search ?? '') !== searchDraft) {
        lastPushed.current = searchDraft
        onChange({ ...filters, search: searchDraft || undefined })
      }
    }, 280)
    return () => clearTimeout(timer)
  }, [searchDraft, filters, onChange])

  const activeCount =
    (filters.search?.trim() ? 1 : 0) +
    (filters.stages?.length ? 1 : 0) +
    (filters.tiers?.length ? 1 : 0) +
    (filters.tags?.length ? 1 : 0) +
    (filters.outcomes?.length ? 1 : 0) +
    (filters.city ? 1 : 0) +
    (filters.state ? 1 : 0) +
    (filters.rooms_min !== undefined || filters.rooms_max !== undefined ? 1 : 0) +
    (filters.has_next_step !== undefined ? 1 : 0) +
    (filters.never_called ? 1 : 0) +
    (filters.not_called_since ? 1 : 0)

  const savePreset = () => {
    const name = window.prompt('Name this filter preset')?.trim()
    if (!name) return

    const next = [...presets.filter((p) => p.name !== name), { name, filters }]
    setPresets(next)
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next))
    toast.success(`Saved preset "${name}"`)
  }

  const deletePreset = (name: string) => {
    const next = presets.filter((p) => p.name !== name)
    setPresets(next)
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next))
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-56 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
        <Input
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          placeholder="Search name, phone, city, address…"
          className="pl-8"
        />
      </div>

      <MultiSelect
        label="Stage"
        values={ALL_STAGES}
        selected={filters.stages ?? []}
        labels={STAGE_LABELS}
        onChange={(stages) =>
          onChange({ ...filters, stages: stages.length ? (stages as PipelineStage[]) : undefined })
        }
      />

      <MultiSelect
        label="Tier"
        values={ALL_TIERS}
        selected={filters.tiers ?? []}
        labels={TIER_LABELS}
        onChange={(tiers) =>
          onChange({ ...filters, tiers: tiers.length ? (tiers as LeadTier[]) : undefined })
        }
      />

      {/* Tags are workspace-defined rather than a fixed list, so this offers
          the ones actually in use instead of an empty enum. */}
      {availableTags.length > 0 && (
        <MultiSelect
          label="Tags"
          values={availableTags}
          selected={filters.tags ?? []}
          labels={Object.fromEntries(availableTags.map((t) => [t, t])) as Record<string, string>}
          onChange={(tags) => onChange({ ...filters, tags: tags.length ? tags : undefined })}
        />
      )}

      <MultiSelect
        label="Outcome"
        values={ALL_OUTCOMES}
        selected={filters.outcomes ?? []}
        labels={OUTCOME_LABELS}
        onChange={(outcomes) =>
          onChange({ ...filters, outcomes: outcomes.length ? (outcomes as CallOutcome[]) : undefined })
        }
      />

      <Dropdown>
        <DropdownTrigger asChild>
          <Button variant="outline" className="gap-1.5">
            {filters.city ?? 'City'}
            <ChevronDown />
          </Button>
        </DropdownTrigger>
        <DropdownContent align="start" className="max-h-80 overflow-y-auto">
          <DropdownItem onSelect={() => onChange({ ...filters, city: undefined })}>
            All cities
          </DropdownItem>
          <DropdownSeparator />
          {(options.data?.cities ?? []).map((city) => (
            <DropdownItem key={city} onSelect={() => onChange({ ...filters, city })}>
              {filters.city === city && <Check />}
              {city}
            </DropdownItem>
          ))}
        </DropdownContent>
      </Dropdown>

      <Dropdown>
        <DropdownTrigger asChild>
          <Button variant="outline" className="gap-1.5">
            {filters.state ?? 'State'}
            <ChevronDown />
          </Button>
        </DropdownTrigger>
        <DropdownContent align="start" className="max-h-80 overflow-y-auto">
          <DropdownItem onSelect={() => onChange({ ...filters, state: undefined })}>
            All states
          </DropdownItem>
          <DropdownSeparator />
          {(options.data?.states ?? []).map((state) => (
            <DropdownItem key={state} onSelect={() => onChange({ ...filters, state })}>
              {filters.state === state && <Check />}
              {state}
            </DropdownItem>
          ))}
        </DropdownContent>
      </Dropdown>

      <Dropdown>
        <DropdownTrigger asChild>
          <Button
            variant={
              filters.rooms_min !== undefined || filters.rooms_max !== undefined
                ? 'primary' : 'outline'
            }
          >
            {ROOM_BANDS.find(
              (b) => b.min === filters.rooms_min && b.max === filters.rooms_max,
            )?.label ?? 'Rooms'}
            <ChevronDown />
          </Button>
        </DropdownTrigger>
        <DropdownContent align="start" className="w-44">
          <DropdownLabel>Property size</DropdownLabel>
          {ROOM_BANDS.map((band) => (
            <DropdownItem
              key={band.label}
              onSelect={() =>
                onChange({ ...filters, rooms_min: band.min, rooms_max: band.max })
              }
            >
              {filters.rooms_min === band.min && filters.rooms_max === band.max && <Check />}
              {band.label}
            </DropdownItem>
          ))}
          {(filters.rooms_min !== undefined || filters.rooms_max !== undefined) && (
            <>
              <DropdownSeparator />
              <DropdownItem
                onSelect={() =>
                  onChange({ ...filters, rooms_min: undefined, rooms_max: undefined })
                }
              >
                Any size
              </DropdownItem>
            </>
          )}
        </DropdownContent>
      </Dropdown>

      <Button
        variant={filters.never_called ? 'primary' : 'outline'}
        onClick={() =>
          onChange({ ...filters, never_called: filters.never_called ? undefined : true })
        }
      >
        Never called
      </Button>

      {/* The pipeline flow's amber node opens this. Three states, because
          "leads with nothing queued" and "leads being worked" are both real
          questions and neither is the default view. */}
      <Button
        variant={filters.has_next_step === false ? 'primary' : 'outline'}
        title="Leads with no open task — worked once and then dropped"
        onClick={() =>
          onChange({
            ...filters,
            has_next_step: filters.has_next_step === false ? undefined : false,
          })
        }
      >
        Nothing queued
      </Button>

      <Dropdown>
        <DropdownTrigger asChild>
          <Button variant={filters.not_called_since ? 'primary' : 'outline'}>
            <CalendarClock />
            {filters.not_called_since
              ? (COOLDOWNS.find((c) => c.iso() === filters.not_called_since)?.label ??
                 'Not called recently')
              : 'Not called in…'}
          </Button>
        </DropdownTrigger>
        <DropdownContent align="start" className="w-48">
          <DropdownLabel>Untouched for at least</DropdownLabel>
          {COOLDOWNS.map((c) => (
            <DropdownItem
              key={c.days}
              onSelect={() => onChange({ ...filters, not_called_since: c.iso() })}
            >
              {filters.not_called_since === c.iso() && <Check />}
              {c.label}
            </DropdownItem>
          ))}
          {filters.not_called_since && (
            <>
              <DropdownSeparator />
              <DropdownItem
                onSelect={() => onChange({ ...filters, not_called_since: undefined })}
              >
                <X />
                Clear
              </DropdownItem>
            </>
          )}
        </DropdownContent>
      </Dropdown>

      {/* Presets live in localStorage so a rep's favourite slice is one click away. */}
      <Dropdown>
        <DropdownTrigger asChild>
          <Button variant="outline" size="icon" title="Filter presets">
            <Bookmark className={cn(presets.length > 0 && 'text-accent')} />
          </Button>
        </DropdownTrigger>
        <DropdownContent align="end" className="w-56">
          <DropdownLabel>Saved presets</DropdownLabel>
          {presets.length === 0 && (
            <p className="px-2 py-2 text-[11px] text-ink-faint">
              No presets yet. Set some filters, then save them here.
            </p>
          )}
          {presets.map((preset) => (
            <DropdownItem key={preset.name} onSelect={() => onChange(preset.filters)}>
              <Star />
              <span className="flex-1 truncate">{preset.name}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  deletePreset(preset.name)
                }}
                className="text-ink-faint hover:text-danger"
              >
                <X className="size-3" />
              </button>
            </DropdownItem>
          ))}
          <DropdownSeparator />
          <DropdownItem onSelect={savePreset}>
            <Bookmark />
            Save current filters
          </DropdownItem>
        </DropdownContent>
      </Dropdown>

      {activeCount > 0 && (
        <Button
          variant="ghost"
          onClick={() => {
            setSearchDraft('')
            onChange({})
          }}
        >
          <X />
          Clear
        </Button>
      )}

      {extra}
    </div>
  )
}
