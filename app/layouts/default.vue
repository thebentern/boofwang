<script setup lang="ts">
const nav = [
  { label: 'Radios', to: '/', icon: 'i-lucide-radio' },
  { label: 'Channels', to: '/channels', icon: 'i-lucide-list' },
  { label: 'Presets', to: '/presets', icon: 'i-lucide-layers' },
  { label: 'Keys', to: '/keys', icon: 'i-lucide-key' },
  { label: 'Backups', to: '/backups', icon: 'i-lucide-history' },
  { label: 'About', to: '/about', icon: 'i-lucide-info' },
]
</script>

<template>
  <div class="min-h-screen flex flex-col bg-default text-default">
    <header class="border-b border-default sticky top-0 z-20 bg-default/85 backdrop-blur">
      <div class="mx-auto max-w-7xl px-4 h-14 flex items-center gap-6">
        <NuxtLink to="/" class="flex items-center gap-2 font-semibold tracking-tight shrink-0">
          <UIcon name="i-lucide-radio-tower" class="size-5 text-primary" />
          boofwang
        </NuxtLink>

        <nav class="hidden sm:flex items-center gap-1">
          <UButton
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            :icon="item.icon"
            :label="item.label"
            color="neutral"
            variant="ghost"
            size="sm"
            active-class="bg-elevated"
          />
        </nav>

        <div class="ms-auto flex items-center gap-1">
          <UButton
            to="https://github.com/thebentern/boofwang"
            target="_blank"
            rel="noopener"
            icon="i-lucide-external-link"
            color="neutral"
            variant="ghost"
            size="sm"
            label="Source"
          />
          <UColorModeButton />
        </div>
      </div>
    </header>

    <main class="flex-1">
      <slot />
    </main>

    <footer class="border-t border-default">
      <div class="mx-auto max-w-7xl px-4 py-6 text-xs text-muted flex flex-wrap gap-x-4 gap-y-1">
        <span>boofwang — free software under the GNU GPL v3 or later.</span>
        <span>Everything runs in your browser. Nothing is uploaded anywhere.</span>
        <NuxtLink to="/about" class="underline underline-offset-2 hover:text-default">Credits &amp; licensing</NuxtLink>
      </div>
    </footer>
  </div>
</template>
