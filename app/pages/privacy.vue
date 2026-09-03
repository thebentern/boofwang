<script setup lang="ts">
/**
 * The privacy policy, because Google Play requires every listing to point at
 * one whether or not the app collects anything.
 *
 * It is a separate page from About rather than a section of it for a practical
 * reason: the Play Console wants a URL that is a privacy policy and nothing
 * else, and a reviewer who lands on a credits page and has to scroll for the
 * data section is a reviewer who rejects the listing.
 *
 * Everything here was read out of the code rather than remembered, on
 * 2026-09-03, and each claim names the file that makes it true so the next
 * person can check it the same way:
 *
 *   - no service worker ships in the shell build, so the app makes no request
 *     of its own. `mobile/android/app/src/main/assets/public/` has no sw.js.
 *   - the three directory lookups are in `lib/data/`. Only radioid.ts puts
 *     anything of the user's in a URL, and it is the callsign typed into the
 *     search box: `?callsign=...` at radioid.ts:122. hearham.ts and
 *     brandmeister.ts fetch fixed paths with no query at all.
 *   - `app/pages/repeaters.vue` asks the operating system for a position only
 *     when the button is pressed, and puts it in the two coordinate boxes.
 *     Nothing sends it: radioid refuses a positional query outright and the
 *     other two are filtered on the device.
 *
 * If any of that changes, this page is wrong, and a privacy policy that is
 * wrong is worse than none.
 */
useSeoMeta({
  title: 'Privacy',
  description: 'What boofwang stores, what it sends and what it does not.',
})

const HEADING = 'font-size:12.5px;font-weight:600;letter-spacing:0.02em'
const BODY = 'font-size:12.5px;line-height:1.65;color:var(--mu)'
const ICON = 'width:13px;height:13px;color:var(--fn);flex-shrink:0'
const LINK = 'color:var(--in)'

/**
 * The three directories, and exactly what each one receives.
 *
 * A table rather than a paragraph because the interesting difference between
 * them is one word: only radioid gets given anything you typed. A sentence
 * listing all three together would bury that.
 */
const DIRECTORIES = [
  {
    host: 'hearham.com',
    what: 'The whole repeater directory, as one file.',
    sends: 'Nothing but the request itself.',
    url: 'https://hearham.com/',
  },
  {
    host: 'radioid.net',
    what: 'DMR repeaters registered to a callsign.',
    sends: 'The callsign you typed into the search box.',
    url: 'https://radioid.net/',
  },
  {
    host: 'brandmeister.network',
    what: 'The talkgroup and device lists.',
    sends: 'Nothing but the request itself.',
    url: 'https://brandmeister.network/',
  },
]
</script>

