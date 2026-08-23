<script setup lang="ts">
import { commitUrl, describeAge, formatBuild } from '#core/version/build.js'

/**
 * The page that answers "who wrote this and what does it do with my data",
 * plus the one place that asks for anything back.
 *
 * Prose column, 720px. Everything here is a claim someone can check, so the
 * credits carry their licence and a link to the upstream work rather than a
 * thank-you list - the GPL obliges anyone redistributing boofwang to be able to
 * trace where its knowledge of each radio came from, and `docs/provenance.md`
 * is the long form of this section.
 */
useSeoMeta({ title: 'About' })

/**
 * The section heading and body styles are named once because five headings that
 * are meant to be identical will not stay identical if they are typed five times.
 */
const HEADING = 'font-size:12.5px;font-weight:600;letter-spacing:0.02em'
const BODY = 'font-size:12.5px;line-height:1.65;color:var(--mu)'
const ICON = 'width:13px;height:13px;color:var(--fn);flex-shrink:0'

/** A link inside prose. Blue is the only unearned colour on this page. */
const LINK = 'color:var(--in)'

/**
 * Which build this is, and whether it is stored on the device.
 *
 * The long form of the version in the footer. It exists because the offline
 * copy makes a stale boofwang possible: a browser that has stored one build
 * will keep opening it, and the two facts that let somebody tell whether that
 * has happened to them are which commit they are running and when the app last
 * managed to look for a newer one. Both are here, alongside the button that
 * asks now.
 */
const build = useBuildInfo()
const { state: update, pending, check } = useAppUpdate()

const commitHref = computed(() => commitUrl(build))

/*
 * Recomputed on a tick rather than once at setup. This page is left open while
 * somebody reads it, and "just now" that is quietly forty minutes old is the
 * sort of small lie that makes a diagnostic worth less than nothing.
 */
const now = ref(new Date())
let ticker: ReturnType<typeof setInterval> | undefined
onMounted(() => (ticker = setInterval(() => (now.value = new Date()), 30_000)))
onBeforeUnmount(() => clearInterval(ticker))

const committedAge = computed(() => describeAge(build.committedAt, now.value))
const checkedAge = computed(() => (update.lastCheckedAt ? describeAge(update.lastCheckedAt, now.value) : null))

const credits = [
  {
    name: 'CHIRP',
    licence: 'GPL-3.0',
    url: 'https://chirpmyradio.com/',
    what: 'Memory layouts and protocol details for the UV-K5 and UV-5R Mini were transcribed from its drivers, and its stock channel configurations are the source of the bundled FRS/GMRS/MURS/weather presets.',
  },
  {
    name: 'DM-32UV Protocol Specification',
    licence: 'MIT',
    url: 'https://github.com/infamy/DM32-Protocol-Spec',
    what: 'The only public documentation of the DM-32UV serial protocol and memory layout. Everything boofwang knows about that radio starts here.',
  },
  {
    name: 'UV-K5 reverse engineering notes',
    licence: 'CC-BY-SA-4.0',
    url: 'https://github.com/sq5bpf/uvk5-reverse-engineering',
    what: 'Jacek Lipkowski SQ5BPF’s original work on the UV-K5 framing, obfuscation and EEPROM map.',
  },
]
</script>

