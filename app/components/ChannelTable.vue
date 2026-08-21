<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual'
import { chirpMode, txFrequency, type Channel } from '#core/model/channel.js'
import type { Diagnostic } from '#core/radio/driver.js'
import type { Codeplug } from '#core/model/codeplug.js'
import { describeTone } from '#core/model/tones.js'
import { formatFreq, formatPower, parseFreq } from '#core/model/units.js'
import { diffChannels } from '#core/radio/channel-diff.js'
import { exportChirpCsv } from '#core/io/chirp-csv.js'

/**
 * The expert surface: every channel the radio holds, at a density that can be
 * read rather than merely fitted.
 *
 * Density here comes from ranking, not shrinking. Slot, name, receive and
 * transmit carry full contrast; tone, mode, step and power sit a step back so
 * the eye can skip them. The 20px status gutter is what makes the table
 * answerable before a single word is read: an error, a receive-only channel, an
 * unwritten edit and an empty slot each have their own glyph and colour, and
 * the two that carry consequence also tint the row.
 */
const emit = defineEmits<{ edit: [Channel]; create: [number] }>()

const codeplug = useCodeplugStore()
const session = useRadioSession()
const { printing, print } = usePrintMode()

type Facet = 'all' | 'rx' | 'err' | 'edit' | 'empty'
type EditCol = 'name' | 'rx'
type RowState = 'error' | 'receive-only' | 'edited' | 'empty' | 'ok'

/** A memory slot, whether or not a channel is programmed into it. */
interface SlotRow {
  readonly index: number
  readonly channel: Channel | null
}

const query = ref('')
const facet = ref<Facet>('all')
const selected = ref(new Set<number>())

const ROW_HEIGHT = 30

/*
 * The columns that can be put away.
 *
 * Slot, name, receive and transmit are the table's spine and stay. The four
 * ranked-back columns and the state flag are the ones someone who knows their
 * codeplug can hide to get more room for names on a narrow laptop - a choice,
 * never a default: the table opens with every column the radio has.
 */
const optional = reactive({ tone: true, mode: true, step: true, power: true, flag: true })

const OPTIONAL_COLUMNS = [
  { key: 'tone', label: 'Tone', width: 52 },
  { key: 'mode', label: 'Mode', width: 44 },
  { key: 'step', label: 'Step', width: 44 },
  { key: 'power', label: 'Power', width: 48 },
  { key: 'flag', label: 'State', width: 104 },
] as const

/**
 * Checkbox · gutter · slot · name · receive · shift · transmit.
 *
 * A list rather than one string because print drops the first track - the
 * checkbox selects nothing on paper - and dropping it by index is a change the
 * next person to retune a width cannot silently break.
 */
const FIXED_COLUMNS = ['26px', '20px', '34px', 'minmax(90px,1fr)', '82px', '54px', '82px'] as const
const FIXED_WIDTH = 26 + 20 + 34 + 90 + 82 + 54 + 82

const gridColumns = computed(() =>
  [
    ...(printing.value ? FIXED_COLUMNS.slice(1) : FIXED_COLUMNS),
    ...OPTIONAL_COLUMNS.filter((c) => optional[c.key]).map((c) => `${c.width}px`),
  ].join(' '),
)

/**
 * Below this the table scrolls sideways rather than dropping columns.
 *
 * A radio is tethered by USB, so the desktop is the target; but a column that
 * silently disappears at a certain width is worse than a scrollbar, because the
 * reader has no way to know a value existed.
 */
const minWidth = computed(() => {
  // A sheet of paper cannot be scrolled sideways, so the floor that protects a
  // narrow laptop would only push the last columns off the edge of the page.
  if (printing.value) return 0
  const shown = OPTIONAL_COLUMNS.filter((c) => optional[c.key])
  const px = FIXED_WIDTH + shown.reduce((n, c) => n + c.width, 0)
  return px + 8 * (6 + shown.length) + 20
})

/**
 * The codeplug as the radio holds it, decoded once per image.
 *
 * Needed to tell an edit from an original, and deliberately taken from the same
 * comparison the write flow uses: if the gutter says a row changed, the diff
 * before the write says so too, because both come from `diffChannels`.
 */
const baseline = computed<Codeplug | null>(() => {
  const driver = codeplug.driverRef
  const image = codeplug.image
  if (!driver || !image) return null
  try {
    return markRaw(driver.decode(image))
  } catch {
    // An image this build cannot decode is not an error here - the table simply
    // cannot say which rows are edits, and says nothing rather than guessing.
    return null
  }
})

const editedSlots = computed<ReadonlySet<number>>(() => {
  void codeplug.revision
  const before = baseline.value
  const after = codeplug.doc
  if (!before || !after) return new Set<number>()
  return new Set(diffChannels(before, after).changes.map((c) => c.slot))
})

const errorSlots = computed<ReadonlySet<number>>(() => {
  const out = new Set<number>()
  for (const d of codeplug.diagnostics) {
    if (d.severity === 'error' && d.channel !== undefined) out.add(d.channel)
  }
  return out
})

const bySlot = computed(() => new Map(codeplug.channels.map((c) => [c.index, c])))

/**
 * Every slot the radio has, not every channel it holds.
 *
 * An empty slot is a fact worth showing - it is where a preset can land - so
 * the table is built over the memory range the schema declares and the channels
 * are dropped into it. Anything outside that range (the UV-K5's VFO
 * pseudo-channels) is appended rather than hidden, because a channel the table
 * cannot show is a channel the user cannot fix.
 */
const slots = computed<SlotRow[]>(() => {
  const channels = bySlot.value
  const memory = codeplug.schema?.memory
  const out: SlotRow[] = []
  const placed = new Set<number>()

  if (memory) {
    for (let i = memory.firstIndex; i < memory.firstIndex + memory.channelCount; i++) {
      out.push({ index: i, channel: channels.get(i) ?? null })
      placed.add(i)
    }
    for (const special of memory.specialChannels) {
      if (placed.has(special.index)) continue
      out.push({ index: special.index, channel: channels.get(special.index) ?? null })
      placed.add(special.index)
    }
  }

  for (const c of codeplug.channels) {
    if (!placed.has(c.index)) out.push({ index: c.index, channel: c })
  }
  return out
})

const emptyCount = computed(() => slots.value.length - codeplug.channelCount)

