import { nextTick, ref, watch, type Ref, type WatchSource } from "vue";

/**
 * Auto scroll for append-only log views.
 *
 * Every live surface on this site that streams rows (the MIDI monitor, the
 * serial terminal, the HID report log, the flasher log, the ffmpeg log tails)
 * wants the same behavior, and every one of them used to reimplement it or
 * skip it: keep the newest line in view while the reader is at the bottom, and
 * stop fighting them the moment they scroll up to read back.
 *
 * Usage:
 *
 *   const { el, onScroll } = useStickToBottom(() => rows.value.length);
 *   <div ref="el" @scroll.passive="onScroll">…</div>
 *
 * `source` is any watch source that changes when a row is appended, so a length
 * getter, a revision counter or the rendered list itself all work.
 */
export function useStickToBottom(source: WatchSource<unknown>): {
  el: Ref<HTMLElement | null>;
  stuck: Ref<boolean>;
  onScroll: () => void;
  scrollToBottom: () => void;
} {
  const el = ref<HTMLElement | null>(null);
  const stuck = ref(true);

  // A few pixels of slack: browsers report fractional scroll positions at some
  // zoom levels, so an exact equality check would unstick a reader who never
  // moved.
  const SLACK_PX = 40;

  function onScroll() {
    const node = el.value;
    if (!node) return;
    stuck.value = node.scrollHeight - node.scrollTop - node.clientHeight < SLACK_PX;
  }

  function scrollToBottom() {
    const node = el.value;
    if (node) node.scrollTop = node.scrollHeight;
  }

  // The scroll waits a tick so the new rows are in the DOM and `scrollHeight`
  // has grown. `stuck` is rechecked after that wait, not just before it: a
  // reader who scrolls up while the tick is pending must not get yanked back
  // down.
  async function followIfStuck() {
    if (!stuck.value) return;
    await nextTick();
    if (!stuck.value) return;
    scrollToBottom();
  }

  watch(source, followIfStuck);

  // The log box is usually behind a `v-if`, so it mounts with content already
  // in it. Land at the bottom the first time it appears.
  watch(el, (node) => {
    if (node) void followIfStuck();
  });

  return { el, stuck, onScroll, scrollToBottom };
}