<template>
  <div class="mx-auto" style="max-width: 720px; padding: 26px 16px 56px">
    <div class="flex items-center gap-[9px]" style="margin-bottom: 8px">
      <UIcon name="i-lucide-info" style="width: 17px; height: 17px; color: var(--tx)" />
      <h1 style="font-size: 22px; font-weight: 600; letter-spacing: -0.02em">About boofwang</h1>
    </div>

    <p style="margin-bottom: 24px; font-size: 14.5px; line-height: 1.65; color: var(--mu)">
      A codeplug editor and programmer that runs in your browser, at
      <a href="https://boofwa.ng" :style="LINK">boofwa.ng</a>. It speaks to radios over the Web Serial
      API, so nothing needs installing and there is no account to create. There is also a
      <a href="https://github.com/thebentern/boofwang/releases" target="_blank" rel="noopener" :style="LINK">desktop
      build</a>, which is the same application in a window of its own: it exists because two repeater
      directories refuse to answer a browser, and it can ask them on your behalf.
    </p>

    <section style="margin-bottom: 22px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 8px">
        <UIcon name="i-lucide-box" :style="ICON" />
        This build
      </h2>

      <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px">
        <div style="padding: 15px 18px; border-bottom: 1px solid var(--ln)">
          <div class="flex items-center flex-wrap gap-x-2.5 gap-y-1">
            <span class="font-mono tabular" style="font-size: 14px; font-weight: 600; color: var(--tx)">
              {{ formatBuild(build) }}
            </span>
            <a
              v-if="commitHref"
              :href="commitHref"
              target="_blank"
              rel="noopener"
              class="inline-flex items-center gap-1"
              style="font-size: 12.5px"
              :style="LINK"
            >
              View this commit
              <UIcon name="i-lucide-external-link" style="width: 11px; height: 11px" />
            </a>
          </div>
          <p v-if="committedAge" style="margin-top: 3px; font-size: 12.5px; color: var(--fn)">
            Committed {{ committedAge }}.
          </p>
        </div>

        <div style="padding: 15px 18px">
          <!--
            Stated as a fact about this device, not as a feature. Whether the
            app is stored here is the difference between it opening on a hilltop
            and not opening at all, and it is not something a person can find
            out any other way.
          -->
          <p style="font-size: 13.5px; line-height: 1.55; color: var(--mu)">
            <template v-if="update.support.blocker === 'desktop-shell'">
              This is the desktop build, which is already an installed application and already works without a
              network. It updates by being replaced, from the releases page.
            </template>
            <template v-else-if="update.offlineReady">
              Stored on this device. boofwang opens without a network, and the copy it opens is the one named
              above until an update is applied.
            </template>
            <template v-else-if="update.support.supported">
              Not stored on this device yet. Reload once and boofwang keeps a copy, so it will open without a
              network afterwards.
            </template>
            <template v-else>
              {{ update.support.advice }}
            </template>
          </p>

          <div
            v-if="update.support.supported"
            class="flex items-center flex-wrap gap-x-3 gap-y-2"
            style="margin-top: 11px"
          >
            <RiskAction
              risk="neutral"
              ghost
              size="sm"
              icon="i-lucide-refresh-cw"
              :label="pending ? 'An update is waiting' : 'Check for updates'"
              :loading="update.checking"
              :disabled="pending"
              @click="check()"
            />
            <span style="font-size: 12.5px; color: var(--fn)">
              <template v-if="pending">Apply it from the bar at the top of the page.</template>
              <template v-else-if="checkedAge">Last checked {{ checkedAge }}.</template>
              <template v-else>Not checked yet on this device.</template>
            </span>
          </div>

          <p v-if="update.failure" style="margin-top: 8px; font-size: 12.5px; color: var(--dg)">
            The check did not complete: {{ update.failure }}
          </p>
        </div>
      </div>
    </section>

    <section style="margin-bottom: 22px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 6px">
        <UIcon name="i-lucide-server" :style="ICON" />
        Where your data goes
      </h2>
      <p :style="BODY">
        Nowhere. boofwang is a static site: no backend, no analytics, no upload endpoint. Codeplugs you
        read are held in your browser and in files you explicitly save. Encryption keys you enter are
        treated the same way, which also means anyone with access to your browser profile or to an
        exported file can read them.
      </p>
    </section>

    <section style="margin-bottom: 22px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 6px">
        <UIcon name="i-lucide-scale" :style="ICON" />
        Licence
      </h2>
      <p :style="BODY">
        Free software under the
        <a
          href="https://www.gnu.org/licenses/gpl-3.0.html"
          target="_blank"
          rel="noopener"
          :style="LINK"
        >GNU General Public License, version 3 or later</a>. It comes with absolutely no warranty.
        Programming a radio incorrectly can render it unusable; always keep a backup you have verified
        you can restore.
      </p>
    </section>

    <section style="margin-bottom: 22px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 6px">
        <UIcon name="i-lucide-info" :style="ICON" />
        Not affiliated
      </h2>
      <p :style="BODY">
        An independent project, not affiliated with, endorsed by, or supported by Baofeng, Quansheng, or
        the CHIRP project. Radio model names identify the hardware each driver targets and nothing more.
      </p>
    </section>

    <section style="margin-bottom: 22px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 8px">
        <UIcon name="i-lucide-heart" :style="ICON" />
        Credits
      </h2>
      <p :style="BODY" style="margin-bottom: 10px">
        boofwang would not exist without the people who reverse-engineered these radios and published
        what they found.
      </p>

      <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px">
        <div
          v-for="(credit, index) in credits"
          :key="credit.name"
          style="padding: 17px 19px"
          :style="index < credits.length - 1 ? { borderBottom: '1px solid var(--ln)' } : {}"
        >
          <div class="flex items-center gap-2" style="margin-bottom: 3px">
            <a
              :href="credit.url"
              target="_blank"
              rel="noopener"
              class="inline-flex items-center gap-1.5"
              style="font-size: 14px; font-weight: 600; color: var(--tx)"
            >
              {{ credit.name }}
              <UIcon name="i-lucide-external-link" style="width: 11px; height: 11px; color: var(--fn)" />
            </a>
            <span
              class="chip font-mono"
              style="color: var(--fn); border: 1px solid var(--ln)"
            >{{ credit.licence }}</span>
          </div>
          <p style="font-size: 13.5px; line-height: 1.55; color: var(--mu)">{{ credit.what }}</p>
        </div>
      </div>

      <p :style="BODY" style="margin-top: 10px">
        The FRS, GMRS and MURS channel tables come from 47 CFR Part 95 at the eCFR and the weather
        channels from NOAA/NWS, both United States Government work, in the public domain.
        <a
          href="https://github.com/thebentern/boofwang/blob/main/docs/provenance.md"
          target="_blank"
          rel="noopener"
          :style="LINK"
        >docs/provenance.md</a>
        records every source in full, and what boofwang deliberately does not use.
      </p>
    </section>

    <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 15px 16px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 5px">
        <UIcon name="i-lucide-git-branch" :style="ICON" />
        Help it along
      </h2>
      <p style="margin-bottom: 12px; font-size: 14px; line-height: 1.6; color: var(--mu)">
        Bug reports with a protocol log are worth more than anything else, especially from a radio
        nobody here owns. Drivers are welcome too.
      </p>

      <div class="flex flex-wrap gap-[7px]">
        <a
          href="https://github.com/thebentern/boofwang/issues/new"
          target="_blank"
          rel="noopener"
          class="inline-flex items-center gap-[7px] rounded-[5px]"
          style="height: 30px; padding: 0 12px; border: 1px solid var(--ln2); font-size: 14px; font-weight: 500; color: var(--tx)"
        >
          <UIcon name="i-lucide-bug" style="width: 13px; height: 13px" />
          Report a bug
        </a>

        <a
          href="https://github.com/thebentern/boofwang"
          target="_blank"
          rel="noopener"
          class="inline-flex items-center gap-[7px] rounded-[5px]"
          style="height: 30px; padding: 0 12px; border: 1px solid var(--ln); font-size: 14px; color: var(--mu)"
        >
          <UIcon name="i-lucide-git-branch" style="width: 13px; height: 13px" />
          Contribute a driver
        </a>

        <a
          href="https://buymeacoffee.com/thebentern"
          target="_blank"
          rel="noopener"
          class="inline-flex items-center gap-[7px] rounded-[5px]"
          style="height: 30px; padding: 0 12px; border: 1px solid var(--cnL); background: var(--cnB); font-size: 14px; font-weight: 500; color: var(--cn)"
        >
          <UIcon name="i-lucide-coffee" style="width: 13px; height: 13px" />
          Buy me a coffee
        </a>
      </div>
    </div>
  </div>
</template>
