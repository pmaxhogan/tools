<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Star } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { FAVORITES_KEY, isFavorite, toggleFavorite } from "@/lib/favorites";
import { onPrefsChange, readList, writeList } from "@/lib/prefs";
import { toast } from "@/lib/toast";

/**
 * Pins a tool, so it rides at the top of the homepage and the sidebar. The list
 * of pinned slugs is a preference, so it lives in localStorage (rule 7); the
 * pure list helpers are in src/lib/favorites.ts and the storage plus the
 * cross-surface notification are in src/lib/prefs.ts.
 *
 * SSR: what is pinned is unknown at build time, so the button always renders
 * unpressed and reads storage in `onMounted`. The static build and the first
 * client render agree, which keeps hydration clean (same approach as
 * PopoutButton and CapabilityGate).
 *
 * Several of these can be on screen at once (one per homepage card, one in the
 * panel header), so each subscribes to `prefs-change` and to the cross-tab
 * `storage` event: starring a tool on its page lights the same tool's star up
 * on the homepage behind it without a reload.
 */
const props = withDefaults(
  defineProps<{
    slug: string;
    /** Button size token. The default is the small square icon button. */
    size?: "icon-xs" | "icon-sm" | "icon";
  }>(),
  { size: "icon-sm" },
);

const favorites = ref<string[]>([]);
let stop: (() => void) | null = null;

const active = computed(() => isFavorite(favorites.value, props.slug));
const label = computed(() => (active.value ? "Remove from favorites" : "Add to favorites"));

function refresh(): void {
  favorites.value = readList(FAVORITES_KEY);
}

function toggle(): void {
  const next = toggleFavorite(readList(FAVORITES_KEY), props.slug);
  favorites.value = next;
  writeList(FAVORITES_KEY, next);
  // The star itself fills and unfills, but on the homepage the card it belongs
  // to only moves after a re-sort, and in the panel header nothing else on
  // screen changes at all. Say what happened, the same way a copy does.
  toast({ title: isFavorite(next, props.slug) ? "Added to favorites" : "Removed from favorites" });
}

onMounted(() => {
  refresh();
  stop = onPrefsChange(FAVORITES_KEY, refresh);
});

onUnmounted(() => {
  stop?.();
  stop = null;
});
</script>

<template>
  <Button
    variant="ghost"
    :size="props.size"
    type="button"
    class="favorite-button"
    :aria-pressed="active"
    :aria-label="label"
    :title="label"
    :data-favorite="active ? 'true' : undefined"
    @click="toggle"
  >
    <Star :fill="active ? 'currentColor' : 'none'" :stroke-width="2" aria-hidden="true" />
  </Button>
</template>

<style scoped>
.favorite-button {
  color: var(--muted-foreground);
  transition: color 120ms ease-out;
}

.favorite-button:hover {
  color: var(--foreground);
}

.favorite-button[data-favorite="true"] {
  color: var(--primary);
}

@media (prefers-reduced-motion: reduce) {
  .favorite-button {
    transition: none;
  }
}
</style>