const rows = computed<SlotRow[]>(() => {
  const q = query.value.trim().toLowerCase()
  const f = facet.value
  const errors = errorSlots.value
  const edits = editedSlots.value

  return slots.value.filter((r) => {
    const c = r.channel
    if (f === 'rx' && (c === null || c.txAllowed)) return false
    if (f === 'err' && !errors.has(r.index)) return false
    if (f === 'edit' && !edits.has(r.index)) return false
    if (f === 'empty' && c !== null) return false
    if (!q) return true
    if (String(r.index) === q) return true
    if (c === null) return false
    return c.name.toLowerCase().includes(q) || formatFreq(c.rxFreq).includes(q)
  })
})

const facets = computed(() => [
  { key: 'all' as const, label: 'All', icon: 'i-lucide-list', tone: 'var(--tx)', count: slots.value.length },
  { key: 'rx' as const, label: 'Receive-only', icon: 'i-lucide-lock', tone: 'var(--cn)', count: codeplug.rxOnlyCount },
  { key: 'err' as const, label: 'Errors', icon: 'i-lucide-circle-alert', tone: 'var(--dg)', count: errorSlots.value.size },
  { key: 'edit' as const, label: 'Edited', icon: 'i-lucide-pencil', tone: 'var(--in)', count: editedSlots.value.size },
  { key: 'empty' as const, label: 'Empty', icon: 'i-lucide-circle-minus', tone: 'var(--tx)', count: emptyCount.value },
])

// ---------------------------------------------------------------- diagnostics

interface DiagGroup {
  readonly ruleId: string
  readonly severity: Diagnostic['severity']
  readonly message: string
  readonly count: number
  readonly slots: readonly number[]
  /** True when every diagnostic in the group is about transmit, so one edit clears them all. */
  readonly aboutTransmit: boolean
}

/**
 * One row per rule, never one per channel.
 *
 * A codeplug with 29 receive-only channels produces 29 identical sentences, and
 * printing them is how a diagnostics panel becomes furniture. The count and the
 * slot range carry the same information in a form that can be acted on.
 */
const groups = computed<DiagGroup[]>(() => {
  const byRule = new Map<string, Diagnostic[]>()
  for (const d of codeplug.diagnostics) {
    const list = byRule.get(d.ruleId)
    if (list) list.push(d)
    else byRule.set(d.ruleId, [d])
  }

  const rank = { error: 0, warning: 1, info: 2 } as const
  return [...byRule.values()]
    .map((list) => {
      const first = list[0]!
      return {
        ruleId: first.ruleId,
        severity: first.severity,
        message: first.message,
        count: list.length,
        slots: list.map((d) => d.channel).filter((n): n is number => n !== undefined),
        aboutTransmit: first.severity === 'error' && list.every((d) => d.field === 'tx'),
      }
    })
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count)
})

