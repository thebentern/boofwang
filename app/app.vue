<script setup lang="ts">
useHead({
  titleTemplate: (t) => (t ? `${t} · boofwang` : 'boofwang'),
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
