<script setup lang="ts">
/**
 * Radio settings.
 *
 * Everything here is schema-driven, so this page has no per-radio knowledge and
 * gains a radio the moment that radio's schema declares one.
 */
import { settingsForLayout } from '#core/radio/schema.js'

useSeoMeta({ title: 'Radio settings' })

const codeplug = useCodeplugStore()

/**
 * Only the groups that apply to the layout this codeplug was read from.
 *
 * One radio can store its settings more than one way: the UV-K5 puts them in a
 * different arrangement under egzumer firmware than under stock, and several of
 * the addresses mean different things in the two. Rendering every group
 * regardless of layout would offer someone with a stock radio a form full of
 * controls for bytes that hold something else entirely.
 */
const groups = computed(() =>
  codeplug.schema ? settingsForLayout(codeplug.schema, codeplug.image?.layout) : [],
)
const count = computed(() => groups.value.reduce((n, g) => n + g.fields.length, 0))

/**
 * How many of the declared settings this codeplug actually carries.
 *
 * A radio whose settings are decoded shows all of them; one whose are not shows
 * the fields as unread rather than as zeroes. Saying so up front is better than
 * letting someone work it out from a form full of blanks.
 */
const known = computed(() =>
  groups.value.reduce(
    (n, g) => n + g.fields.filter((f) => codeplug.settings[f.key] !== undefined).length,
    0,
  ),
)
</script>

<template>
  <div class="mx-auto" style="max-width: 1040px; padding: 22px 16px 48px">
    <div class="flex items-center gap-2.5 flex-wrap" style="margin-bottom: 11px">
      <UIcon name="i-lucide-sliders-horizontal" class="shrink-0" style="width: 17px; height: 17px; color: var(--cn)" />
      <h1 style="font-size: 19px; font-weight: 600; letter-spacing: -0.02em; color: var(--tx)">
        Radio settings
      </h1>
      <span v-if="codeplug.isOpen && count" class="ms-auto" style="font-size: 13.5px; color: var(--mu)">
        {{ known }} of {{ count }} read from this radio
      </span>
    </div>

    <div
      v-if="!codeplug.isOpen"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 22px"
    >
      <h2 style="font-size: 14.5px; font-weight: 600; color: var(--tx); margin-bottom: 5px">No codeplug open</h2>
      <p style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 74ch; margin-bottom: 13px">
        Settings belong to a codeplug. Read a radio, or open a codeplug file you saved earlier.
      </p>
      <div class="flex flex-wrap items-center gap-2.5">
        <RiskAction risk="neutral" icon="i-lucide-radio" label="Choose a radio" @click="navigateTo('/')" />
        <OpenCodeplugButton />
      </div>
    </div>

    <div
      v-else-if="count === 0"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 22px"
    >
      <h2 style="font-size: 14.5px; font-weight: 600; color: var(--tx); margin-bottom: 5px">
        No settings for the {{ codeplug.schema?.vendor }} {{ codeplug.schema?.model }} yet
      </h2>
      <p style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 74ch">
        Its settings are read from the radio and written back unchanged, but none have been decoded well
        enough to offer a control for. They survive a read and write either way.
      </p>
    </div>

    <template v-else>
      <p style="font-size: 13px; color: var(--mu); line-height: 1.6; max-width: 78ch; margin-bottom: 12px">
        These are the settings this build understands. Everything else the radio stores is read, preserved
        byte for byte and written back exactly as it was found.
      </p>

      <SchemaForm :groups="groups" :values="codeplug.settings" @change="codeplug.setSetting" />
    </template>
  </div>
</template>
