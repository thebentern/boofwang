<script setup lang="ts">
import { parseBluetoothProfile } from '#core/transport/bluetooth-uuids.js'
import { setBluetoothOverride } from '~/composables/useWebBluetooth'

/**
 * The device list the mobile shell draws in place of the browser's chooser.
 *
 * Mounted once, in the layout, and shown while `bleChooser.open` is true. It
 * is a sheet over the page rather than a route, because a pick has to resolve
 * a promise the connect page is awaiting, and navigating away would strand
 * it. Rows are the store's; this file only draws them and forwards taps.
 *
 * The advanced field is the `?ble=` override with a different entry point:
 * the only way anyone finds a radio's real UUIDs is with the radio in front
 * of them, and on a phone there is no address bar to type a query into.
 */
const chooser = useBleChooserStore()

const advanced = ref(false)
const override = ref('')
const overrideError = ref<string | null>(null)

function applyOverride() {
  overrideError.value = null
  const value = override.value.trim()
  try {
    if (value === '') {
      setBluetoothOverride(null)
      return
    }
    const profile = parseBluetoothProfile(value)
    setBluetoothOverride(value)
    chooser.rematch([profile])
  } catch (e) {
    overrideError.value = e instanceof Error ? e.message : String(e)
  }
}

function signal(rssi: number | undefined): string {
  if (rssi === undefined) return ''
  return `${rssi} dBm`
}
</script>

<template>
  <div
    v-if="chooser.open"
    class="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
    style="background: color-mix(in srgb, var(--bg) 70%, transparent)"
    role="dialog"
    aria-modal="true"
    aria-label="Bluetooth devices"
  >
    <div
      class="w-full sm:max-w-md flex flex-col"
      style="
        background: var(--bg);
        border: 1px solid var(--ln);
        border-radius: 10px 10px 0 0;
        max-height: min(80vh, 640px);
        padding-bottom: env(safe-area-inset-bottom);
      "
    >
      <div class="flex items-center gap-2" style="padding: 14px 16px; border-bottom: 1px solid var(--ln)">
        <UIcon name="i-lucide-bluetooth" style="width: 16px; height: 16px; color: var(--fn)" />
        <div style="font-size: 15px; font-weight: 600; flex: 1">Bluetooth devices</div>
        <UIcon
          v-if="chooser.scanning"
          name="i-lucide-loader-circle"
          class="animate-spin"
          style="width: 14px; height: 14px; color: var(--mu)"
        />
        <button
          type="button"
          aria-label="Close"
          style="padding: 4px; color: var(--mu); background: transparent; border: 0"
          @click="chooser.dismiss()"
        >
          <UIcon name="i-lucide-x" style="width: 16px; height: 16px" />
        </button>
      </div>

      <div class="overflow-y-auto" style="flex: 1">
        <p v-if="chooser.error" style="margin: 0; padding: 14px 16px; font-size: 13.5px; color: var(--dg)">
          {{ chooser.error }}
        </p>

        <p
          v-else-if="chooser.visible.length === 0"
          style="margin: 0; padding: 18px 16px; font-size: 13.5px; line-height: 1.55; color: var(--mu)"
        >
          <template v-if="chooser.scanning">
            Looking for a radio. Put it in its wireless programming mode and keep it within a metre.
          </template>
          <template v-else>Nothing was found.</template>
          <template v-if="!chooser.everyDevice && chooser.hidden > 0">
            {{ chooser.hidden }} other {{ chooser.hidden === 1 ? 'device is' : 'devices are' }} in range and hidden.
          </template>
        </p>

        <ul v-else style="list-style: none; margin: 0; padding: 6px 0">
          <li v-for="row in chooser.visible" :key="row.deviceId">
            <button
              type="button"
              class="w-full flex items-center gap-3 text-left"
              style="padding: 11px 16px; background: transparent; border: 0; border-bottom: 1px solid var(--ln)"
              @click="chooser.pick(row.deviceId)"
            >
              <UIcon
                name="i-lucide-signal"
                style="width: 14px; height: 14px; flex: none"
                :style="{ color: row.matched ? 'var(--fn)' : 'var(--mu)' }"
              />
              <span style="flex: 1; min-width: 0">
                <span class="block truncate" style="font-size: 14px">{{ row.name ?? 'Unnamed device' }}</span>
                <span class="block truncate" style="font-size: 12px; color: var(--mu); font-family: var(--font-mono)">
                  {{ row.deviceId }}
                </span>
              </span>
              <span style="font-size: 12px; color: var(--mu); font-family: var(--font-mono); flex: none">
                {{ signal(row.rssi) }}
              </span>
              <UIcon name="i-lucide-chevron-right" style="width: 14px; height: 14px; color: var(--mu); flex: none" />
            </button>
          </li>
        </ul>
      </div>

      <div style="padding: 10px 16px 14px; border-top: 1px solid var(--ln)">
        <label class="flex items-center gap-2" style="font-size: 13px; color: var(--mu)">
          <input v-model="chooser.everyDevice" type="checkbox" >
          Show every device
        </label>

        <button
          type="button"
          style="margin-top: 8px; padding: 0; font-size: 12.5px; color: var(--mu); background: transparent; border: 0; text-decoration: underline"
          @click="advanced = !advanced"
        >
          {{ advanced ? 'Hide' : 'Use different UUIDs' }}
        </button>

        <div v-if="advanced" style="margin-top: 8px">
          <p style="margin: 0 0 6px; font-size: 12.5px; line-height: 1.5; color: var(--mu)">
            service,write,notify as read by a Bluetooth scanner. Prefix with uart: for a Bluetooth-to-serial
            dongle. Leave empty to go back to the built-in profile.
          </p>
          <div class="flex gap-2">
            <input
              v-model="override"
              type="text"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              placeholder="ffe0,ffe1,ffe1"
              class="flex-1 min-w-0"
              style="padding: 6px 8px; font-size: 13px; font-family: var(--font-mono); border: 1px solid var(--ln); border-radius: 5px; background: var(--bg)"
            >
            <button
              type="button"
              style="padding: 6px 10px; font-size: 13px; border: 1px solid var(--ln); border-radius: 5px; background: transparent"
              @click="applyOverride()"
            >
              Apply
            </button>
          </div>
          <p v-if="overrideError" style="margin: 6px 0 0; font-size: 12.5px; color: var(--dg)">{{ overrideError }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
