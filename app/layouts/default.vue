<script setup lang="ts">
import { formatBuild } from '#core/version/build.js'
import { SCHEMAS } from '#core/radio/registry.js'

/**
 * Persistent chrome: a 44px nav, the status bar beneath it, and a footer.
 *
 * Nav order follows the task, not the sitemap: Connect first because that is
 * what a returning user came to do, About last. The status bar sits directly
 * under the nav so "what am I working on" never scrolls away.
 */
const codeplug = useCodeplugStore()
const device = useDeviceStore()

/**
 * The schema the nav asks its questions of.
 *
 * An open codeplug first, because that is a radio whose handshake answered.
 * Failing that, whatever the user has named on the connect screen: a schema is
 * enough to know which destinations a radio has, and making somebody open a
 * cable before the nav settles would leave the gated half missing at exactly
 * the moment they are looking for it.
 *
 * `device.radioId` is last and is the connected radio, which covers a session
 * that connected without reading.
 */
const navSchema = computed(() => {
  if (codeplug.schema) return codeplug.schema
  const id = device.chosenRadioId ?? device.radioId
  return id ? (SCHEMAS[id] ?? null) : null
})

/**
 * The lists page is named after what the open radio actually holds.
 *
 * A tab reading "Zones" on a UV-K5, which has two scan lists and no zones, is
 * the same defect as a Keys page with nothing on it: the label promises a
 * concept the radio has no word for.
 */
const listsLabel = computed(() => (navSchema.value?.features.zones ? 'Zones' : 'Scan lists'))

/**
 * Where each destination is allowed to appear.
 *
 * `undefined` means always. Everything else is a question asked of the open
 * schema, and it is the same question the page itself already asks: `keys.vue`
 * reads `features.encryption`, `fleet.vue` reads `features.radioIds`, `dmr.vue`
 * reads six of them. The nav asking it too is what stops the trip being offered
 * at all, rather than offered and then answered with "this radio has none".
 *
 * Before this, a UV-K5 could reach Keys, Fleet and Splash, and all three were
 * empty when it got there.
 *
 * With nothing read the schema is unknown and the gated destinations are
 * withheld, which is honest rather than cautious: picking a model in the driver
 * list fills the schema in before a cable is ever opened. And a destination
 * cannot appear and then vanish under an open codeplug, because the schema does
 * not change under one.
 */
const nav = computed(() => {
  const f = navSchema.value?.features
  const s = navSchema.value
  const items = [
    { label: 'Connect', to: '/', icon: 'i-lucide-usb', show: true },
    { label: 'Channels', to: '/channels', icon: 'i-lucide-list', show: true },
    { label: 'Presets', to: '/presets', icon: 'i-lucide-layers', show: true },
    { label: 'Repeaters', to: '/repeaters', icon: 'i-lucide-radio-tower', show: true },
    {
      label: listsLabel.value,
      to: '/dmr',
      icon: 'i-lucide-folder-tree',
      // Any one of the six the page can draw is enough to justify the trip.
      show: !!f && !!(f.zones || f.talkGroups || f.scanLists || f.rxGroups || f.radioIds || f.contacts || f.messages),
    },
    { label: 'Settings', to: '/settings', icon: 'i-lucide-sliders-horizontal', show: (s?.settings.length ?? 0) > 0 },
    { label: 'Keys', to: '/keys', icon: 'i-lucide-key-round', show: !!f?.encryption },
    { label: 'Splash', to: '/startup-image', icon: 'i-lucide-image', show: !!f?.bootPicture },
    { label: 'Fleet', to: '/fleet', icon: 'i-lucide-users', show: !!f?.radioIds },
    { label: 'Backups', to: '/backups', icon: 'i-lucide-history', show: true },
    { label: 'About', to: '/about', icon: 'i-lucide-info', show: true },
  ]
  return items.filter((i) => i.show).map(({ label, to, icon }) => ({ label, to, icon }))
})

const route = useRoute()

/**
 * The write and restore flows are steps inside a section, not sections.
 * Keeping their parent lit stops the nav from implying the user has left.
 */
const activePath = computed(() => {
  const p = route.path
  if (p.startsWith('/write')) return '/channels'
  if (p.startsWith('/restore')) return '/backups'
  return p
})

/** The same links, for the small-screen menu. `onSelect` navigates in-app. */
const smallNav = computed(() =>
  nav.value.map((item) => ({ label: item.label, icon: item.icon, onSelect: () => navigateTo(item.to) })),
)
const currentLabel = computed(() => nav.value.find((n) => n.to === activePath.value)?.label ?? 'Menu')

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

/**
 * The running build, in the footer, on every page.
 *
 * It is here rather than only on the About page because of the offline cache:
 * once a browser can hold a copy of boofwang indefinitely, "which version is
 * this" stops being trivia and becomes the first question worth asking when a
 * radio does not behave. Registering the worker happens here too, since this
 * layout is the one component every page mounts inside.
 */
const build = useBuildInfo()
const { state: updateState } = useAppUpdate()
</script>

