import {
  ArrowDown, ArrowUp, ArrowUpDown, Ban, CalendarPlus, ChevronDown, ChevronRight, ExternalLink, MapPin, Mic, MicOff, MoreVertical, PanelRight, Phone, PhoneCall, PhoneIncoming, PhoneOff, Plus, Radio, Sparkles, Table2, Trash2, Upload,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PageBody, PageHeader } from '@/components/layout/AppShell'
import { AddLeadDialog } from '@/components/leads/AddLeadDialog'
import { ImportDialog } from '@/components/leads/ImportDialog'
import { LeadFilterBar } from '@/components/leads/LeadFilterBar'
import { StageBadge, TagEditor, TagList, TierChip } from '@/components/leads/LeadChips'
import { RecordingPlayer } from '@/components/calls/RecordingPlayer'
import { CallNote } from '@/components/calls/CallNote'
import { Transcript } from '@/components/calls/Transcript'
import { ConferenceControls } from '@/components/dialer/ConferenceControls'
import { LeadMetadata } from '@/components/leads/LeadMetadata'
import { CallStatePill } from '@/components/dialer/CallStatePill'
import { DispositionBar } from '@/components/dialer/DispositionBar'
import { ScriptPrompter } from '@/components/dialer/ScriptPrompter'
import { useSessionScript } from '@/hooks/useScripts'
import { useWorkspace } from '@/hooks/useWorkspace'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dropdown, DropdownContent, DropdownItem, DropdownSeparator, DropdownTrigger,
} from '@/components/ui/dropdown'
import { ErrorState } from '@/components/ui/error-state'
import { useQueryClient } from '@tanstack/react-query'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Markdown } from '@/components/ui/markdown'
import { Sheet, SheetBody, SheetContent, SheetFooter } from '@/components/ui/sheet'
import { useGenerateBriefs, useLeadBrief } from '@/hooks/useDocuments'
import { usePendingSteps, useSetLeadStage, useTasks } from '@/hooks/useTasks'
import { readLeadParams, writeLeadParams, type LeadViewState } from '@/lib/leadParams'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { Select } from '@/components/ui/select'
import { Checkbox, Switch } from '@/components/ui/misc'
import { TableSkeleton } from '@/components/ui/skeleton'
import {
  EmptyState, Pagination, TBody, TD, TH, THead, TR, Table,
} from '@/components/ui/table'
import { useCreateSession } from '@/hooks/useSessions'
import { useDialer } from '@/hooks/useDialer'
import {
  LEADS_PAGE_SIZE, useBulkUpdateLeads, useDeleteLeads, useLead, useLeadFilterOptions,
  ALL_SORTS, SORT_LABELS, useLeads, useSetLeadTags, useUpdateLead, type LeadSort,
} from '@/hooks/useLeads'
import { useLeadCallHistory, useUpdateCallOutcome } from '@/hooks/useCalls'
import {
  OUTCOME_LABELS, OUTCOME_TONES,
  type Lead, type LeadFilters, ALL_STAGES, ALL_TIERS, STAGE_LABELS, type LeadTier, type PipelineStage, transcriptOf, transcriptRow,
} from '@/lib/types'
import {
  cn, errorMessage, formatDateTime, formatDuration, formatPhone, formatRelative,
  fromDateTimeLocal, toDateTimeLocal,
} from '@/lib/utils'

/*
 * Every sort the table can do, so the dropdown can always name the current one.
 * It used to list five of them; clicking a column header the list did not know
 * about would have left it rendering a blank trigger while the table was
 * plainly sorted.
 */
const SORT_OPTIONS: { value: LeadSort; label: string }[] =
  ALL_SORTS.map((value) => ({ value, label: SORT_LABELS[value] }))

/**
 * A column header that sorts.
 *
 * Each one owns a pair of sorts and a direction it tries first: text starts
 * A–Z, dates start most-recent, and Stage and Tier start at the end worth
 * looking at. Clicking Stage to be told you have 136 leads at New is not
 * information anybody was missing.
 *
 * The arrow only appears on the column actually in force, so the header row
 * still reads as a header row rather than a bank of controls.
 */
function SortHeader({
  label,
  asc,
  desc,
  first = 'asc',
  sort,
  onSort,
  className,
}: {
  label: string
  asc: LeadSort
  desc: LeadSort
  first?: 'asc' | 'desc'
  sort: LeadSort
  onSort: (next: LeadSort) => void
  className?: string
}) {
  const active = sort === asc ? 'asc' : sort === desc ? 'desc' : null
  const next = active === null
    ? (first === 'asc' ? asc : desc)
    : active === 'asc' ? desc : asc

  return (
    <TH className={cn('p-0', className)}>
      <button
        type="button"
        onClick={() => onSort(next)}
        title={SORT_LABELS[next]}
        className={cn(
          'group flex w-full items-center gap-1 px-4 py-2 text-left uppercase tracking-wider',
          'transition-colors hover:text-ink',
          active && 'text-ink',
        )}
      >
        {label}
        {active === 'asc' && <ArrowUp className="size-3" />}
        {active === 'desc' && <ArrowDown className="size-3" />}
        {/* Revealed on its own hover only. A header row that shows seven arrows
            at once stops reading as a header row. */}
        {!active && (
          <ArrowUpDown className="size-3 opacity-0 transition-opacity group-hover:opacity-50" />
        )}
      </button>
    </TH>
  )
}

