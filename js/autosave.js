/* Saving what is being typed, without a write for every keystroke.

   A practice tab holds work that is not finished: a piece of writing half
   written, a set of translations half filled in, a turn not yet sent. Until
   it is handed in, that was only in the page, and a reload, a crash or a
   closed tab took it. So each of those tabs now writes it to the store as
   it is typed, through one of these.

   touch() says something changed. The first touch starts a timer, and the
   save runs when it ends, with whatever is there by then; touches in
   between start no new timer. So while someone types, there is one save
   every `delay` ms and never more, and once they stop, the last thing they
   typed is saved within `delay` ms. A timer restarted by every keystroke
   would save nothing until a pause, and someone who types without pausing
   is exactly who has the most to lose.

   Saves never overlap: one that is asked for while another is still writing
   waits for it, so two writes of the same file cannot land out of order.
   A save that throws is logged and forgotten; the next touch tries again.

   No DOM and no storage here: `save` is the tab's, and goes through the
   store like every other write. The timers can be passed in, for the
   tests. */

export const AUTOSAVE_DELAY = 1000;

export function createAutosave(save, {
  delay = AUTOSAVE_DELAY, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let dirty = false;
  let last = Promise.resolve();

  function run() {
    timer = null;
    if (!dirty) return last;
    dirty = false;
    last = last.then(() => save()).catch((e) => { console.error(e); });
    return last;
  }

  return {
    /* Something changed; it will be saved within `delay` ms. */
    touch() {
      dirty = true;
      if (timer === null) timer = setTimer(run, delay);
    },
    /* Save now whatever is waiting, for a tab being left or a page being
       hidden. Resolves when it, and any save before it, has been written. */
    flush() {
      if (timer !== null) clearTimer(timer);
      return run();
    },
    /* What was waiting is no longer worth saving: the work it belonged to
       was handed in, replaced or deleted. */
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      dirty = false;
    },
  };
}
