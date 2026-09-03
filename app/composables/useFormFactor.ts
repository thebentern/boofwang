import { shellProvidesTransports } from '#core/platform/host.js'

/**
 * Which of the three arrangements a screen should draw.
 *
 * Six components change shape by size - the tab bar, the status bar, the
 * channel rows and their toolbar, the channel editor, the write confirmation
 * and the diff footer - and each of them used to measure `innerWidth` for
 * itself. That was six copies of one rule, and all six had the same bug.
 *
 * **A phone turned sideways is still a phone.** The Pixel reports 448x997 CSS
 * pixels upright and 1199x539 on its side, because the WebView changes its
 * scale rather than its device. Keying on width alone therefore handed a
 * six-inch screen the twelve-column desktop table the moment somebody rotated
 * it: 1199 is wider than any desktop breakpoint, on a device that is plainly
 * not a desktop.
 *
 * So inside a shell the decision is made on the SHORTER edge, which is a
 * property of the hardware and does not change when the thing is turned over.
 * In a browser it stays on width, because there the window is resizable and a
 * deliberately narrow window really is asking for the narrow form - a desktop
 * user dragging a window to half a screen wants the phone layout, and the same
 * user with a short window does not.
 *
 * The two boundaries are Tailwind's `sm` and `lg`, which the rest of the
 * interface already uses in its class names.
 */
const PHONE_BELOW = 640
const DESKTOP_FROM = 1024

export interface FormFactor {
  /** Cards, a bottom tab bar, one-line status bar. */
  phone: Ref<boolean>
  /** The middle band: wider rows, chips without labels, top nav. */
  medium: Ref<boolean>
}

export function useFormFactor(): FormFactor {
  const inShell = shellProvidesTransports(useShell().host)

  const phone = ref(false)
  const medium = ref(false)

  function measure() {
    /*
     * `documentElement.clientWidth`, not the window's own width property.
     *
     * They are the same number in a browser and they are not in this WebView:
     * measured on the Pixel, `clientWidth` said 448 and the window property
     * said 801 for the same page, with nothing on it wider than the viewport.
     * `visualViewport.width` agreed with `clientWidth`, so the window one is
     * the odd out - it reports a value scaled by the WebView rather than the
     * width the CSS actually laid out against.
     *
     * The consequence was a phone rendering the tablet layout: 801 lands in the
     * middle band, so the connect screen grew a desktop nav and a row of
     * buttons on a 6-inch screen. `clientWidth` is what every media query in
     * `main.css` is already resolved against, so this now agrees with them.
     *
     * The height half is used only inside a shell. A phone turned sideways is
     * still a phone and the shorter edge says so, but in a browser a short
     * window is still a desktop - a wide-but-short window wants the table.
     */
    const el = document.documentElement
    const size = inShell ? Math.min(el.clientWidth, el.clientHeight) : el.clientWidth
    phone.value = size < PHONE_BELOW
    medium.value = size >= PHONE_BELOW && size < DESKTOP_FROM
  }

  onMounted(() => {
    measure()
    window.addEventListener('resize', measure)
    /*
     * Android fires `resize` on rotation, but not always before the WebView has
     * settled on its new scale, and iOS is worse about it. `orientationchange`
     * is the event that actually means "the device turned", so both are
     * listened for and `measure` is idempotent.
     */
    window.addEventListener('orientationchange', measure)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('resize', measure)
    window.removeEventListener('orientationchange', measure)
  })

  return { phone, medium }
}
