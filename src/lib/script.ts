import type { CallScript, Lead, ScriptBlock } from './types'
import { formatPhone } from './utils'

/**
 * Fill {{business_name}} style placeholders from the lead.
 *
 * An unmatched placeholder is left visibly intact rather than blanked: reading
 * "Hi, is this the owner of ?" out loud is worse than seeing the gap and
 * improvising.
 */
export function interpolate(text: string, lead: Lead | null | undefined): string {
  if (!lead) return text

  const values: Record<string, string> = {
    business_name: lead.business_name ?? '',
    // {{contact_name}} in an opener degrades well on its own: with no name the
    // placeholder stays visible and you improvise, which is the right prompt
    // for a script you are reading aloud.
    contact_name: lead.contact_name ?? '',
    city: lead.city ?? '',
    state: lead.state ?? '',
    phone: formatPhone(lead.phone),
    address: lead.address ?? '',
    zip: lead.zip ?? '',
    website: lead.website ?? '',
  }

  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
    const value = values[key]
    return value && value.trim() ? value : whole
  })
}

export function blockById(script: CallScript | null | undefined, id: string | null): ScriptBlock | null {
  if (!script || !id) return null
  return script.blocks.find((b) => b.id === id) ?? null
}

/**
 * Where "next" goes: the block's explicit `next`, else the one after it in
 * document order. Authors get sequential flow for free and only declare `next`
 * when they want to jump.
 */
export function nextBlockId(script: CallScript, currentId: string): string | null {
  const current = blockById(script, currentId)
  if (current?.next) return current.next

  const index = script.blocks.findIndex((b) => b.id === currentId)
  if (index === -1 || index === script.blocks.length - 1) return null
  return script.blocks[index + 1].id
}

export function previousBlockId(script: CallScript, currentId: string): string | null {
  const index = script.blocks.findIndex((b) => b.id === currentId)
  if (index <= 0) return null
  return script.blocks[index - 1].id
}

/** A starter script, so a new workspace has something to react to rather than a blank editor. */
export function starterScript(): { name: string; description: string; blocks: ScriptBlock[]; entry: string } {
  return {
    name: 'Local services cold call',
    description: 'Opening, a qualifying question, the pitch, common objections, and a close.',
    entry: 'opening',
    blocks: [
      {
        id: 'opening',
        kind: 'opening',
        label: 'Opening',
        text: "Hi, is this the owner of {{business_name}}?",
        advance_on: ['speaking', "that's me", 'yes', 'this is'],
        branches: [
          { trigger: ['not available', 'not in', 'out of office'], goto: 'gatekeeper', label: 'Gatekeeper' },
        ],
        next: 'reason',
      },
      {
        id: 'reason',
        kind: 'pitch',
        label: 'Reason for the call',
        text: "Great - I'll be quick. I work with service businesses in {{city}} and I noticed you might be missing calls after hours. Can I ask how you handle those right now?",
        branches: [
          { trigger: ['not interested', 'all set', 'no thanks'], goto: 'obj_not_interested', label: 'Not interested' },
          { trigger: ['how much', 'cost', 'price'], goto: 'obj_price', label: 'Asks about price' },
          { trigger: ['busy', 'bad time', 'call back'], goto: 'obj_busy', label: 'Busy right now' },
        ],
        next: 'qualify',
      },
      {
        id: 'qualify',
        kind: 'question',
        label: 'Qualify',
        text: "Got it. And roughly how many calls a week do you think go to voicemail?",
        next: 'close',
      },
      {
        id: 'close',
        kind: 'close',
        label: 'Close',
        text: "That's exactly what we fix. I'd like to show you what it looks like - do you have fifteen minutes Tuesday or Thursday?",
      },
      {
        id: 'gatekeeper',
        kind: 'objection',
        label: 'Gatekeeper',
        text: "No problem - when's the best time to catch them? I'll call back then rather than leave a message.",
      },
      {
        id: 'obj_not_interested',
        kind: 'objection',
        label: 'Not interested',
        text: "Totally fair, you don't know me yet. Can I ask one question - if a customer calls at 7pm and gets voicemail, what usually happens?",
        next: 'qualify',
      },
      {
        id: 'obj_price',
        kind: 'objection',
        label: 'Asks about price',
        text: "Good question - it depends on call volume, and I'd rather not guess. That's really why I wanted fifteen minutes. Do you have time Tuesday?",
        next: 'close',
      },
      {
        id: 'obj_busy',
        kind: 'objection',
        label: 'Busy right now',
        text: "Understood - I'll be quick or I'll call back. Which is easier?",
      },
      {
        id: 'voicemail',
        kind: 'voicemail',
        label: 'Voicemail',
        text: "Hi, this is [your name] for the owner of {{business_name}}. I had a quick question about how you handle after-hours calls. I'll try you again - or reach me at [your number].",
      },
    ],
  }
}
