<script setup lang="ts">
/**
 * Persistent chrome: a 44px nav, the status bar beneath it, and a footer.
 *
 * Nav order follows the task, not the sitemap: Connect first because that is
 * what a returning user came to do, About last. The status bar sits directly
 * under the nav so "what am I working on" never scrolls away.
 */
const nav = [
  { label: 'Connect', to: '/', icon: 'i-lucide-usb' },
  { label: 'Channels', to: '/channels', icon: 'i-lucide-list' },
  { label: 'Presets', to: '/presets', icon: 'i-lucide-layers' },
  { label: 'Repeaters', to: '/repeaters', icon: 'i-lucide-radio-tower' },
  { label: 'Zones', to: '/dmr', icon: 'i-lucide-folder-tree' },
  { label: 'Settings', to: '/settings', icon: 'i-lucide-sliders-horizontal' },
  { label: 'Keys', to: '/keys', icon: 'i-lucide-key-round' },
  { label: 'Splash', to: '/startup-image', icon: 'i-lucide-image' },
  { label: 'Backups', to: '/backups', icon: 'i-lucide-history' },
  { label: 'About', to: '/about', icon: 'i-lucide-info' },
]

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
  nav.map((item) => ({ label: item.label, icon: item.icon, onSelect: () => navigateTo(item.to) })),
)
const currentLabel = computed(() => nav.find((n) => n.to === activePath.value)?.label ?? 'Menu')

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')
</script>

<template>
  <div class="min-h-screen flex flex-col" style="background: var(--bg); color: var(--tx)">
    <header class="sticky top-0 z-20 print-hide" style="background: var(--pn); border-bottom: 1px solid var(--ln)">
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

    <AppStatusBar />

    <main class="flex-1">
      <slot />
    </main>

    <!-- Neither the nav above nor the links below can be followed off a sheet of paper. -->
    <footer class="print-hide" style="border-top: 1px solid var(--ln)">
      <div
        class="mx-auto max-w-[1400px] px-4 py-5 flex flex-wrap items-center gap-x-4 gap-y-1.5"
        style="font-size: 13px; color: var(--fn)"
      >
        <span class="font-mono">boofwa.ng</span>
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
