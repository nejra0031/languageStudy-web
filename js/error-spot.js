/* Where a tab's error banner is shown. Each tab has one error box near the
   top of its panel, which is the right place for an error that belongs to
   nothing in particular (a file that could not be read). An error from
   something the learner was waiting on belongs where they were looking:
   the spinner they were watching turns into the error, in the same spot, so
   one that fails at the foot of a long page is not reported above the fold
   where nobody sees it.

   errorSpot(box) remembers where the box lives and returns place(anchor):
   with an element, the box is moved to just after it; without one, it goes
   back home. The box keeps its id and its listeners wherever it is, so a
   Try again button inside it works the same in either place. */

export function errorSpot(box) {
  const home = document.createComment(' error home ');
  box.before(home);
  return function place(anchor) {
    if (anchor && anchor.isConnected && anchor !== box) anchor.after(box);
    else home.after(box);
  };
}