<template>
  <div class="mx-auto" style="max-width: 720px; padding: 26px 16px 56px">
    <div class="flex items-center gap-[9px]" style="margin-bottom: 8px">
      <UIcon name="i-lucide-shield" style="width: 17px; height: 17px; color: var(--tx)" />
      <h1 style="font-size: 22px; font-weight: 600; letter-spacing: -0.02em">Privacy</h1>
    </div>

    <p style="margin-bottom: 6px; font-size: 14.5px; line-height: 1.65; color: var(--mu)">
      boofwang collects nothing. There is no account, no analytics, no advertising and no server of
      ours for anything to be sent to. What you read off a radio stays on the device you read it with.
    </p>
    <p style="margin-bottom: 24px; font-size: 12.5px; line-height: 1.6; color: var(--fn)">
      That is the whole policy. The rest of this page is the detail behind it, because a claim this
      broad is worth nothing unless you can check it.
    </p>

    <section style="margin-bottom: 22px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 6px">
        <UIcon name="i-lucide-lock" :style="ICON" />
        What stays on your device
      </h2>
      <p :style="BODY">
        Codeplugs you read, the backups boofwang keeps of them, your presets, your scan lists and your
        settings are held in the app's own storage on the device, and in whatever files you choose to
        export. None of it is transmitted. Deleting a backup in boofwang deletes it; uninstalling the
        app removes everything it kept, and files you exported yourself stay wherever you saved them.
      </p>
    </section>

    <section style="margin-bottom: 22px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 6px">
        <UIcon name="i-lucide-key" :style="ICON" />
        Encryption keys
      </h2>
      <p :style="BODY">
        Keys you type into a radio's key slots are stored the same way as everything else: on the
        device, unencrypted, in the app's own storage. boofwang masks them on screen and keeps them out
        of summaries and every export that is not a full codeplug, but that is protection against a
        glance over your shoulder, not against someone with access to your unlocked device or to a
        codeplug file you exported. Treat an exported codeplug as key material.
      </p>
    </section>

    <section style="margin-bottom: 22px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 6px">
        <UIcon name="i-lucide-server" :style="ICON" />
        What leaves, and only when you ask
      </h2>
      <p :style="BODY" style="margin-bottom: 10px">
        boofwang makes no network request on its own. It does not check for updates, report errors or
        load anything from another host. The only requests it ever makes are the repeater and
        talkgroup lookups, and each one happens because you pressed a button to make it happen.
      </p>

      <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px">
        <div
          v-for="(d, i) in DIRECTORIES"
          :key="d.host"
          style="padding: 12px 15px"
          :style="{ borderBottom: i === DIRECTORIES.length - 1 ? 'none' : '1px solid var(--ln)' }"
        >
          <a :href="d.url" target="_blank" rel="noopener" class="font-mono" style="font-size: 12px" :style="LINK">{{ d.host }}</a>
          <p style="font-size: 12px; line-height: 1.55; color: var(--mu); margin-top: 3px">{{ d.what }}</p>
          <p style="font-size: 12px; line-height: 1.55; color: var(--fn); margin-top: 2px">
            Sends: {{ d.sends }}
          </p>
        </div>
      </div>

      <p :style="BODY" style="margin-top: 10px">
        Like any request from your device, each one shows that host your IP address. Those three
        services are not run by boofwang and are not accountable to this policy: what they log is
        theirs to say, and their own terms apply once you have asked boofwang to talk to them.
      </p>
    </section>

    <section style="margin-bottom: 22px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 6px">
        <UIcon name="i-lucide-globe" :style="ICON" />
        Your location
      </h2>
      <p :style="BODY">
        The repeater search can fill in your latitude and longitude for you, and does that only if you
        press the button that asks for it. The coordinates go into the two boxes on that screen and are
        used on the device to work out how far away each repeater is. They are not sent to any of the
        directories above: one of them refuses a search by position outright, and the other two are
        filtered here, after their whole list has been fetched. You can type coordinates in by hand
        instead and boofwang will never ask the operating system for a position at all.
      </p>
    </section>

    <section style="margin-bottom: 22px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 6px">
        <UIcon name="i-lucide-radio" :style="ICON" />
        The radio itself
      </h2>
      <p :style="BODY">
        Reaching a radio over a cable or over Bluetooth needs permission from your operating system,
        and boofwang asks for it at the moment you connect rather than up front. Bluetooth is declared
        as not being used to derive your location, which is true: the scan looks for one radio and
        nothing else. Neither permission is used for anything other than talking to the radio you
        chose.
      </p>
    </section>

    <section style="margin-bottom: 22px">
      <h2 class="flex items-center gap-[7px]" :style="HEADING" style="margin-bottom: 6px">
        <UIcon name="i-lucide-info" :style="ICON" />
        Children, changes and getting hold of us
      </h2>
      <p :style="BODY">
        boofwang is a tool for licensed and license-exempt radio operators and is not directed at
        children. Because it collects nothing, there is nothing held about anyone to request, correct
        or have deleted.
      </p>
      <p :style="BODY" style="margin-top: 8px">
        This policy describes the build named in the footer of every page. If it changes, the change
        arrives in a build, and the source it describes is public: raise anything that looks wrong as
        an
        <a
          href="https://github.com/thebentern/boofwang/issues"
          target="_blank"
          rel="noopener"
          :style="LINK"
        >issue on GitHub</a>, which is also how to reach the author.
      </p>
    </section>
  </div>
</template>
