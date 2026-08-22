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
  <div class="flex items-center" style="gap: 4px">
    <RiskAction
      risk="neutral"
      ghost
      size="sm"
      icon="i-lucide-history"
      :disabled="!codeplug.canUndo"
      :title="undoTitle"
      :aria-label="undoTitle"
      data-testid="undo"
      @click="codeplug.undo()"
    >
      <span class="hidden lg:inline">Undo</span>
    </RiskAction>
    <RiskAction
      risk="neutral"
      ghost
      size="sm"
      icon="i-lucide-refresh-cw"
      :disabled="!codeplug.canRedo"
      :title="redoTitle"
      :aria-label="redoTitle"
      data-testid="redo"
      @click="codeplug.redo()"
    >
      <span class="hidden lg:inline">Redo</span>
    </RiskAction>
  </div>
</template>
