<script setup lang="ts">
/**
 * The way back, wherever the edit was made.
 *
 * One history serves the whole document, so one control does too. It sits in
 * the status bar because that is the only surface on every page a codeplug can
 * be edited from, and because the bar is already where the question "have I
 * changed anything, and can I get back" is answered.
 *
 * Both buttons name the action they would take back rather than saying only
 * "Undo". With one stack behind several screens, the press that reverts a
 * talk group import and the press that reverts a frequency typo look
 * identical, and the only thing that tells them apart before the click is the
 * label the store already keeps.
 */
const codeplug = useCodeplugStore()

/**
 * `roomy` is the phone's expanded panel: 48px targets, the word always shown,
 * and Redo omitted entirely rather than sitting disabled.
 *
 * A prop rather than a second component, because the rule this control exists
 * to enforce is that exactly one place calls `codeplug.undo()`. A phone-shaped
 * copy would be a second place, and the two would disagree the moment one grew
 * a guard the other did not - which is the failure `undo-affordance.spec.ts`
 * watches for.
 *
 * Disabled-and-present is right in a toolbar, where the gap would otherwise
 * shift every neighbouring control as history changes. It is wrong in a panel
 * that is already a tap away: half a row held to be grey is half a row of a
 * phone.
 */
const props = withDefaults(defineProps<{ roomy?: boolean }>(), { roomy: false })

const undoTitle = computed(() =>
  codeplug.canUndo ? `Undo ${codeplug.undoLabel} (${undoHint.value})` : 'Nothing to undo',
)
const redoTitle = computed(() =>
  codeplug.canRedo ? `Redo ${codeplug.redoLabel} (${redoHint.value})` : 'Nothing to redo',
)
</script>

<template>
  <!--
    The words are load-bearing, not decoration: lucide has no undo and no redo
    arrow in the offline bundle, so these two icons are approximations read the
    right way round - anticlockwise for back, clockwise for forward - and the
    word is what makes them unambiguous. Where the bar is too narrow for the
    word the title and the accessible name still carry it, which is why both
    are set on every render rather than only when the label is hidden.
  -->
  <div class="flex items-center" :style="{ gap: props.roomy ? '8px' : '4px' }">
    <RiskAction
      risk="neutral"
      ghost
      :size="props.roomy ? 'md' : 'sm'"
      :style="props.roomy ? { height: '48px', borderRadius: '8px', fontSize: '13.5px' } : undefined"
      icon="i-lucide-history"
      :disabled="!codeplug.canUndo"
      :title="undoTitle"
      :aria-label="undoTitle"
      data-testid="undo"
      @click="codeplug.undo()"
    >
      <span :class="props.roomy ? '' : 'hidden lg:inline'">
        {{ props.roomy && codeplug.canUndo ? `Undo ${codeplug.undoLabel}` : 'Undo' }}
      </span>
    </RiskAction>
    <RiskAction
      v-if="!props.roomy || codeplug.canRedo"
      risk="neutral"
      ghost
      :size="props.roomy ? 'md' : 'sm'"
      :style="props.roomy ? { height: '48px', width: '48px', borderRadius: '8px', padding: '0' } : undefined"
      icon="i-lucide-refresh-cw"
      :disabled="!codeplug.canRedo"
      :title="redoTitle"
      :aria-label="redoTitle"
      data-testid="redo"
      @click="codeplug.redo()"
    >
      <span :class="props.roomy ? 'sr-only' : 'hidden lg:inline'">Redo</span>
    </RiskAction>
  </div>
</template>
