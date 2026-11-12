// Whether the collection page's Rules form has unsaved changes.
//
// Decided by comparing values with what's saved — never by "a control fired
// a change event". Polaris web components can emit change/input events when
// the page re-renders with fresh data (e.g. right after Resume), with the
// value unchanged; flagging on the event showed "Unsaved changes" for edits
// nobody made. Comparing values also clears the bar if a merchant undoes an
// edit by hand.
export interface RulesValues {
  pins: number;
  pushSoldOutToEnd: boolean;
  boostNewArrivals: boolean;
  giveEveryoneATurn: boolean;
}

export function rulesChanged(saved: RulesValues, draft: RulesValues): boolean {
  return (
    saved.pins !== draft.pins ||
    saved.pushSoldOutToEnd !== draft.pushSoldOutToEnd ||
    saved.boostNewArrivals !== draft.boostNewArrivals ||
    saved.giveEveryoneATurn !== draft.giveEveryoneATurn
  );
}
