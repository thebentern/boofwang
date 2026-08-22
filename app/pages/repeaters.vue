<script setup lang="ts">
import type { Modulation } from '#core/model/channel.js'
import type { RepeaterRecord } from '#core/data/source.js'
import { distanceKm } from '#core/data/geo.js'

/**
 * Finding repeaters near somewhere.
 *
 * The results do not go anywhere near a radio from here. They are saved as a
 * channel set, and the placement screen puts them in slots - which means the
 * clamping, the risk register and "nothing reaches the radio until you write"
 * all still apply, unchanged, rather than being rebuilt slightly differently on
 * a new screen.
 *
 * Location is typed by default and offered from the browser second. Asking for
 * someone's coordinates is a permission prompt and a question about privacy,
 * and the answer is often no; typing a latitude works everywhere, including
 * with location services switched off.
 */
useSeoMeta({ title: 'Repeaters' })

const sources = useDataSources()
const { saveFetched } = useImportedPresets()
const toast = useToast()

const sourceId = ref(sources.available.value[0]?.id ?? '')
const lat = ref('')
const lon = ref('')
const radiusKm = ref(50)
const callsign = ref('')
const mode = ref<'all' | Modulation>('all')
const includeSimplex = ref(false)
const locating = ref(false)
const loading = ref(false)
/**
 * Shallow on purpose.
 *
 * A plain `ref` would deep-reactify every record, and a BrandMeister search
 * starts from 33,000 of them. Nothing here mutates a record in place - a search
 * replaces the whole list - so the per-property proxies buy nothing and cost a
 * pass over the entire response.
 */
const results = shallowRef<readonly RepeaterRecord[]>([])
const issues = ref<readonly string[]>([])
const searched = ref(false)

const selectedSource = computed(() => sources.available.value.find((s) => s.id === sourceId.value) ?? null)

const near = computed(() => {
  const a = Number(lat.value)
  const b = Number(lon.value)
  if (lat.value.trim() === '' || lon.value.trim() === '') return null
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  if (a < -90 || a > 90 || b < -180 || b > 180) return null
  return { lat: a, lon: b }
})

/**
 * Repeaters, as distinct from hotspots, as far as anyone can tell from here.
 *
 * Three quarters of BrandMeister's device list transmits and receives on one
 * frequency. Those are overwhelmingly personal hotspots - a board on somebody's
 * desk with a range measured in metres - and putting one in your radio achieves
 * nothing. They cannot be told apart with certainty, so this is a default and
 * not a claim, and the switch says what it is doing.
 */
const filtered = computed(() => {
  const rows = includeSimplex.value ? results.value : results.value.filter((r) => r.tx.kind !== 'simplex')
  return rows
})

const hiddenSimplex = computed(() =>
  includeSimplex.value ? 0 : results.value.filter((r) => r.tx.kind === 'simplex').length,
)

const MHZ = (n: number) => (n / 1_000_000).toFixed(4)

function distanceOf(r: RepeaterRecord): string {
  const from = near.value
  if (!from || !r.location) return '—'
  return `${Math.round(distanceKm(from, r.location))} km`
}

function useMyLocation() {
  if (!navigator.geolocation) {
    toast.add({
      title: 'No location available',
      description: 'This browser does not offer a location. Type a latitude and longitude instead.',
      icon: 'i-lucide-circle-alert',
      color: 'error',
      duration: 8000,
    })
    return
  }
  locating.value = true
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lat.value = pos.coords.latitude.toFixed(5)
      lon.value = pos.coords.longitude.toFixed(5)
      locating.value = false
    },
    (err) => {
      locating.value = false
      toast.add({
        title: 'Could not get your location',
        description: `${err.message}. Type a latitude and longitude instead.`,
        icon: 'i-lucide-circle-alert',
        color: 'warning',
        duration: 8000,
      })
    },
    { timeout: 10_000 },
  )
}

async function search() {
  if (!selectedSource.value) return
  loading.value = true
  searched.value = true
  try {
    const out = await sources.fetchRepeaters(selectedSource.value.id, {
      ...(near.value === null ? {} : { near: near.value, withinKm: radiusKm.value }),
      ...(callsign.value.trim() === '' ? {} : { callsign: callsign.value.trim() }),
      ...(mode.value === 'all' ? {} : { modes: [mode.value] }),
    })
    results.value = out.records
    issues.value = out.issues.filter((i) => i.severity === 'error').map((i) => i.message)
  } catch (e) {
    results.value = []
    toast.add({
      title: `Could not reach ${selectedSource.value.name}`,
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-circle-alert',
      color: 'error',
      duration: 0,
    })
  } finally {
    loading.value = false
  }
}

