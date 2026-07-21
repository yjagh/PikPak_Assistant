// Pure reconciliation decision for one virtualized cell (list row / grid card).
// No DOM, no imports — kept a leaf module so it can be unit-tested directly in
// Node (render.js pulls the whole app graph incl. the CSS text import, which a
// plain Node test can't load). render.js imports planCell from here.
//
// prev  : the pool entry from the previous render, or undefined (not mounted)
//         shape { d, index, sel }
// d     : the current item object (identity matters — a reloaded folder makes
//         new objects, so d !== prev.d signals stale content to rebuild)
// index : current position in the display list (row index / card idx)
// sel   : whether this item is currently selected
//
// Returns the work this cell needs this pass:
//   create   – element must be created and appended
//   content  – (re)build innerHTML/className (bakes selection in) + dataset
//   position – (re)set absolute top/left for the current index
//   click    – (re)bind click/dblclick/context/hover handlers — they close over
//              (d, index), so any change to either requires a rebind
//   drag     – (re)bind drag handlers — they close over d only
//   sel      – standalone selection toggle (class + checkbox); only when content
//              is NOT being rebuilt (a content rebuild already bakes selection)
export function planCell(prev, d, index, sel) {
    if (!prev) return { create: true, content: true, position: true, click: true, drag: true, sel: false };
    const content = prev.d !== d;
    const position = prev.index !== index;
    return {
        create: false,
        content,
        position,
        click: content || position,
        drag: content,
        sel: !content && prev.sel !== sel,
    };
}