export function LeadsPage() {
  const navigate = useNavigate()
  const { startCall } = useDialer()
  // The prompter falls back to the workspace default, so a call placed
  // from the list is worked from a script and should say which one.
  const defaultScript = useSessionScript(null)
  const createSession = useCreateSession()

  const [importOpen, setImportOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [detailLead, setDetailLead] = useState<Lead | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  // The URL is the source of truth for the view. Filters used to be bare
  // useState, so navigating away and back reset everything including the page
  // — and a slice that took six clicks to build could not be linked or
  // refreshed.
  const { filters, page, sort, includeDnc } = useMemo(
    () => readLeadParams(searchParams),
    [searchParams],
  )

  const setView = (next: Partial<LeadViewState>) =>
    setSearchParams(
      writeLeadParams({ filters, page, sort, includeDnc, ...next }, searchParams),
      { replace: true },
    )

  // Any change to what is being filtered puts you back on page one; without
  // this, narrowing a filter while on page 4 shows an empty table.
  /*
   * A selection must not outlive the filter it was made under, for the same
   * reason it must not outlive the page: the action bar would report rows that
   * are no longer on screen, and Delete would reach every one of them.
   */
  const updateFilters = (next: LeadFilters) => {
    clearSelection()
    setView({ filters: next, page: 0 })
  }
  const setPage = (next: number) => setView({ page: next })
  const setSort = (next: LeadSort) => setView({ sort: next, page: 0 })
  const setIncludeDnc = (next: boolean) => {
    clearSelection()
    setView({ includeDnc: next, page: 0 })
  }

  // A call in the log links here with ?lead=<id>. Fetch that one row directly
  // rather than hoping it happens to be on the current page.
  const linkedLead = useLead(searchParams.get('lead'))
  useEffect(() => {
    if (linkedLead.data) setDetailLead(linkedLead.data)
  }, [linkedLead.data])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const deleteLeads = useDeleteLeads()
  const bulkUpdate = useBulkUpdateLeads()
  const generateBriefs = useGenerateBriefs()

  const clearSelection = () => setSelected(new Set())

  const leads = useLeads({ filters, page, sort, includeDnc })

  /*
   * A page past the end renders the empty state — and Pagination lives inside
   * the has-rows branch, so there is no Previous button to get back with.
   * Deleting the last page's rows, or a hand-typed ?page=9999, stranded you
   * there. Snap to the last real page instead.
   */
  useEffect(() => {
    const total = leads.data?.total
    if (total === undefined) return
    const last = Math.max(0, Math.ceil(total / LEADS_PAGE_SIZE) - 1)
    if (page > last) setPage(last)
  }, [leads.data?.total, page])
  const rows = leads.data?.leads ?? []
  const allOnPageSelected = rows.length > 0 && rows.every((l) => selected.has(l.id))

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const togglePage = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const l of rows) allOnPageSelected ? next.delete(l.id) : next.add(l.id)
      return next
    })

  const runBulkOn = async (ids: string[], patch: Partial<Lead>, verb: string) => {
    await bulkUpdate.mutateAsync({ ids, patch })
    toast.success(`${verb} ${ids.length} ${ids.length === 1 ? 'lead' : 'leads'}`)
  }

  const runBulk = async (patch: Partial<Lead>, verb: string) => {
    await runBulkOn([...selected], patch, verb)
    clearSelection()
  }

  const confirmDelete = async () => {
    const ids = [...selected]
    await deleteLeads.mutateAsync(ids)
    toast.success(`Deleted ${ids.length} ${ids.length === 1 ? 'lead' : 'leads'}`)
    clearSelection()
    setConfirmingDelete(false)
    if (detailLead && ids.includes(detailLead.id)) setDetailLead(null)
  }

  const handleBuildSession = async () => {
    const total = leads.data?.total ?? 0
    if (total === 0) {
      toast.error('No leads match these filters.')
      return
    }

    const name = window.prompt(
      'Name this calling session',
      `Session ${new Date().toLocaleDateString()}`,
    )?.trim()
    if (!name) return

    try {
      const sessionId = await createSession.mutateAsync({
        name,
        filters,
        maxLeads: Math.min(total, 1000),
      })
      toast.success('Session created')
      navigate(`/sessions/${sessionId}`)
    } catch (error) {
      toast.error(errorMessage(error, 'Could not create the session'))
    }
  }

  return (
    <>
      <PageHeader
        title="Leads"
        badge={
          leads.data ? (
            <Badge tone="neutral">{leads.data.total.toLocaleString()}</Badge>
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={generateBriefs.isPending}
              onClick={() =>
                generateBriefs.mutate(
                  {
                    onProgress: (done, remaining) =>
                      toast.loading(`Briefed ${done}, ${remaining} to go`, { id: 'briefs' }),
                  },
                  {
                    onSuccess: (r) => {
                      toast.dismiss('briefs')
                      if (!r.available) {
                        // The missing-key path is deliberately quiet elsewhere;
                        // here the user asked for it, so say why nothing happened.
                        toast.error('No LLM key configured — set LLM_API_KEY to generate briefs.')
                      } else if (r.generated === 0) {
                        toast.success('Every lead already has a brief.')
                      } else {
                        toast.success(
                          `Briefed ${r.generated} lead${r.generated === 1 ? '' : 's'}` +
                            (r.failed ? ` · ${r.failed} failed` : '') +
                            ` · $${r.cost.toFixed(4)}`,
                        )
                      }
                    },
                  },
                )
              }
            >
              <Sparkles />
              {generateBriefs.isPending ? 'Briefing…' : 'Brief leads'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleBuildSession()}>
              <Radio />
              Build session
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <Plus />
              Add lead
            </Button>
            <Button variant="primary" size="sm" onClick={() => setImportOpen(true)}>
              <Upload />
              Import CSV
            </Button>
          </>
        }
      />

      <PageBody className="space-y-3">
        <LeadFilterBar
          filters={filters}
          onChange={updateFilters}
          extra={
            <>
              <Select
                value={sort}
                onValueChange={(value) => setSort(value as LeadSort)}
                options={SORT_OPTIONS}
                className="w-44"
              />
              <label className="flex items-center gap-2 whitespace-nowrap rounded-[5px] border border-line px-2.5 py-1.5 text-xs text-ink-dim">
                <Switch checked={includeDnc} onCheckedChange={setIncludeDnc} />
                Show DNC
              </label>
            </>
          }
        />

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-[5px] border border-accent/30 bg-accent/5 px-3 py-2">
            <span className="text-xs font-medium text-ink">
              {selected.size} {selected.size === 1 ? 'lead' : 'leads'} selected
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runBulk({ do_not_call: true }, 'Flagged')}
              >
                <PhoneOff />
                Mark DNC
              </Button>
              <Button variant="dangerGhost" size="sm" onClick={() => setConfirmingDelete(true)}>
                <Trash2 />
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                Clear
              </Button>
            </div>
          </div>
        )}

        <Panel className="overflow-hidden">
          {leads.isLoading ? (
            <TableSkeleton rows={10} cols={6} />
          ) : leads.isError ? (
            <ErrorState what="leads" error={leads.error} onRetry={() => void leads.refetch()} />
          ) : leads.data?.leads.length ? (
            <>
              <Table>
                <THead>
                  <tr>
                    <TH className="w-px">
                      <Checkbox
                        checked={allOnPageSelected}
                        onCheckedChange={togglePage}
                        aria-label="Select every lead on this page"
                      />
                    </TH>
                    <SortHeader label="Business" asc="name_asc" desc="name_desc"
                      sort={sort} onSort={setSort} />
                    <SortHeader label="Phone" asc="phone_asc" desc="phone_desc"
                      sort={sort} onSort={setSort} />
                    <SortHeader label="Location" asc="location_asc" desc="location_desc"
                      sort={sort} onSort={setSort} />
                    <SortHeader label="Stage" asc="stage_asc" desc="stage_desc" first="desc"
                      sort={sort} onSort={setSort} />
                    <SortHeader label="Outcome" asc="outcome_asc" desc="outcome_desc"
                      sort={sort} onSort={setSort} />
                    <SortHeader label="Tier" asc="tier_asc" desc="tier_desc" className="w-px"
                      sort={sort} onSort={setSort} />
                    <SortHeader label="Tags" asc="tags_asc" desc="tags_desc"
                      sort={sort} onSort={setSort} />
                    <SortHeader label="Last called" asc="last_called_asc"
                      desc="last_called_desc" first="desc"
                      sort={sort} onSort={setSort} />
                    <TH className="w-px" />
                  </tr>
                </THead>
                <TBody>
                  {leads.data.leads.map((lead) => (
                    <TR
                      key={lead.id}
                      className="cursor-pointer"
                      onClick={() => setDetailLead(lead)}
                    >
                      <TD onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          checked={selected.has(lead.id)}
                          onCheckedChange={() => toggleOne(lead.id)}
                          aria-label={`Select ${lead.business_name}`}
                        />
                      </TD>
                      <TD className="max-w-64">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{lead.business_name}</span>
                          {lead.do_not_call && (
                            <Badge tone="bad">
                              <Ban className="size-2.5" />
                              DNC
                            </Badge>
                          )}
                        </div>
                        {/* A second line rather than a column: who to ask for is
                            only worth knowing next to the business it belongs
                            to, and the table has no width left to spend. */}
                        {(lead.contact_name || lead.room_count !== null) && (
                          <p className="truncate text-[11px] text-ink-faint">
                            {lead.contact_name}
                            {lead.contact_name && lead.room_count !== null && ' · '}
                            {lead.room_count !== null && `${lead.room_count} rooms`}
                          </p>
                        )}
                      </TD>
                      <TD className="tabular text-ink-dim">{formatPhone(lead.phone)}</TD>
                      <TD className="text-ink-dim">
                        {lead.city ? (
                          <span className="flex items-center gap-1.5">
                            <MapPin className="size-3 text-ink-faint" />
                            {lead.city}
                            {lead.state ? `, ${lead.state}` : ''}
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </TD>
                      <TD><StageBadge stage={lead.pipeline_stage} /></TD>
                      {/* Filterable and sortable but invisible until now, so
                          the one thing telling you what happened on the phone
                          could only be read a lead at a time. */}
                      <TD>
                        {lead.outcome ? (
                          <Badge tone={OUTCOME_TONES[lead.outcome]}>
                            {OUTCOME_LABELS[lead.outcome]}
                          </Badge>
                        ) : (
                          <span className="text-[11px] text-ink-faint">—</span>
                        )}
                      </TD>
                      <TD>
                        <TierChip
                          tier={lead.tier}
                          isOverride={Boolean(lead.tier_override)}
                          reason={lead.tier_suggested_reason}
                        />
                      </TD>
                      <TD className="max-w-40"><TagList tags={lead.tags} /></TD>
                      <TD className="text-ink-faint">{formatRelative(lead.last_called_at)}</TD>
                      <TD onClick={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="iconSm"
                            disabled={lead.do_not_call}
                            title={lead.do_not_call ? 'Flagged Do Not Call' : 'Call now'}
                            onClick={() =>
                              void startCall({
                                phone: lead.phone,
                                businessName: lead.business_name,
                                leadId: lead.id,
                                scriptId: defaultScript.data?.id ?? null,
                              })
                            }
                          >
                            <Phone className={cn(!lead.do_not_call && 'text-accent')} />
                          </Button>

                          {/* Every row action was previously a bare icon or
                              nothing at all; the Dropdown primitives were
                              already here, used only for filters. */}
                          <Dropdown>
                            <DropdownTrigger asChild>
                              <Button variant="ghost" size="iconSm" title="More actions">
                                <MoreVertical />
                              </Button>
                            </DropdownTrigger>
                            <DropdownContent align="end" className="w-48">
                              <DropdownItem onSelect={() => setDetailLead(lead)}>
                                <PanelRight />
                                Open details
                              </DropdownItem>
                              <DropdownItem
                                onSelect={() => navigate(`/calls?lead=${lead.id}`)}
                              >
                                <PhoneCall />
                                See all calls
                              </DropdownItem>
                              <DropdownSeparator />
                              <DropdownItem
                                onSelect={() =>
                                  void runBulkOn([lead.id], {
                                    do_not_call: !lead.do_not_call,
                                  }, lead.do_not_call ? 'Cleared DNC on' : 'Flagged')
                                }
                              >
                                {lead.do_not_call ? <PhoneCall /> : <PhoneOff />}
                                {lead.do_not_call ? 'Clear Do Not Call' : 'Mark Do Not Call'}
                              </DropdownItem>
                              <DropdownItem
                                onSelect={() => {
                                  // Reuse the bulk confirm dialog rather than
                                  // maintaining a second one that could drift.
                                  setSelected(new Set([lead.id]))
                                  setConfirmingDelete(true)
                                }}
                              >
                                <Trash2 />
                                Delete lead
                              </DropdownItem>
                            </DropdownContent>
                          </Dropdown>
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <Pagination
                page={page}
                pageSize={LEADS_PAGE_SIZE}
                total={leads.data.total}
                // A selection must not outlive the page it was made on, or the
                // action bar reports rows that are no longer on screen.
                onPageChange={(next) => {
                  clearSelection()
                  setPage(next)
                }}
              />
            </>
          ) : (
            <EmptyState
              icon={<Table2 />}
              title="No leads match"
              description="Import a CSV of local-service businesses, or clear your filters to see everything."
              action={
                <Button variant="primary" size="sm" onClick={() => setImportOpen(true)}>
                  <Upload />
                  Import CSV
                </Button>
              }
            />
          )}
        </Panel>
      </PageBody>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent
          title={`Delete ${selected.size} ${selected.size === 1 ? 'lead' : 'leads'}?`}
          description="This cannot be undone."
          size="sm"
        >
          <DialogBody className="space-y-3 text-xs leading-relaxed text-ink-dim">
            <p>
              {selected.size === 1 ? 'This lead' : 'These leads'} will be removed from your
              list and from any session queue they are still sitting in.
            </p>
            <p className="text-ink-faint">
              Calls already placed to {selected.size === 1 ? 'it' : 'them'} are kept — the
              call log records the business name itself, so your history and stats stay
              intact. Only the lead record goes.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void confirmDelete()}
              disabled={deleteLeads.isPending}
            >
              <Trash2 />
              {deleteLeads.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddLeadDialog open={addOpen} onOpenChange={setAddOpen} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <LeadDetailDialog
        lead={detailLead}
        onClose={() => {
          setDetailLead(null)
          // Drop only the deep-link param — the filters live here too now.
          if (searchParams.has('lead')) {
            setSearchParams(
              writeLeadParams({ filters, page, sort, includeDnc }),
              { replace: true },
            )
          }
        }}
      />
    </>
  )
}

// ── Editing an existing lead ────────────────────────────────────────────────

/**
 * The fields a human edits by hand. Everything else on a lead is either
 * derived (tier, search_blob), owned by a trigger (phone_normalized,
 * call_count), or changed through its own control (stage, tags, do_not_call)
 * because those write immediately rather than waiting for Save.
 */
const EDITABLE = [
  'business_name', 'contact_name', 'phone', 'address', 'city',
  'state', 'zip', 'website', 'email', 'notes',
] as const

type LeadDraft = Record<(typeof EDITABLE)[number], string>

const EMPTY_DRAFT: LeadDraft = {
  business_name: '', contact_name: '', phone: '', address: '', city: '',
  state: '', zip: '', website: '', email: '', notes: '',
}

function toDraft(lead: Lead): LeadDraft {
  const draft = { ...EMPTY_DRAFT }
  for (const key of EDITABLE) draft[key] = lead[key] ?? ''
  return draft
}

/**
 * The diff, not the whole row.
 *
 * Blank means null for every nullable column, so clearing an email actually
 * clears it instead of storing an empty string that then reads as "set" in
 * every filter and export.
 */
function changedFields(lead: Lead, draft: LeadDraft): Partial<Lead> {
  const patch: Record<string, unknown> = {}

  for (const key of EDITABLE) {
    const next = draft[key].trim()
    const before = lead[key] ?? ''
    if (next === before) continue
    // business_name and phone are NOT NULL; the rest go back to null when emptied.
    patch[key] = next === '' && key !== 'business_name' && key !== 'phone' ? null : next
  }
  return patch as Partial<Lead>
}

/**
 * `snapshot` is the row as it looked when it was clicked — enough to paint the
 * panel instantly. Everything after that reads the live row, because half the
 * controls in here (stage, tier, tags, do-not-call) write immediately and
 * Claude writes this lead through MCP too. Rendering the snapshot would show
 * you the value from before your own click.
 */
function LeadDetailDialog({
  lead: snapshot,
  onClose,
}: {
  lead: Lead | null
  onClose: () => void
}) {
  const live = useLead(snapshot?.id ?? null)
  const lead = live.data?.id === snapshot?.id ? live.data : snapshot
  const updateLead = useUpdateLead()
  const {
    state, activeCall, pendingDisposition, duration, muted,
    startCall, hangUp, toggleMute, disposition, closeWidget, openBooking,
  } = useDialer()
  const { workspace } = useWorkspace()
  const [callNote, setCallNote] = useState('')

  // True only while THIS lead is the live call, which is what turns the panel
  // from something you read into the thing you work from.
  const isThisLead =
    (activeCall?.leadId ?? pendingDisposition?.leadId) === lead?.id
  const onCall = isThisLead && state !== 'idle'
  const awaitingDisposition = Boolean(pendingDisposition) && isThisLead

  // Two ScriptPrompters would each own their own cursor and show different
  // steps of the same script. Collapse the widget rather than duplicating it;
  // it keeps its timer as a pill.
  useEffect(() => {
    if (onCall) closeWidget()
  }, [onCall, closeWidget])
  const history = useLeadCallHistory(lead?.id)
  const brief = useLeadBrief(lead?.id)
  const script = useSessionScript(null)
  const setLeadStage = useSetLeadStage()
  const setLeadTags = useSetLeadTags()
  const queryClient = useQueryClient()
  const filterOptions = useLeadFilterOptions()
  const leadTasks = useTasks({ leadId: lead?.id })
  const pendingSteps = usePendingSteps(lead?.id)
  const updateOutcome = useUpdateCallOutcome()

  const [openCall, setOpenCall] = useState<string | null>(null)
  const [draft, setDraft] = useState<LeadDraft>(EMPTY_DRAFT)

  // The row the draft was seeded from. Kept so we can tell a field the user
  // typed in from one still holding whatever we seeded it with.
  const [seed, setSeed] = useState<Lead | null>(null)
  if (lead && lead.id !== seed?.id) {
    setSeed(lead)
    setDraft(toDraft(lead))
  }

  /**
   * The clicked row paints the form instantly, but it can be minutes old — the
   * list is cached, and both this panel's own switches and Claude write leads
   * behind it. Seeding from it and stopping there means every stale field looks
   * like an edit you made, and Save writes the old value back.
   *
   * So when the authoritative row lands, adopt it field by field, skipping any
   * field that no longer matches what it was seeded with. Stale values get
   * corrected; what you were half way through typing is never yanked away.
   */
  const liveRow = live.data
  useEffect(() => {
    if (!liveRow || !seed || liveRow.id !== seed.id || liveRow === seed) return
    const seeded = toDraft(seed)
    const fresh = toDraft(liveRow)
    setDraft((prev) => {
      const next = { ...prev }
      for (const key of EDITABLE) if (prev[key] === seeded[key]) next[key] = fresh[key]
      return next
    })
    setSeed(liveRow)
  }, [liveRow, seed])

  if (!lead) return null

  const set = (key: keyof LeadDraft) => (event: { target: { value: string } }) =>
    setDraft((prev) => ({ ...prev, [key]: event.target.value }))

  // Only what actually changed. Sending the whole row would overwrite anything
  // Claude wrote through MCP while this panel sat open, and would fire the
  // phone-normalising trigger's validation on an edit that never touched it.
  const patch = changedFields(lead, draft)
  const dirty = Object.keys(patch).length > 0
  const phoneDigits = draft.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  const phoneChanged = phoneDigits !== lead.phone_normalized

  const save = async () => {
    if (!dirty) {
      onClose()
      return
    }
    try {
      await updateLead.mutateAsync({ id: lead.id, patch })
      toast.success('Lead updated')
      onClose()
    } catch {
      // useUpdateLead already surfaced the reason; the panel stays open with
      // the edits intact so they can be corrected rather than retyped.
    }
  }

  // A panel that can now hold eight edited fields must not lose them to a
  // stray click on the backdrop.
  const requestClose = () => {
    if (dirty && !window.confirm('Discard your unsaved changes to this lead?')) return
    onClose()
  }

  return (
    <Sheet open onOpenChange={(open) => !open && requestClose()}>
      <SheetContent
        title={lead.business_name}
        description={formatPhone(lead.phone)}
        width="lg"
      >
        <SheetBody className="space-y-4">
          {(onCall || awaitingDisposition) && (
            <div className="space-y-3 rounded-[6px] border border-accent/30 bg-accent/[0.04] p-3">
              <div className="flex items-center justify-between gap-2">
                <CallStatePill state={state} duration={duration} />
                {workspace?.recording_enabled && (
                  <Badge tone="bad">
                    <span className="size-1.5 rounded-full bg-current" />
                    REC
                  </Badge>
                )}
              </div>

              {script.data && onCall && (
                <ScriptPrompter
                  script={script.data}
                  lead={lead}
                  resetKey={activeCall?.logId ?? null}
                  recording={workspace?.recording_enabled ?? true}
                />
              )}

              <Textarea
                value={callNote}
                onChange={(event) => setCallNote(event.target.value)}
                placeholder="What happened? Saved with the outcome."
                rows={2}
                className="text-[11px]"
              />

              <DispositionBar
                size="sm"
                showKeys
                disabled={!onCall && !awaitingDisposition}
                onSelect={(outcome, callbackAt) => {
                  disposition(outcome, callNote.trim() || undefined, callbackAt)
                    .then(() => {
                      setCallNote('')
                      toast.success(`Logged: ${OUTCOME_LABELS[outcome]}`)
                    })
                    .catch((e: Error) => toast.error(e.message))
                }}
              />

              {/* Roster plus "bring someone in". This panel is where calls are
                  placed from now, so it needs the same reach the widget has —
                  it had neither until this. */}
              {onCall && <ConferenceControls />}

              {onCall && (
                <div className="grid grid-cols-3 gap-2">
                  {/* Mid-call. You agree a time on the phone and book it while
                      they are still on the line, rather than logging an
                      outcome you do not mean just to reach the calendar. */}
                  <Button
                    variant="secondary"
                    onClick={() =>
                      openBooking({ id: lead.id, businessName: lead.business_name })
                    }
                  >
                    <CalendarPlus />
                    Book
                  </Button>
                  <Button variant={muted ? 'primary' : 'secondary'} onClick={toggleMute}>
                    {muted ? <MicOff /> : <Mic />}
                    {muted ? 'Unmute' : 'Mute'}
                  </Button>
                  <Button variant="danger" onClick={hangUp}>
                    <PhoneOff />
                    Hang up
                  </Button>
                </div>
              )}
            </div>
          )}

          <div
            className={cn(
              'flex flex-wrap items-center gap-3 rounded-[5px] border px-3 py-2 text-xs',
              lead.do_not_call
                ? 'border-danger/30 bg-danger/10 text-danger'
                : 'border-line bg-surface-2 text-ink-dim',
            )}
          >
            {lead.do_not_call ? (
              <>
                <Ban className="size-3.5 shrink-0" />
                <span>Flagged Do Not Call. Dialing is blocked at the database.</span>
              </>
            ) : (
              <span>Callable. Flag this number if they ask not to be contacted again.</span>
            )}
            <label className="ml-auto flex items-center gap-2 whitespace-nowrap">
              <Switch
                checked={lead.do_not_call}
                onCheckedChange={(next) =>
                  void updateLead
                    .mutateAsync({
                      id: lead.id,
                      patch: { do_not_call: next },
                    })
                    .then(() => toast.success(next ? 'Flagged Do Not Call' : 'Do Not Call cleared'))
                }
              />
              Do Not Call
            </label>
          </div>

          {brief.data ? (
            <div className="rounded-[6px] border border-accent/25 bg-accent/[0.04] px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-accent">
                  {brief.data.title}
                </p>
                <span className="text-[10px] text-ink-faint">
                  {brief.data.author === 'claude' ? 'Written by Claude' : 'Generated'}
                  {' · '}
                  {formatRelative(brief.data.updated_at)}
                </span>
              </div>
              <Markdown>{brief.data.body_md}</Markdown>
              {Object.keys(brief.data.summary_json ?? {}).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line-soft pt-2">
                  {Object.entries(brief.data.summary_json).map(([k, v]) => (
                    <span
                      key={k}
                      className="rounded-[3px] border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-dim"
                    >
                      <span className="text-ink-faint">{k.replace(/_/g, ' ')}:</span>{' '}
                      {String(v)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="rounded-[6px] border border-dashed border-line px-3 py-2.5 text-[11px] text-ink-faint">
              No brief yet. Ask Claude to research this lead and it will appear here.
            </p>
          )}

          <div className="space-y-3 rounded-[6px] border border-line bg-surface-2/40 p-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                Details
              </p>
              <span className="text-[10px] text-ink-faint">
                {lead.call_count} {lead.call_count === 1 ? 'call' : 'calls'} placed
                {' · added '}{formatRelative(lead.created_at)}
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Business name">
                <Input value={draft.business_name} onChange={set('business_name')} />
              </Field>
              <Field
                label="Phone"
                hint={
                  phoneDigits.length < 10
                    ? 'Needs at least 10 digits — the database will refuse it.'
                    : phoneChanged
                      ? 'Changing this repoints the lead at a different number. ' +
                        'Past calls stay on the record under the old one.'
                      : undefined
                }
              >
                <Input
                  value={draft.phone}
                  onChange={set('phone')}
                  inputMode="tel"
                  className="tabular"
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Contact" hint="Who to ask for when they pick up.">
                <Input value={draft.contact_name} onChange={set('contact_name')} />
              </Field>
              <Field
                label="Rooms"
                hint="Blank means unknown, which is not the same as small."
              >
                <Input
                  type="number"
                  min={1}
                  max={2000}
                  className="tabular"
                  defaultValue={lead.room_count ?? ''}
                  key={`rooms-${lead.id}-${lead.room_count ?? ''}`}
                  onBlur={(event) => {
                    const raw = event.target.value.trim()
                    const next = raw === '' ? null : Number.parseInt(raw, 10)
                    if (next !== null && (!Number.isFinite(next) || next < 1 || next > 2000)) return
                    if (next === (lead.room_count ?? null)) return
                    void updateLead.mutateAsync({ id: lead.id, patch: { room_count: next } })
                      .catch(() => {})
                  }}
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-1">
              <Field label="Address">
                <Input value={draft.address} onChange={set('address')} />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="City"><Input value={draft.city} onChange={set('city')} /></Field>
              <Field label="State"><Input value={draft.state} onChange={set('state')} /></Field>
              <Field label="ZIP"><Input value={draft.zip} onChange={set('zip')} /></Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Website">
                <div className="flex gap-1.5">
                  <Input value={draft.website} onChange={set('website')} />
                  {lead.website && (
                    <a
                      href={lead.website.startsWith('http') ? lead.website : `https://${lead.website}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label="Open website"
                      className="flex h-8 shrink-0 items-center rounded-[5px] border border-line px-2 text-accent transition-colors hover:border-accent"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  )}
                </div>
              </Field>
              <Field label="Email">
                <Input value={draft.email} onChange={set('email')} inputMode="email" />
              </Field>
            </div>
          </div>


          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Pipeline stage"
              hint="Moving a lead can create follow-up tasks."
            >
              <Select
                value={lead.pipeline_stage}
                onValueChange={(value) =>
                  setLeadStage.mutate(
                    { id: lead.id, stage: value },
                    {
                      onSuccess: () =>
                        toast.success(`Moved to ${STAGE_LABELS[value as PipelineStage]}`),
                    },
                  )
                }
                options={ALL_STAGES.map((st) => ({ value: st, label: STAGE_LABELS[st] }))}
              />
            </Field>
            <Field
              label="Appointment"
              hint={
                lead.scheduled_at
                  ? 'Reminders anchored to this move with it.'
                  : pendingSteps.data
                    ? `${pendingSteps.data} playbook ${pendingSteps.data === 1 ? 'step is' : 'steps are'} waiting on this date.`
                    : 'The demo date. Set it and any T-1 reminder appears.'
              }
            >
              <Input
                type="datetime-local"
                defaultValue={toDateTimeLocal(lead.scheduled_at)}
                key={lead.id + (lead.scheduled_at ?? '')}
                /*
                 * onBlur, not onChange. A datetime-local emits an empty value
                 * for every intermediate state while you are still typing the
                 * date, and writing those cleared the appointment — cancelling
                 * the reminders anchored to it — halfway through setting one.
                 */
                onBlur={(event) => {
                  const next = fromDateTimeLocal(event.target.value)
                  // Blur fires whether or not anything changed; writing anyway
                  // would re-anchor every reminder and toast at you for merely
                  // clicking through the field. Compared as instants, not
                  // strings: Postgres hands back "2026-09-20 18:00:00+00",
                  // which never equals the same moment's toISOString().
                  const asMs = (v: string | null) => (v ? new Date(v).getTime() : null)
                  if (asMs(next) === asMs(lead.scheduled_at)) return
                  void updateLead
                    .mutateAsync({ id: lead.id, patch: { scheduled_at: next } })
                    .then(() => {
                      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
                      toast.success(next ? 'Appointment set' : 'Appointment cleared')
                    })
                    .catch(() => {})
                }}
              />
            </Field>
            {/* Beside the appointment, not merged with it. One is the demo you
                booked; the other is the hour they told you to ring back, and
                each anchors its own playbook's reminders. */}
            <Field
              label="Callback"
              hint={
                lead.callback_at
                  ? 'The callback follow-ups move with this.'
                  : lead.outcome === 'callback_requested'
                    ? 'No time agreed yet — set one and its follow-ups appear.'
                    : 'When they asked to be rung back.'
              }
            >
              <Input
                type="datetime-local"
                defaultValue={toDateTimeLocal(lead.callback_at)}
                key={`cb-${lead.id}-${lead.callback_at ?? ''}`}
                onBlur={(event) => {
                  const next = fromDateTimeLocal(event.target.value)
                  const asMs = (v: string | null) => (v ? new Date(v).getTime() : null)
                  if (asMs(next) === asMs(lead.callback_at)) return
                  void updateLead
                    .mutateAsync({ id: lead.id, patch: { callback_at: next } })
                    .then(() => {
                      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
                      toast.success(next ? 'Callback set' : 'Callback cleared')
                    })
                    .catch(() => {})
                }}
              />
            </Field>
            <Field
              label="Tier"
              hint={
                lead.tier_override
                  ? 'Set by you — Claude cannot change it.'
                  // Said, because a tier that quietly disagrees with the brief
                  // beside it reads as a bug rather than a rule.
                  : lead.below_size_floor
                    ? `Capped at C — under your ${workspace?.min_rooms ?? ''}-room floor. The brief said ${(lead.tier_suggested ?? '—').toUpperCase()}.`
                  : lead.tier_suggested_reason
                    ? `Claude: ${lead.tier_suggested_reason}`
                    : 'Claude has not suggested one yet.'
              }
            >
              <Select
                value={lead.tier ?? undefined}
                placeholder="Not rated"
                onValueChange={(value) =>
                  void updateLead
                    .mutateAsync({ id: lead.id, patch: { tier_override: value as LeadTier } })
                    .then(() => toast.success(`Tier ${value.toUpperCase()}`))
                }
                options={ALL_TIERS.map((t) => ({
                  value: t,
                  label: `Tier ${t.toUpperCase()}`,
                }))}
              />
            </Field>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Tags
            </p>
            <TagEditor
              tags={lead.tags}
              suggestions={filterOptions.data?.tags ?? []}
              disabled={setLeadTags.isPending}
              onAdd={(tag) => setLeadTags.mutate({ id: lead.id, tags: [tag], mode: 'add' })}
              onRemove={(tag) => setLeadTags.mutate({ id: lead.id, tags: [tag], mode: 'remove' })}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {/* "Last call", not "Current outcome". It describes the most recent
                call, not a second state of the lead — which is exactly how it
                read next to Status, and half the reason there were three fields
                here to keep straight. */}
            <Field label="Last call outcome" hint="From the newest call. Change it in the call history below.">
              <Input
                readOnly
                value={lead.outcome ? OUTCOME_LABELS[lead.outcome] : 'Not dispositioned'}
                className="text-ink-dim"
              />
            </Field>
          </div>

          <Field label="Notes">
            <Textarea
              value={draft.notes}
              onChange={set('notes')}
              placeholder="Context for the next call…"
            />
          </Field>

          {(leadTasks.data ?? []).length > 0 && (
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                Open follow-ups
              </p>
              <ul className="divide-y divide-line-soft rounded-[6px] border border-line">
                {(leadTasks.data ?? []).map((task) => (
                  <li key={task.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="flex-1 truncate text-xs text-ink">{task.title}</span>
                    <span
                      className={cn(
                        'shrink-0 text-[10px]',
                        new Date(task.due_at) < new Date() ? 'text-warn' : 'text-ink-faint',
                      )}
                    >
                      {formatRelative(task.due_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <LeadMetadata data={lead.metadata_json} roomCount={lead.room_count} />

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                Call history
              </p>
              {/* The panel shows at most ten; this reaches the rest, with
                  recordings and transcripts. */}
              <Link
                to={`/calls?lead=${lead.id}`}
                onClick={onClose}
                className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
              >
                See all calls
                <ExternalLink className="size-3" />
              </Link>
            </div>
            {history.data?.length ? (
              <ul className="divide-y divide-line-soft rounded-[6px] border border-line">
                {history.data.map((call) => {
                  const open = openCall === call.id
                  const transcript = transcriptOf(call)

                  return (
                    <li key={call.id}>
                      {/* Expandable in place. "See all calls" sent you to
                          another page to answer a question you were already
                          looking at the lead to ask. */}
                      <button
                        type="button"
                        onClick={() => setOpenCall(open ? null : call.id)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-2"
                      >
                        {open ? (
                          <ChevronDown className="size-3 shrink-0 text-ink-faint" />
                        ) : (
                          <ChevronRight className="size-3 shrink-0 text-ink-faint" />
                        )}
                        {call.direction === 'inbound' && (
                          <PhoneIncoming className="size-3 shrink-0 text-accent" />
                        )}
                        <span className="tabular flex-1 text-xs text-ink-dim">
                          {formatDateTime(call.called_at)}
                        </span>
                        {call.duration_seconds > 0 && (
                          <span className="tabular shrink-0 text-[11px] text-ink-faint">
                            {formatDuration(call.duration_seconds)}
                          </span>
                        )}
                        {call.recording_sid && (
                          <Mic className="size-3 shrink-0 text-accent" aria-label="Recorded" />
                        )}
                        {call.outcome && (
                          <Badge tone={OUTCOME_TONES[call.outcome]}>
                            {OUTCOME_LABELS[call.outcome]}
                          </Badge>
                        )}
                      </button>

                      {open && (
                        <div className="space-y-3 border-t border-line-soft bg-base/40 px-3 py-3">
                          {/*
                           * The outcome is editable here, not only in the call
                           * log. This panel used to argue that reading a call
                           * and acting on it were different jobs — but you get
                           * here by opening the lead, reading the transcript,
                           * and realising the disposition is wrong, and being
                           * sent to another page to fix it is the whole problem.
                           * Deleting a call still lives in the log: destructive
                           * and one place to do it.
                           */}
                          <div>
                            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                              Change outcome
                            </p>
                            <DispositionBar
                              size="sm"
                              selected={call.outcome}
                              onSelect={(outcome, callbackAt) => {
                                updateOutcome.mutate(
                                  {
                                    callId: call.id, leadId: lead?.id ?? null,
                                    outcome, callbackAt,
                                  },
                                  {
                                    onSuccess: () =>
                                      toast.success(`Updated to ${OUTCOME_LABELS[outcome]}`),
                                  },
                                )
                              }}
                            />
                          </div>

                          <Link
                            to={`/calls?call=${call.id}`}
                            onClick={onClose}
                            className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                          >
                            Open this call in the log
                            <ExternalLink className="size-3" />
                          </Link>

                          {call.recording_sid ? (
                            <RecordingPlayer callId={call.id} />
                          ) : (
                            <p className="text-[11px] text-ink-faint">
                              No recording for this call.
                            </p>
                          )}

                          <CallNote callId={call.id} notes={call.notes ?? null} />

                          {transcript ? (
                            <Transcript
                              text={transcript}
                              speakerConfidence={transcriptRow(call)?.speaker_confidence}
                            />
                          ) : (
                            <p className="text-[11px] text-ink-faint">
                              {call.recorded &&
                                Date.now() - new Date(call.called_at).getTime() < 15 * 60 * 1000
                                ? 'Transcribing… this usually lands about a minute after the call.'
                                : 'No transcript for this call.'}
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-xs text-ink-faint">No calls placed yet.</p>
            )}
          </div>
        </SheetBody>

        <SheetFooter>
          <Button
            variant="outline"
            onClick={() => openBooking({ id: lead.id, businessName: lead.business_name })}
          >
            <CalendarPlus />
            Book
          </Button>
          <Button
            variant="outline"
            disabled={lead.do_not_call}
            onClick={() => {
              void startCall({
                phone: lead.phone,
                businessName: lead.business_name,
                leadId: lead.id,
                // Without this the call records no script, and Analytics'
                // "which opener works" has nothing to group by — the prompter
                // was running the default script and the log said null.
                scriptId: script.data?.id ?? null,
              })
              // Deliberately not closing. The rep opened this panel to read the
              // brief and decide to call; taking it away the instant the phone
              // rings is the worst possible moment for a context switch.
            }}
          >
            <Phone />
            Call now
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={updateLead.isPending || !dirty}
          >
            {updateLead.isPending ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