async function keep() {
  const src = selectedSource.value
  if (!src || filtered.value.length === 0) return
  const where = near.value ? `near ${lat.value}, ${lon.value}` : 'search'
  try {
    await saveFetched(`${src.name} ${where}`, filtered.value, src)
    toast.add({
      title: `Saved ${filtered.value.length} repeaters as a set`,
      description: 'Place it into slots on the presets screen. Nothing reaches the radio until you write.',
      icon: 'i-lucide-circle-check',
      color: 'success',
      duration: 10_000,
    })
    await navigateTo('/presets')
  } catch (e) {
    toast.add({
      title: 'Could not keep that set',
      description: isQuotaError(e)
        ? 'The browser is out of storage for this site. Delete a backup or a saved set and try again.'
        : e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-circle-alert',
      color: 'error',
      duration: 0,
    })
  }
}
</script>

<template>
  <div style="padding: 18px 20px 40px; max-width: 1100px; margin: 0 auto">
    <div class="flex items-center gap-2" style="margin-bottom: 4px">
      <UIcon name="i-lucide-radio-tower" style="width: 16px; height: 16px; color: var(--fn)" />
      <h1 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--tx)">Repeaters</h1>
      <span style="font-size: 13px; color: var(--mu)">
        Search a directory and keep the results as a channel set.
      </span>
    </div>

    <!-- Where to look -->
    <section class="card" style="padding: 14px 16px; margin-top: 14px">
      <div class="flex items-end gap-3 flex-wrap">
        <label style="display: flex; flex-direction: column; gap: 4px">
          <span class="label-xs" style="color: var(--fn)">Directory</span>
          <select
            v-model="sourceId"
            class="rounded-[6px] px-2 outline-none"
            style="height: 30px; min-width: 160px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 13.5px"
          >
            <option v-for="s in sources.available.value" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>

        <label style="display: flex; flex-direction: column; gap: 4px">
          <span class="label-xs" style="color: var(--fn)">Latitude</span>
          <input
            v-model="lat" inputmode="decimal" placeholder="51.5072"
            class="rounded-[6px] px-2 outline-none font-mono"
            style="height: 30px; width: 110px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 13.5px"
          >
        </label>
        <label style="display: flex; flex-direction: column; gap: 4px">
          <span class="label-xs" style="color: var(--fn)">Longitude</span>
          <input
            v-model="lon" inputmode="decimal" placeholder="-0.1276"
            class="rounded-[6px] px-2 outline-none font-mono"
            style="height: 30px; width: 110px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 13.5px"
          >
        </label>
        <RiskAction
          risk="neutral" ghost size="sm" icon="i-lucide-crosshair"
          :label="locating ? 'Locating' : 'Use my location'" :disabled="locating"
          @click="useMyLocation"
        />

        <label style="display: flex; flex-direction: column; gap: 4px">
          <span class="label-xs" style="color: var(--fn)">Within</span>
          <select
            v-model.number="radiusKm"
            class="rounded-[6px] px-2 outline-none"
            style="height: 30px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 13.5px"
          >
            <option :value="15">15 km</option>
            <option :value="50">50 km</option>
            <option :value="150">150 km</option>
            <option :value="500">500 km</option>
          </select>
        </label>

        <label style="display: flex; flex-direction: column; gap: 4px">
          <span class="label-xs" style="color: var(--fn)">Mode</span>
          <select
            v-model="mode"
            class="rounded-[6px] px-2 outline-none"
            style="height: 30px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 13.5px"
          >
            <option value="all">Any</option>
            <option value="FM">FM</option>
            <option value="DMR">DMR</option>
          </select>
        </label>

        <label style="display: flex; flex-direction: column; gap: 4px">
          <span class="label-xs" style="color: var(--fn)">Callsign</span>
          <input
            v-model="callsign" placeholder="optional"
            class="rounded-[6px] px-2 outline-none font-mono"
            style="height: 30px; width: 110px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 13.5px"
          >
        </label>

        <RiskAction
          risk="neutral" size="sm" :icon="loading ? 'i-lucide-loader-circle' : 'i-lucide-search'"
          :label="loading ? 'Searching' : 'Search'" :disabled="loading || !selectedSource"
          @click="search"
        />
      </div>

      <p v-if="selectedSource" style="margin: 11px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--mu)">
        <span class="label-xs" style="color: var(--fn)">Source</span>
        {{ selectedSource.attribution }} · {{ selectedSource.licence }}
      </p>

      <!--
        The one place the desktop app is mentioned.

        Stated as a fact about this host, not as a prompt. A source switched off
        in the registry never reaches this list, so nobody is told to install
        something to get at data boofwang has stopped offering.
      -->
      <p
        v-if="sources.unreachable.value.length"
        style="margin: 7px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--mu)"
      >
        {{ sources.unreachable.value.map((s) => s.name).join(' and ') }}
        {{ sources.unreachable.value.length === 1 ? 'needs' : 'need' }} the desktop app, which can reach
        {{ sources.unreachable.value.length === 1 ? 'it' : 'them' }} directly.
      </p>
    </section>

    <!-- Results -->
    <section v-if="searched" style="margin-top: 16px">
      <div class="flex items-center gap-2 flex-wrap" style="margin-bottom: 7px">
        <h2 class="sec" style="margin: 0">
          {{ filtered.length }} repeater{{ filtered.length === 1 ? '' : 's' }}
        </h2>

        <label
          v-if="hiddenSimplex || includeSimplex"
          class="flex items-center gap-2"
          style="font-size: 12.5px; color: var(--mu); cursor: pointer"
        >
          <input v-model="includeSimplex" type="checkbox" style="width: 13px; height: 13px">
          Include simplex nodes
        </label>

        <RiskAction
          risk="neutral" size="sm" icon="i-lucide-save"
          :label="`Keep ${filtered.length} as a set`"
          class="ms-auto" :disabled="filtered.length === 0"
          @click="keep"
        />
      </div>

      <p
        v-if="hiddenSimplex"
        style="margin: 0 0 8px; font-size: 12.5px; line-height: 1.5; color: var(--mu)"
      >
        {{ hiddenSimplex }} simplex {{ hiddenSimplex === 1 ? 'entry is' : 'entries are' }} hidden.
        Most are personal hotspots rather than repeaters, but boofwang cannot tell them apart for certain.
      </p>

      <div class="card">
        <p v-if="filtered.length === 0" class="empty">
          {{ loading ? 'Searching.' : 'Nothing matched. Widen the radius or clear a filter.' }}
        </p>
        <table v-else style="width: 100%; border-collapse: collapse">
          <thead>
            <tr class="label-xs" style="color: var(--fn)">
              <th style="text-align: left; padding: 8px 16px">Callsign</th>
              <th style="text-align: right; padding: 8px 8px">Receive</th>
              <th style="text-align: right; padding: 8px 8px">Shift</th>
              <th style="text-align: left; padding: 8px 8px">Mode</th>
              <th style="text-align: right; padding: 8px 8px">Distance</th>
              <th style="text-align: left; padding: 8px 16px">Where</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(r, i) in filtered.slice(0, 200)"
              :key="`${r.sourceId}-${r.ref}`"
              :style="i ? 'border-top: 1px solid var(--ln)' : ''"
            >
              <td class="font-mono" style="padding: 8px 16px; font-size: 13px; color: var(--tx)">{{ r.callsign || '—' }}</td>
              <td class="font-mono" style="padding: 8px 8px; font-size: 13px; color: var(--tx); text-align: right">{{ MHZ(r.rxFreq) }}</td>
              <td class="font-mono" style="padding: 8px 8px; font-size: 13px; color: var(--mu); text-align: right">
                {{ r.tx.kind === 'offset' ? `${r.tx.direction === 'plus' ? '+' : '-'}${MHZ(r.tx.offset)}` : 'simplex' }}
              </td>
              <td style="padding: 8px 8px; font-size: 13px; color: var(--mu)">
                {{ r.modulation }}<span v-if="r.dmr"> · cc{{ r.dmr.colorCode }}</span>
              </td>
              <td class="font-mono" style="padding: 8px 8px; font-size: 13px; color: var(--mu); text-align: right">{{ distanceOf(r) }}</td>
              <td style="padding: 8px 16px; font-size: 13px; color: var(--mu)">{{ r.city || '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p
          v-if="filtered.length > 200"
          style="margin: 0; padding: 9px 16px; border-top: 1px solid var(--ln); font-size: 12.5px; color: var(--mu)"
        >
          Showing the first 200. All {{ filtered.length }} are kept if you save the set.
        </p>
      </div>

      <p v-if="issues.length" style="margin: 9px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--mu)">
        {{ issues.length }} record{{ issues.length === 1 ? '' : 's' }} could not be read and
        {{ issues.length === 1 ? 'was' : 'were' }} left out. {{ issues[0] }}
      </p>
    </section>
  </div>
</template>