<template>
  <div class="min-h-screen flex flex-col" style="background: var(--bg); color: var(--tx)">
    <!-- The insets are zero everywhere but inside a phone shell drawn edge to edge. -->
    <header
      class="sticky top-0 z-20 print-hide"
      style="background: var(--pn); border-bottom: 1px solid var(--ln); padding-top: env(safe-area-inset-top)"
    >
      <div class="mx-auto max-w-[1400px] px-4 flex items-center gap-5" style="height: 52px">
        <NuxtLink to="/" class="flex items-center gap-2 shrink-0">
          <UIcon name="i-lucide-radio-tower" style="width: 15px; height: 15px; color: var(--ac)" />
          <span style="font-size: 15px; font-weight: 600; letter-spacing: -0.01em">boofwa.ng</span>
        </NuxtLink>

        <!--
          Below the sm breakpoint the nav was display:none with nothing in its
          place, so on a phone - the one place the UV-5R Mini Bluetooth flow is
          meant to run - Presets, Zones, Keys and Settings had no inbound link
          anywhere and the user who had just read a radio could not leave the
          channel table. A menu with the same items, same order.
        -->
        <UDropdownMenu :items="smallNav" :ui="{ content: 'w-52' }" class="sm:hidden">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-[5px] px-2"
            style="height: 28px; font-size: 14px; color: var(--tx); border: 1px solid var(--ln2); background: var(--pn)"
            aria-label="Open navigation"
          >
            <UIcon name="i-lucide-menu" style="width: 15px; height: 15px" />
            <span style="font-weight: 600">{{ currentLabel }}</span>
            <UIcon name="i-lucide-chevron-down" style="width: 13px; height: 13px; color: var(--fn)" />
          </button>
        </UDropdownMenu>

        <nav class="hidden sm:flex items-center gap-0.5">
          <NuxtLink
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            class="flex items-center gap-1.5 rounded-[5px] px-2.5 transition-colors"
            style="height: 25px; font-size: 14px"
            :style="activePath === item.to
              ? { background: 'var(--pn3)', color: 'var(--acTx)', fontWeight: 600, boxShadow: 'inset 0 -2px 0 var(--ac)' }
              : { color: 'var(--mu)' }"
          >
            <UIcon :name="item.icon" style="width: 13px; height: 13px" />
            {{ item.label }}
          </NuxtLink>
        </nav>

        <div class="ms-auto flex items-center gap-2">
          <a
            href="https://github.com/thebentern/boofwang/issues/new"
            target="_blank"
            rel="noopener"
            class="hidden md:flex items-center gap-1.5"
            style="font-size: 13px; color: var(--fn)"
          >
            <UIcon name="i-lucide-bug" style="width: 12px; height: 12px" />
            Report a bug
          </a>
          <button
            type="button"
            class="flex items-center justify-center rounded-[5px]"
            style="width: 25px; height: 25px; color: var(--mu)"
            :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
            @click="colorMode.preference = isDark ? 'light' : 'dark'"
          >
            <UIcon :name="isDark ? 'i-lucide-sun' : 'i-lucide-moon'" style="width: 13px; height: 13px" />
          </button>
        </div>
      </div>
    </header>

    <!--
      Above the status bar rather than below it: the bar answers "what am I
      working on", and this is about the program itself, which belongs with the
      chrome. It renders nothing until there is something to say.
    -->
    <AppUpdateNotice />
    <!-- The mobile shell's Bluetooth list. Renders nothing until a scan opens it. -->
    <ConnectBluetoothScanList />

    <AppStatusBar />

    <main class="flex-1">
      <slot />
    </main>

    <!-- Neither the nav above nor the links below can be followed off a sheet of paper. -->
    <footer class="print-hide" style="border-top: 1px solid var(--ln); padding-bottom: env(safe-area-inset-bottom)">
      <div
        class="mx-auto max-w-[1400px] px-4 py-5 flex flex-wrap items-center gap-x-4 gap-y-1.5"
        style="font-size: 13px; color: var(--fn)"
      >
        <!--
          The version is a link to where it is explained, not a decoration.
          Someone reading a wrong frequency off a radio needs to be able to say
          which build wrote it, and then find out how old that is.
        -->
        <NuxtLink to="/about" class="font-mono tabular" style="color: var(--fn)">
          boofwa.ng {{ formatBuild(build) }}
        </NuxtLink>
        <span v-if="updateState.offlineReady">Offline ready</span>
        <span>GNU GPL v3 or later</span>
        <span>Everything runs in your browser. Nothing is uploaded anywhere.</span>
        <a
          href="https://github.com/thebentern/boofwang/issues/new"
          target="_blank"
          rel="noopener"
          style="color: var(--acTx)"
        >Report a bug</a>
        <a
          href="https://github.com/thebentern/boofwang"
          target="_blank"
          rel="noopener"
          style="color: var(--acTx)"
        >Contribute</a>
        <NuxtLink to="/about" style="color: var(--acTx)">Credits &amp; licensing</NuxtLink>
        <a
          href="https://buymeacoffee.com/thebentern"
          target="_blank"
          rel="noopener"
          class="inline-flex items-center gap-1.5"
          style="color: var(--acTx)"
        >
          <UIcon name="i-lucide-coffee" class="shrink-0" style="width: 14px; height: 14px" />
          Buy me a coffee
        </a>
      </div>
    </footer>
  </div>
</template>