/** `slots 6–11, 22–24` - contiguous runs collapsed, because a list of 29 numbers is not a location. */
function slotRanges(list: readonly number[]): string {
  if (list.length === 0) return ''
  const sorted = [...list].sort((a, b) => a - b)
  const parts: string[] = []
  let start = sorted[0]!
  let prev = start
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) {
      prev = n
      continue
    }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`)
    start = n
    prev = n
  }
  parts.push(start === prev ? `${start}` : `${start}–${prev}`)

  const shown = parts.slice(0, 4).join(', ')
  const rest = parts.length > 4 ? ` +${parts.length - 4} more` : ''
  return `${sorted.length === 1 ? 'slot' : 'slots'} ${shown}${rest}`
}

function allReceiveOnly(g: DiagGroup): boolean {
  return g.slots.length > 0 && g.slots.every((s) => bySlot.value.get(s)?.txAllowed === false)
}

/** Filter the table down to what a rule is complaining about, then scroll to the first of them. */
function showGroup(g: DiagGroup) {
  query.value = ''
  facet.value = g.severity === 'error' ? 'err' : allReceiveOnly(g) ? 'rx' : 'all'
  const first = g.slots[0]
  if (first === undefined) return
  void nextTick(() => {
    const at = rows.value.findIndex((r) => r.index === first)
    if (at >= 0) ensureVisible(at)
  })
}

/**
 * The fix a rule offers, or a way to see it.
 *
 * Only one fix is ever applied automatically, and only to the rule that has a
 * single unambiguous remedy: a channel whose transmit frequency lands where
 * transmitting is not permitted becomes receive-only. Everything else takes the
 * user to the rows and lets them decide.
 */
function fixFor(g: DiagGroup): { label: string; icon: string } {
  return g.aboutTransmit
    ? { label: 'Disable transmit', icon: 'i-lucide-lock' }
    : { label: 'Show them', icon: 'i-lucide-filter' }
}

function runFix(g: DiagGroup) {
  if (!g.aboutTransmit) {
    showGroup(g)
    return
  }
  // One click silenced twenty-nine channels, so one undo has to bring them all
  // back. Without the transaction the history would fill with twenty-nine
  // identical steps and the user would have to click through every one of them.
  codeplug.transact('transmit fix', () => {
    for (const slot of g.slots) {
      if (bySlot.value.get(slot)?.txAllowed !== true) continue
      codeplug.updateChannel(slot, { txAllowed: false, txInhibitReason: 'Marked receive-only' })
    }
  })
}

// --------------------------------------------------------------------- rows

/**
 * A rule id read as a label: `regulatory.band.tx-not-permitted` becomes
 * `TX not permitted`.
 *
 * Derived rather than mapped on purpose. The table cannot know every driver's
 * rules - each radio brings its own - and a hard-coded table would show a blank
 * cell for the rules it had never heard of, which is the one case where the
 * user most needs a word.
 */
function shortRule(ruleId: string): string {
  const tail = ruleId.split('.').pop() ?? ruleId
  return tail
    .split('-')
    .map((w, i) => {
      if (w === 'tx' || w === 'rx') return w.toUpperCase()
      return i === 0 && w ? w[0]!.toUpperCase() + w.slice(1) : w
    })
    .join(' ')
}

function firstError(slot: number): Diagnostic | undefined {
  return codeplug.diagnosticsByChannel.get(slot)?.find((d) => d.severity === 'error')
}

function stateOf(r: SlotRow): RowState {
  if (r.channel && errorSlots.value.has(r.index)) return 'error'
  if (r.channel && !r.channel.txAllowed) return 'receive-only'
  if (editedSlots.value.has(r.index)) return 'edited'
  if (!r.channel) return 'empty'
  return 'ok'
}

/**
 * The gutter's four states, in two alphabets.
 *
 * `mark` is the printed one, and it exists because the screen one cannot be
 * printed: an icon here is a `mask-image`, which a printer drops along with
 * every other background graphic unless the person printing went looking for
 * the setting. A receive-only channel is the one row state where losing the
 * marking is dangerous rather than untidy, so on paper it is two letters.
 */
const GUTTER: Record<Exclude<RowState, 'ok'>, { icon: string; color: string; title: string; mark: string }> = {
  'error': { icon: 'i-lucide-triangle-alert', color: 'var(--dg)', title: 'Transmit lands in a receive-only allocation', mark: '!' },
  'receive-only': { icon: 'i-lucide-lock', color: 'var(--cn)', title: 'Receive-only, transmit disabled', mark: 'RX' },
  'edited': { icon: 'i-lucide-pencil', color: 'var(--in)', title: 'Changed, not yet written', mark: '*' },
  'empty': { icon: 'i-lucide-circle-minus', color: 'var(--ln2)', title: 'Empty slot', mark: '·' },
}

/** The offset column. The absolute transmit frequency is the next column along, so this stays short. */
function shiftLabel(c: Channel): string {
  if (!c.txAllowed) return '—'
  switch (c.tx.kind) {
    case 'simplex':
      return '—'
    case 'offset':
      return `${c.tx.direction === 'plus' ? '+' : '−'}${(c.tx.offset / 1e6).toFixed(3)}`
    case 'split':
      return 'split'
  }
}

interface RowView {
  state: RowState
  dim: boolean
  background: string
  gutter: { icon: string; color: string; title: string; mark: string } | null
  name: string
  rx: string
  shift: string
  tx: string
  txColor: string
  txWeight: number
  tone: string
  mode: string
  step: string
  power: string
  flag: string
  flagIcon: string
  flagColor: string
}

function view(r: SlotRow): RowView {
  const c = r.channel
  const state = stateOf(r)
  const dim = c === null
  // Never stored, always derived: a repeater shift is the difference between
  // where a channel listens and where it keys up, and reading transmit off the
  // stored offset is how a table ends up disagreeing with the radio.
  const tx = c ? txFrequency(c) : null
  const error = state === 'error' ? firstError(r.index) : undefined
  const gutter = state === 'ok' ? null : { ...GUTTER[state] }
  if (gutter && error) gutter.title = error.message

  const flag =
    state === 'error'
      ? shortRule(error?.ruleId ?? '')
      : state === 'edited'
        ? 'Edited'
        : state === 'receive-only'
          ? 'Receive-only'
          : ''

  return {
    state,
    dim,
    background: state === 'error' ? 'var(--dgB)' : state === 'receive-only' ? 'var(--cnB)' : 'transparent',
    gutter,
    name: c ? c.name || '—' : '—',
    rx: c ? formatFreq(c.rxFreq) : '—',
    shift: c ? shiftLabel(c) : '—',
    tx: c === null ? '—' : tx === null ? 'TX off' : formatFreq(tx),
    txColor: dim
      ? 'var(--ln2)'
      : state === 'error'
        ? 'var(--dg)'
        : c && !c.txAllowed
          ? 'var(--cn)'
          : 'var(--tx)',
    txWeight: c && !c.txAllowed ? 500 : 400,
    // The unit is implied by the column and by the D prefix DTCS codes carry,
    // and the column is 52px: "162.2 Hz" clipped mid-unit says less than "162.2".
    tone: c ? describeTone(c.tone.tx).replace(' Hz', '') : '—',
    mode: c ? chirpMode(c) : '—',
    step: c ? (c.tuningStep / 1000).toFixed(2) : '—',
    power: c ? (c.power.label ?? formatPower(c.power.mW)) : '—',
    flag,
    flagIcon:
      state === 'error'
        ? 'i-lucide-triangle-alert'
        : state === 'receive-only'
          ? 'i-lucide-lock'
          : state === 'edited'
            ? 'i-lucide-pencil'
            : '',
    flagColor: state === 'error' ? 'var(--dg)' : state === 'receive-only' ? 'var(--cn)' : 'var(--fn)',
  }
}

// -------------------------------------------------------------- virtualiser

const scroller = useTemplateRef<HTMLElement>('scroller')
const headerEl = useTemplateRef<HTMLElement>('headerEl')

// A UV-K5 holds 200 slots and a DM-32UV holds 4000, and this is the same
// component for both. Rendering only the visible window is what keeps it usable
// at either size.
const virtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => scroller.value ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })),
)

const totalHeight = computed(() => virtualizer.value.getTotalSize())

/**
 * What goes on the paper: every channel the filter admits, and no empty slots.
 *
 * "Every channel" rather than "every slot" is the literal reading and also the
 * kind one - a DM-32UV holds 4,000 slots and a club plan fills two hundred, so
 * printing the memory map rather than the plan would turn eight pages into a
 * hundred and thirty of dashes. The one filter that means the empties *are* the
 * subject is honoured, because a person who ticked "Empty" and pressed print
 * asked for exactly that.
 */
const printRows = computed<SlotRow[]>(() =>
  facet.value === 'empty' ? rows.value : rows.value.filter((r) => r.channel !== null),
)

/**
 * The rows that actually get mounted.
 *
 * On screen this is the virtualiser's window - forty-odd rows, which is what
 * keeps four thousand slots scrollable. While printing it is the whole list,
 * laid out in normal flow so the browser can paginate it: absolutely positioned
 * rows inside a fixed-height box print as one screenful and lose the rest,
 * which is the failure this exists to prevent. Rendering four thousand rows
 * once is affordable; doing it on every keystroke is not, which is why this is
 * a mode rather than a setting.
 */
const renderedRows = computed(() => {
  if (printing.value) {
    return printRows.value.map((row) => ({ key: row.index, start: 0, size: ROW_HEIGHT, row, view: view(row) }))
  }
  return virtualizer.value.getVirtualItems().map((item) => {
    const row = rows.value[item.index]!
    return { key: row.index, start: item.start, size: item.size, row, view: view(row) }
  })
})

/** The spacer the virtualiser needs, and that print must not inherit. */
const bodyStyle = computed(() =>
  printing.value
    ? { position: 'relative' as const }
    : { height: `${totalHeight.value}px`, minWidth: `${minWidth.value}px`, position: 'relative' as const },
)

function rowStyle(r: { start: number; size: number; row: SlotRow; view: RowView }) {
  const base = {
    gridTemplateColumns: gridColumns.value,
    gap: '8px',
    padding: '0 10px',
    height: `${r.size}px`,
    cursor: r.row.channel ? 'pointer' : 'default',
    borderBottom: '1px solid var(--ln)',
    background: r.view.background,
  }
  if (printing.value) return base
  return {
    ...base,
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    transform: `translateY(${r.start}px)`,
  }
}

/**
 * Scroll a row clear of the sticky header.
 *
 * Done by arithmetic rather than `scrollToIndex` because the header floats over
 * the first visible row: the virtualiser would happily park the target
 * underneath it, which for a cell about to take the caret is indistinguishable
 * from the keystroke doing nothing.
 */
function ensureVisible(position: number) {
  const el = scroller.value
  if (!el) return
  // The header sits in the flow above the rows and then sticks, so it counts
  // twice: once as the offset of every row, and once as the strip of viewport
  // the row must clear.
  const header = headerEl.value?.offsetHeight ?? 0
  const top = header + position * ROW_HEIGHT
  const highest = top - header
  const lowest = top + ROW_HEIGHT - el.clientHeight
  if (el.scrollTop > highest) el.scrollTop = highest
  else if (el.scrollTop < lowest) el.scrollTop = lowest
}

// ------------------------------------------------------------ inline editing

const editing = ref<{ slot: number; col: EditCol } | null>(null)
const draft = ref('')

const draftValid = computed(() => {
  if (editing.value?.col !== 'rx') return true
  try {
    parseFreq(draft.value)
    return true
  } catch {
    return false
  }
})

function isEditing(slot: number, col: EditCol): boolean {
  return editing.value !== null && editing.value.slot === slot && editing.value.col === col
}

function startEdit(r: SlotRow, col: EditCol) {
  const c = r.channel
  if (!c) return
  editing.value = { slot: r.index, col }
  draft.value = col === 'name' ? c.name : formatFreq(c.rxFreq)
}

/**
 * Focus the field once it exists, and open it selected.
 *
 * The retry is not defensive padding: moving from the last programmed channel
 * to the first VFO slot can scroll two hundred rows, and the virtualiser only
 * mounts the target row after the browser has delivered the scroll event. A
 * single `nextTick` looks for an input that has not been created yet, and the
 * keystroke silently does nothing.
 *
 * Select-all rather than a caret, because the arrow keys traverse cells here:
 * replacing a value is the gesture the keyboard is good for, and positioning a
 * caret is a click away inside the field.
 */
function focusEditor(attempts: number) {
  const el = scroller.value?.querySelector<HTMLInputElement>('input[data-cell-editor]')
  if (el) {
    el.focus()
    el.select()
    return
  }
  // A timer rather than an animation frame: frames are paused while the tab is
  // in the background, and a field that only takes focus once the window is
  // looked at is worse than one that takes it a frame late.
  if (attempts > 0) setTimeout(() => focusEditor(attempts - 1), 16)
}

watch(editing, async (e) => {
  if (!e) return
  await nextTick()
  focusEditor(8)
})

function commitEdit() {
  const e = editing.value
  if (!e) return
  const c = bySlot.value.get(e.slot)
  if (!c) return

  if (e.col === 'name') {
    if (draft.value !== c.name) codeplug.updateChannel(e.slot, { name: draft.value })
    return
  }
  try {
    const f = parseFreq(draft.value)
    if (f !== c.rxFreq) codeplug.updateChannel(e.slot, { rxFreq: f })
  } catch {
    // A frequency that cannot be read leaves the channel alone. The field is
    // bordered in --dg while it is unparseable, so this is a refusal the user
    // has already been shown rather than a silent discard.
  }
}

function stopEdit(commit: boolean) {
  if (commit) commitEdit()
  editing.value = null
}

/**
 * Move to the next editable cell, counting name and receive as two cells per row.
 *
 * `delta` is in cells: ±1 steps sideways and wraps onto the next row, ±2 keeps
 * the column and steps a row. Empty slots are skipped - there is no channel to
 * patch - so a run of unprogrammed memory does not swallow the caret.
 */
function moveBy(delta: number) {
  const e = editing.value
  if (!e) return
  const list = rows.value
  const at = list.findIndex((r) => r.index === e.slot)
  if (at < 0) return

  const last = list.length * 2 - 1
  let cell = at * 2 + (e.col === 'name' ? 0 : 1) + delta
  while (cell >= 0 && cell <= last && !list[Math.floor(cell / 2)]!.channel) cell += delta
  if (cell < 0 || cell > last) return

  commitEdit()
  const position = Math.floor(cell / 2)
  startEdit(list[position]!, cell % 2 === 0 ? 'name' : 'rx')
  ensureVisible(position)
}

/**
 * The table's own key map.
 *
 * A grid whose arrow keys move the caret instead of the selection cannot be
 * filled in from the keyboard, which is the only way anyone programs two
 * hundred channels. Return commits, Escape reverts, and both close the field.
 */
function onEditorKey(e: KeyboardEvent) {
  switch (e.key) {
    case 'Enter':
      e.preventDefault()
      stopEdit(true)
      break
    case 'Escape':
      e.preventDefault()
      stopEdit(false)
      break
    case 'ArrowUp':
      e.preventDefault()
      moveBy(-2)
      break
    case 'ArrowDown':
      e.preventDefault()
      moveBy(2)
      break
    case 'ArrowLeft':
      e.preventDefault()
      moveBy(-1)
      break
    case 'ArrowRight':
      e.preventDefault()
      moveBy(1)
      break
    case 'Tab':
      e.preventDefault()
      moveBy(e.shiftKey ? -1 : 1)
      break
  }
}

/**
 * Clicking away keeps what was typed.
 *
 * Guarded on the cell still being the one being edited, because moving between
 * cells destroys this input after the new one has already been opened, and
 * committing twice would write the old draft into the new cell.
 */
function onEditorBlur(slot: number, col: EditCol) {
  if (!isEditing(slot, col)) return
  stopEdit(true)
}

// ------------------------------------------------------------ undo and redo

/** Anything that keeps an undo history of its own: a field being typed into. */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
}

/**
 * Ctrl/Cmd-Z and Shift-Ctrl/Cmd-Z, but never over a text field or under a dialog.
 *
 * A cell editor is open on every second keystroke in this table, and Ctrl-Z
 * over a half-typed name means the browser's own undo of that typing. Taking
 * that away to revert the codeplug instead would be the worst kind of surprise:
 * the keystroke would appear to do nothing, and some other channel would
 * silently have changed. The filter box and the full editor's fields are
 * covered by the same test.
 *
 * The dialog test covers the case the field test cannot. The channel editor is
 * a modal over this table and this table is still mounted underneath it, so
 * with the focus on a select or a switch rather than an input, the shortcut
 * would revert an edit behind an open form whose Save would then put it
 * straight back. Nothing to undo is the right answer while an overlay owns the
 * screen.
 */
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey) || e.altKey) return
  if (editing.value !== null || isTextEntry(e.target)) return
  if (document.querySelector('[role="dialog"]') !== null) return
  e.preventDefault()
  if (e.shiftKey) codeplug.redo()
  else codeplug.undo()
})

/**
 * The shortcut hint, in the modifier this machine actually uses.
 *
 * Told from the platform rather than assumed, because a tooltip that says Ctrl
 * to a Mac user is worse than no tooltip: it names a key that does nothing.
 */
const isApple = computed(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))
const undoHint = computed(() => (isApple.value ? '⌘Z' : 'Ctrl+Z'))
const redoHint = computed(() => (isApple.value ? '⇧⌘Z' : 'Shift+Ctrl+Z'))

// ---------------------------------------------------------------- selection

function toggleSelected(slot: number) {
  if (selected.value.has(slot)) selected.value.delete(slot)
  else selected.value.add(slot)
}

const allVisibleSelected = computed(() => {
  const programmed = rows.value.filter((r) => r.channel)
  return programmed.length > 0 && programmed.every((r) => selected.value.has(r.index))
})

function toggleAllVisible() {
  const programmed = rows.value.filter((r) => r.channel)
  if (allVisibleSelected.value) {
    for (const r of programmed) selected.value.delete(r.index)
    return
  }
  for (const r of programmed) selected.value.add(r.index)
}

// ------------------------------------------------------------------- export

/**
 * A CSV of the selected slots, or of everything when nothing is ticked.
 *
 * The header is written here rather than reused for the selected case because
 * `defaultHeader` counts the receive-only channels in the whole codeplug, and a
 * file that claims three receive-only channels while holding none is exactly
 * the kind of small lie that costs trust.
 */
async function exportCsv() {
  const doc = codeplug.doc
  if (!doc) return
  if (selected.value.size === 0) {
    await session.downloadCsv()
    return
  }

  const wanted = [...selected.value].sort((a, b) => a - b)
  const rxOnly = wanted.filter((s) => bySlot.value.get(s)?.txAllowed === false).length
  const header = [
    `Exported by boofwang from ${doc.radio ?? 'an unknown radio'}`,
    `${wanted.length} selected channel(s) of ${doc.channels.size}`,
    ...(rxOnly > 0 ? [`${rxOnly} of them are receive-only and are exported with Duplex=off`] : []),
  ]
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-')
  await saveFile(
    exportChirpCsv(doc, { header, slots: wanted }),
    `${doc.radio ?? 'radio'}-selection-${stamp}.csv`,
    'text/csv',
  )
}

const exportItems = computed(() => [
  {
    label: selected.value.size > 0 ? `CHIRP CSV · ${selected.value.size} selected` : 'CHIRP CSV',
    icon: 'i-lucide-file-down',
    run: exportCsv,
  },
  // The two summaries sit next to the CSV because they answer the same
  // question - "send me the channel list" - and the CSV is what people were
  // using for it. Neither carries key material; the CSV never did either.
  { label: 'Shareable summary (.html)', icon: 'i-lucide-globe', run: () => session.downloadSummaryHtml() },
  { label: 'Summary table (.md)', icon: 'i-lucide-type', run: () => session.downloadSummaryMarkdown() },
  { label: 'Codeplug (.bwp)', icon: 'i-lucide-save', run: () => session.downloadBwp() },
  { label: 'CHIRP image (.img)', icon: 'i-lucide-file-down', run: () => session.downloadChirpImg() },
  { label: 'Raw (.bin)', icon: 'i-lucide-binary', run: () => session.downloadRawBin() },
])

const LEGEND = [
  { icon: 'i-lucide-lock', color: 'var(--cn)', label: 'receive-only' },
  { icon: 'i-lucide-triangle-alert', color: 'var(--dg)', label: 'error' },
  { icon: 'i-lucide-pencil', color: 'var(--in)', label: 'edited' },
  { icon: 'i-lucide-circle-minus', color: 'var(--ln2)', label: 'empty' },
] as const

/**
 * The header carries the same grid as every row, from the same source.
 *
 * Two declarations of the same twelve columns is how a header drifts out of
 * line with its table by a pixel and stays that way.
 */
const headerStyle = computed(() => ({
  display: 'grid',
  gridTemplateColumns: gridColumns.value,
  minWidth: `${minWidth.value}px`,
  gap: '8px',
  alignItems: 'center',
  padding: '7px 10px',
  background: 'var(--pn2)',
  borderBottom: '1px solid var(--ln)',
  fontSize: '10.5px',
  fontWeight: 600,
  letterSpacing: '.04em',
  textTransform: 'uppercase' as const,
  color: 'var(--fn)',
  // Sticky is a scrolling affordance, and a page that is not scrolled has none:
  // left sticky, the header would be painted over the first row of every sheet.
  position: (printing.value ? 'static' : 'sticky') as 'static' | 'sticky',
  top: '0',
  zIndex: 2,
}))

const radioName = computed(() => {
  const s = codeplug.schema
  return s ? `${s.vendor} ${s.model}` : 'Codeplug'
})

/**
 * Recomputed each time print mode is entered, which is the point.
 *
 * A timestamp captured when the component mounted would be the moment the
 * codeplug was opened, and someone reading the sheet a week later would take it
 * for when it was printed.
 */
const printedFacts = computed(() => {
  if (!printing.value) return ''
  const parts: string[] = []
  const firmware = codeplug.image?.variant
  if (firmware) parts.push(firmware)
  parts.push(`${codeplug.channelCount} channel(s)`)
  if (codeplug.rxOnlyCount > 0) parts.push(`${codeplug.rxOnlyCount} receive-only`)
  if (printRows.value.length !== codeplug.channelCount) parts.push(`filtered to ${printRows.value.length}`)
  parts.push(`printed ${new Date().toLocaleString()}`)
  return parts.join(' · ')
})
</script>

<template>
  <div>
    <!--
      The page has no heading on screen, because the status bar above already
      says which radio this is. On paper there is no status bar, so the sheet
      has to introduce itself - and say what its two letters in the gutter mean.
    -->
    <div class="print-only" style="margin-bottom: 10px">
      <h1 style="font-size: 16px; font-weight: 600; letter-spacing: -0.01em">{{ radioName }} channel plan</h1>
      <p style="font-size: 11px; color: var(--mu); margin-top: 2px">{{ printedFacts }}</p>
      <p style="font-size: 11px; color: var(--mu); margin-top: 2px">
        RX = receive-only, transmit disabled. ! = transmit error. * = edited, not yet written to the radio.
      </p>
    </div>

    <!-- Toolbar -->
    <div class="flex items-center flex-wrap print-hide" style="gap: 9px; margin-bottom: 9px">
      <div
        class="flex items-center"
        style="height: 33px; gap: 7px; padding: 0 9px; border: 1px solid var(--ln2); border-radius: 6px; background: var(--pn)"
      >
        <UIcon name="i-lucide-search" style="width: 12px; height: 12px; color: var(--fn)" />
        <input
          v-model="query"
          type="text"
          aria-label="Filter channels"
          placeholder="Name, frequency or slot"
          style="width: 168px; border: 0; background: transparent; outline: none; font-size: 14px; color: var(--tx)"
        >
      </div>

      <div class="flex" style="gap: 3px">
        <button
          v-for="f in facets"
          :key="f.key"
          type="button"
          :aria-pressed="facet === f.key"
          class="inline-flex items-center"
          :style="{
            height: '29px',
            padding: '0 10px',
            gap: '6px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: facet === f.key ? 600 : 400,
            border: `1px solid var(${facet === f.key ? '--ln2' : '--ln'})`,
            background: `var(${facet === f.key ? '--pn3' : '--pn'})`,
            color: `var(${facet === f.key ? '--tx' : '--mu'})`,
          }"
          @click="facet = f.key"
        >
          <UIcon
            :name="f.icon"
            :style="{ width: '12px', height: '12px', color: facet === f.key ? f.tone : 'var(--fn)' }"
          />
          {{ f.label }}
          <span class="font-mono tabular" style="font-size: 12px; color: var(--fn)">{{ f.count }}</span>
        </button>
      </div>

      <div class="ms-auto flex items-center" style="gap: 8px">
        <span class="font-mono tabular" style="font-size: 13px; color: var(--mu)">
          {{ rows.length }} of {{ slots.length }} slots
        </span>

        <!--
          Undo and redo live here rather than only on the keyboard.
          A shortcut nobody is told about is a feature nobody has, and this
          toolbar is where someone who has just mistyped a frequency is already
          looking. Both carry a word as well as a glyph, which is what lets the
          icons be approximate: lucide's own undo and redo arrows are not in
          nuxt.config's SCHEMA_ICONS, and that list is the whole of what the
          offline bundle ships - an undeclared name renders as a blank gap
          rather than an error. These two are declared and read the right way
          round, anticlockwise for back and clockwise for forward.
        -->
        <div class="flex items-center" style="gap: 4px">
          <RiskAction
            risk="neutral"
            ghost
            icon="i-lucide-history"
            label="Undo"
            :disabled="!codeplug.canUndo"
            :title="codeplug.canUndo ? `Undo ${codeplug.undoLabel} (${undoHint})` : 'Nothing to undo'"
            @click="codeplug.undo()"
          />
          <RiskAction
            risk="neutral"
            ghost
            icon="i-lucide-refresh-cw"
            label="Redo"
            :disabled="!codeplug.canRedo"
            :title="codeplug.canRedo ? `Redo ${codeplug.redoLabel} (${redoHint})` : 'Nothing to redo'"
            @click="codeplug.redo()"
          />
        </div>

        <!--
          Its own button rather than an entry in the Export menu: printing is a
          verb, not a file. It also takes the deterministic path into print
          mode, which Ctrl+P cannot.
        -->
        <button
          type="button"
          class="inline-flex items-center"
          style="height: 31px; padding: 0 10px; gap: 6px; border: 1px solid var(--ln); background: transparent; color: var(--mu); border-radius: 5px; font-size: 13.5px"
          title="Print every channel, without the interface around it"
          @click="print()"
        >
          <UIcon name="i-lucide-rows-3" style="width: 12px; height: 12px; color: var(--fn)" />
          Print
        </button>

        <UPopover>
          <button
            type="button"
            class="inline-flex items-center"
            style="height: 31px; padding: 0 10px; gap: 6px; border: 1px solid var(--ln); background: transparent; color: var(--mu); border-radius: 5px; font-size: 13.5px"
          >
            <UIcon name="i-lucide-columns-3" style="width: 12px; height: 12px; color: var(--fn)" />
            Columns
          </button>
          <template #content>
            <div style="padding: 6px; background: var(--pn); border: 1px solid var(--ln); border-radius: 6px">
              <button
                v-for="c in OPTIONAL_COLUMNS"
                :key="c.key"
                type="button"
                class="flex items-center w-full"
                style="gap: 8px; padding: 5px 8px; border-radius: 4px; font-size: 13.5px; color: var(--mu)"
                @click="optional[c.key] = !optional[c.key]"
              >
                <UIcon
                  :name="optional[c.key] ? 'i-lucide-check' : 'i-lucide-minus'"
                  :style="{ width: '12px', height: '12px', color: optional[c.key] ? 'var(--ok)' : 'var(--fn)' }"
                />
                {{ c.label }}
              </button>
            </div>
          </template>
        </UPopover>

        <UPopover>
          <button
            type="button"
            class="inline-flex items-center"
            style="height: 31px; padding: 0 10px; gap: 6px; border: 1px solid var(--ln); background: transparent; color: var(--mu); border-radius: 5px; font-size: 13.5px"
          >
            <UIcon name="i-lucide-download" style="width: 12px; height: 12px; color: var(--fn)" />
            Export
          </button>
          <template #content>
            <div style="padding: 6px; background: var(--pn); border: 1px solid var(--ln); border-radius: 6px">
              <button
                v-for="x in exportItems"
                :key="x.label"
                type="button"
                class="flex items-center w-full whitespace-nowrap"
                style="gap: 8px; padding: 5px 8px; border-radius: 4px; font-size: 13.5px; color: var(--mu)"
                @click="x.run()"
              >
                <UIcon :name="x.icon" style="width: 12px; height: 12px; color: var(--fn)" />
                {{ x.label }}
              </button>
              <p style="padding: 4px 8px 2px; font-size: 12.5px; color: var(--fn); max-width: 30ch; white-space: normal">
                Exports change nothing on the radio. A summary never includes encryption keys.
              </p>
            </div>
          </template>
        </UPopover>
      </div>
    </div>

    <!-- Diagnostics: one row per rule -->
    <div
      v-if="groups.length"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; margin-bottom: 9px; overflow: hidden"
    >
      <div
        v-for="(g, i) in groups"
        :key="g.ruleId"
        class="flex items-center"
        :style="{
          gap: '10px',
          padding: '9px 13px',
          borderLeft: `2px solid var(${g.severity === 'error' ? '--dg' : '--cn'})`,
          background: `var(${g.severity === 'error' ? '--dgB' : '--cnB'})`,
          borderBottom: i === groups.length - 1 ? 'none' : '1px solid var(--ln)',
        }"
      >
        <UIcon
          :name="g.severity === 'error' ? 'i-lucide-circle-alert' : 'i-lucide-triangle-alert'"
          :style="{ width: '14px', height: '14px', flex: 'none', color: `var(${g.severity === 'error' ? '--dg' : '--cn'})` }"
        />
        <span
          class="chip"
          :style="{
            flex: 'none',
            border: `1px solid var(${g.severity === 'error' ? '--dgL' : '--cnL'})`,
            background: `var(${g.severity === 'error' ? '--dgB' : '--cnB'})`,
            color: `var(${g.severity === 'error' ? '--dg' : '--cn'})`,
          }"
        >{{ g.severity }}</span>
        <span style="font-size: 14px; line-height: 1.45; min-width: 0">
          <strong v-if="g.count > 1" style="font-weight: 600">{{ g.count }}× </strong>{{ g.message }}
        </span>
        <button
          v-if="g.slots.length"
          type="button"
          class="font-mono tabular whitespace-nowrap"
          style="font-size: 13px; color: var(--in); background: transparent; border: 0; padding: 0"
          @click="showGroup(g)"
        >{{ slotRanges(g.slots) }}</button>
        <button
          type="button"
          class="ms-auto inline-flex items-center whitespace-nowrap print-hide"
          :style="{
            flex: 'none',
            height: '23px',
            padding: '0 8px',
            gap: '5px',
            borderRadius: '4px',
            fontSize: '11.5px',
            fontWeight: g.severity === 'error' ? 400 : 500,
            border: `1px solid var(${g.severity === 'error' ? '--ln' : '--cnL'})`,
            background: g.severity === 'error' ? 'transparent' : 'var(--cnB)',
            color: `var(${g.severity === 'error' ? '--dg' : '--cn'})`,
          }"
          :title="g.aboutTransmit ? `Mark ${g.count} channel(s) receive-only` : 'Filter the table to these slots'"
          @click="runFix(g)"
        >
          <UIcon :name="fixFor(g).icon" style="width: 11px; height: 11px" />
          {{ fixFor(g).label }}
        </button>
      </div>
    </div>

    <!-- Table -->
    <div class="ch-frame" style="border: 1px solid var(--ln); border-radius: 7px; overflow: hidden; background: var(--pn)">
      <div ref="scroller" class="overflow-auto ch-scroll" style="max-height: calc(100vh - 300px); min-height: 180px">
        <div ref="headerEl" :style="headerStyle">
          <span v-if="!printing">
            <button
              type="button"
              role="checkbox"
              :aria-checked="allVisibleSelected"
              aria-label="Select every channel shown"
              class="flex items-center justify-center w-full"
              @click="toggleAllVisible()"
            >
              <span
                :style="{
                  width: '11px',
                  height: '11px',
                  borderRadius: '3px',
                  border: '1px solid var(--ln2)',
                  background: allVisibleSelected ? 'var(--in)' : 'transparent',
                }"
              />
            </button>
          </span>
          <span />
          <span style="text-align: right">Slot</span>
          <span>Name</span>
          <span style="text-align: right">Receive</span>
          <span>Shift</span>
          <span style="text-align: right">Transmit</span>
          <span v-if="optional.tone">Tone</span>
          <span v-if="optional.mode">Mode</span>
          <span v-if="optional.step" style="text-align: right">Step</span>
          <span v-if="optional.power" style="text-align: right">Power</span>
          <span v-if="optional.flag" />
        </div>

        <div :style="bodyStyle">
          <div
            v-for="r in renderedRows"
            :key="r.key"
            class="grid items-center ch-row"
            :style="rowStyle(r)"
            :tabindex="0"
            :title="r.row.channel ? undefined : `Slot ${r.row.index} is empty. Click to program it`"
            @click="r.row.channel ? emit('edit', r.row.channel) : emit('create', r.row.index)"
            @keydown.enter.self="r.row.channel ? emit('edit', r.row.channel) : emit('create', r.row.index)"
          >
            <!-- Selection -->
            <span v-if="!printing" class="flex items-center justify-center" @click.stop>
              <button
                v-if="r.row.channel"
                type="button"
                role="checkbox"
                :aria-checked="selected.has(r.key)"
                :aria-label="`Select slot ${r.key}`"
                @click="toggleSelected(r.key)"
              >
                <span
                  class="block"
                  :style="{
                    width: '11px',
                    height: '11px',
                    borderRadius: '3px',
                    border: '1px solid var(--ln2)',
                    background: selected.has(r.key) ? 'var(--in)' : 'transparent',
                  }"
                />
              </button>
            </span>

            <!-- Status gutter -->
            <span class="flex items-center justify-center" :title="r.view.gutter?.title">
              <UIcon
                v-if="r.view.gutter"
                :name="r.view.gutter.icon"
                class="print-hide"
                :style="{ width: '11px', height: '11px', color: r.view.gutter.color }"
              />
              <span
                v-if="r.view.gutter"
                class="print-only font-mono"
                style="font-size: 9px; font-weight: 600; color: var(--tx)"
              >{{ r.view.gutter.mark }}</span>
            </span>

            <span
              class="font-mono tabular"
              :style="{ fontSize: '11.5px', textAlign: 'right', color: r.view.dim ? 'var(--ln2)' : 'var(--fn)' }"
              :title="r.row.channel ? 'Open the full editor' : undefined"
            >{{ r.key }}</span>

            <!-- Name -->
            <input
              v-if="isEditing(r.key, 'name')"
              v-model="draft"
              data-cell-editor
              type="text"
              :aria-label="`Name of slot ${r.key}`"
              style="height: 21px; min-width: 0; border: 1px solid var(--in); background: var(--bg); color: var(--tx); border-radius: 3px; font-size: 14px; padding: 0 4px; outline: none"
              @click.stop
              @keydown="onEditorKey"
              @blur="onEditorBlur(r.key, 'name')"
            >
            <span
              v-else
              class="truncate"
              :style="{
                fontSize: '12.5px',
                fontWeight: 500,
                color: r.view.dim ? 'var(--ln2)' : 'var(--tx)',
                cursor: r.row.channel ? 'text' : 'default',
                padding: '2px 3px',
                margin: '0 -3px',
                borderRadius: '3px',
              }"
              @click.stop="startEdit(r.row, 'name')"
            >{{ r.view.name }}</span>

            <!-- Receive -->
            <input
              v-if="isEditing(r.key, 'rx')"
              v-model="draft"
              data-cell-editor
              type="text"
              inputmode="decimal"
              :aria-label="`Receive frequency of slot ${r.key}`"
              class="font-mono tabular"
              :style="{
                height: '21px',
                minWidth: 0,
                border: `1px solid var(${draftValid ? '--in' : '--dg'})`,
                background: 'var(--bg)',
                color: 'var(--tx)',
                borderRadius: '3px',
                fontSize: '12.5px',
                padding: '0 4px',
                outline: 'none',
                textAlign: 'right',
              }"
              @click.stop
              @keydown="onEditorKey"
              @blur="onEditorBlur(r.key, 'rx')"
            >
            <span
              v-else
              class="font-mono tabular"
              :style="{
                fontSize: '12.5px',
                textAlign: 'right',
                color: r.view.dim ? 'var(--ln2)' : 'var(--tx)',
                cursor: r.row.channel ? 'text' : 'default',
                padding: '2px 3px',
                margin: '0 -3px',
                borderRadius: '3px',
              }"
              @click.stop="startEdit(r.row, 'rx')"
            >{{ r.view.rx }}</span>

            <span
              class="font-mono tabular truncate"
              :style="{ fontSize: '12px', color: r.view.dim ? 'var(--ln2)' : 'var(--fn)' }"
            >{{ r.view.shift }}</span>

            <span
              class="font-mono tabular"
              :style="{ fontSize: '12.5px', textAlign: 'right', color: r.view.txColor, fontWeight: r.view.txWeight }"
            >{{ r.view.tx }}</span>

            <span
              v-if="optional.tone"
              class="font-mono tabular truncate"
              :style="{ fontSize: '12px', color: r.view.dim ? 'var(--ln2)' : 'var(--mu)' }"
            >{{ r.view.tone }}</span>
            <span
              v-if="optional.mode"
              class="truncate"
              :style="{ fontSize: '12px', color: r.view.dim ? 'var(--ln2)' : 'var(--mu)' }"
            >{{ r.view.mode }}</span>
            <span
              v-if="optional.step"
              class="font-mono tabular"
              :style="{ fontSize: '12px', textAlign: 'right', color: r.view.dim ? 'var(--ln2)' : 'var(--fn)' }"
            >{{ r.view.step }}</span>
            <span
              v-if="optional.power"
              class="font-mono tabular truncate"
              :style="{ fontSize: '12px', textAlign: 'right', color: r.view.dim ? 'var(--ln2)' : 'var(--fn)' }"
            >{{ r.view.power }}</span>

            <span
              v-if="optional.flag"
              class="flex items-center truncate"
              :style="{ gap: '5px', fontSize: '11px', color: r.view.flagColor }"
              :title="r.view.gutter?.title"
            >
              <UIcon
                v-if="r.view.flagIcon"
                :name="r.view.flagIcon"
                class="print-hide"
                style="width: 10px; height: 10px; flex: none"
              />
              <span class="truncate">{{ r.view.flag }}</span>
            </span>
          </div>
        </div>

        <p v-if="!rows.length" style="padding: 22px 12px; text-align: center; font-size: 14px; color: var(--fn)">
          No slots match this filter.
        </p>
      </div>

      <!-- Footer: an editing hint and a legend of colours, neither of which survives the trip to paper. -->
      <div
        class="flex items-center flex-wrap print-hide"
        style="border-top: 1px solid var(--ln); background: var(--pn2); padding: 7px 12px; gap: 14px"
      >
        <span class="flex items-center" style="gap: 6px; font-size: 13px; color: var(--fn)">
          <UIcon name="i-lucide-pencil" style="width: 11px; height: 11px" />
          Click a name or frequency to edit in place. Return commits, Escape reverts.
        </span>
        <div class="ms-auto flex items-center" style="gap: 13px">
          <span
            v-for="l in LEGEND"
            :key="l.label"
            class="flex items-center"
            style="gap: 5px; font-size: 12.5px; color: var(--mu)"
          >
            <UIcon :name="l.icon" :style="{ width: '11px', height: '11px', color: l.color }" />
            {{ l.label }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * The hover affordance is an inset outline rather than a background.
 *
 * Two of the four row states tint the row - a receive-only channel and an error
 * - and those tints are set inline, where a hover background would either lose
 * to them or, worse, win and hide the state while the pointer is over it.
 */
.ch-row:hover {
  box-shadow: inset 0 0 0 1px var(--ln2);
}

/* The same outline in the informational hue, so a row reached by keyboard is as findable as one under the pointer. */
.ch-row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--in);
}
</style>
