/** @layer character-studio */
/*
 * Unsaved-changes checks for Character Studio. snapshotInitial records a pane's state after a load or save, and
 * the other functions compare the live pane against it. tab-model.mjs uses them for the unsaved-changes dot and
 * to warn before a tab is closed. No DOM access: everything read is plain data on a canvas view or tab.
 */

/* -------------------------------------------- */
/*  Edit Tracking                               */
/* -------------------------------------------- */

/**
 * The pane's edit counter, which goes up with every pixel edit and never goes down. The undo stack's depth can't
 * stand in for it: the depth stops growing at the undo limit, so later edits would look like no change at all.
 */
function editSerialOf(view) {
  return view?._editSerial ?? 0;
}

/* -------------------------------------------- */
/*  Saved State                                 */
/* -------------------------------------------- */

/**
 * Record a pane's state after it's loaded or saved: the edit counter, plus everything a save would write for each
 * layer (position, transform, visibility, palette and custom name). Every layer is recorded, since token sprites
 * usually have several (body, hair, parts). viewPristine compares against the result.
 * @returns {object|null} null if there's no view.
 */
export function snapshotInitial(view) {
  if (!view) return null;
  return {
    editSerial: editSerialOf(view),
    layers: view.layers.map(L => ({
      id:       L.id,
      x:        L.x,
      y:        L.y,
      scale:    L.scale,
      rotation: L.rotation,
      flipX:    !!L.flipX,
      flipY:    !!L.flipY,
      opacity:  L.opacity ?? 1,
      visible:  L.visible !== false,
      // Recorded directly because some palette changes bypass the colour panel and don't bump the edit counter.
      palette:  L._feccPalette ? JSON.stringify(L._feccPalette) : null,
      // Renaming doesn't bump the edit counter either, but the name is saved.
      customName: L.customName ?? null
    }))
  };
}

/* -------------------------------------------- */

/**
 * Whether a pane still matches the state snapshotInitial recorded. With nothing recorded it counts as edited,
 * because wrongly calling a pane clean loses work. Positions and transforms are compared with a small tolerance,
 * since saving and reloading can shift floating-point values slightly.
 */
export function viewPristine(view, init) {
  if (!view || !init || !Array.isArray(init.layers)) return false;
  if (editSerialOf(view) !== init.editSerial) return false;
  if (view.layers.length !== init.layers.length) return false;
  const EPS = 1e-9;
  for (let i = 0; i < view.layers.length; i++) {
    const L = view.layers[i];
    const s = init.layers[i];
    if (L.id !== s.id) return false;
    if (Math.abs(L.x - s.x) > EPS) return false;
    if (Math.abs(L.y - s.y) > EPS) return false;
    if (Math.abs(L.scale - s.scale) > EPS) return false;
    if (Math.abs(L.rotation - s.rotation) > EPS) return false;
    if (!!L.flipX !== s.flipX) return false;
    if (!!L.flipY !== s.flipY) return false;
    if ((L.opacity ?? 1) !== s.opacity) return false;
    if ((L.visible !== false) !== s.visible) return false;
    if ((L._feccPalette ? JSON.stringify(L._feccPalette) : null) !== (s.palette ?? null)) return false;
    if ((L.customName ?? null) !== (s.customName ?? null)) return false;
  }
  return true;
}

/* -------------------------------------------- */
/*  Dirty State                                 */
/* -------------------------------------------- */

/**
 * Whether a pane has changes a Save would act on, which is what the unsaved-changes dot shows (through sideDirty
 * in tab-model.mjs). An emptied pane counts as changed while there's still art to delete: it had layers when it
 * was loaded, or the actor still has a file stored for it (as when a deletion comes back from the workspace with
 * nothing recorded). That matches the save path's own check, so the dot appears exactly when Save would do
 * something, including clearing a path whose file has gone missing.
 *
 * A pane not built this session is judged by the workspace draft it's holding, which Save All would apply and
 * save: drawn layers are unsaved, and an empty layer list is a pending deletion under the same rule as above.
 * @param {object} o
 * @param {object|null} o.view The pane's canvas view, or null if it hasn't been created yet.
 * @param {object|null} o.init The state snapshotInitial recorded, if any.
 * @param {boolean} o.bound False for scratch panes, which aren't tied to an actor's art slot.
 * @param {string} o.storedPath The file the actor currently has stored for this pane.
 * @param {object|null} [o.pending] The workspace draft a pane with no view is holding.
 * @returns {boolean}
 */
export function paneDirty({ view, init, bound, storedPath, pending = null }) {
  if (!view) {
    if (!pending) return false;
    if ((pending.layers?.length ?? 0) > 0) return true;
    return !!bound && !!storedPath;
  }
  if (view.layers.length === 0) {
    if ((init?.layers?.length ?? 0) > 0) return true;
    if (!bound) return false;
    return !!storedPath;
  }
  return !viewPristine(view, init);
}

/* -------------------------------------------- */

/**
 * Whether closing a tab would throw away work that exists nowhere else, so tabWouldLoseWork (tab-model.mjs) can
 * ask first. This differs from the unsaved-changes dot: a scratch tab never shows the dot, but its pixels live
 * only on its canvas, so closing it with any layers loses work. Closing the whole window is safe, because that
 * saves scratch tabs to the workspace first.
 * @param {object} o
 * @param {boolean} o.bound Whether the tab is tied to an actor's art slot.
 * @param {boolean} o.dirty Whether it has unsaved changes.
 * @param {number} [o.tokenLayers] Layer count on its token pane.
 * @param {number} [o.avatarLayers] Layer count on its avatar pane.
 * @returns {boolean}
 */
export function wouldLoseWork({ bound, dirty, tokenLayers = 0, avatarLayers = 0 }) {
  if (bound) return !!dirty;
  return tokenLayers > 0 || avatarLayers > 0;
}

/* -------------------------------------------- */
/*  Held Drafts                                 */
/* -------------------------------------------- */

/**
 * The actor entries to save in the workspace, with held entries added back. An actor the user can't open right
 * now (its ownership was removed) is held instead of dropped, so its unsaved panes survive until it can be
 * opened again. If the same actor was also opened this session, the fresh entry wins.
 * @param {object[]} actors Entries serialised from the actors open in the studio.
 * @param {Map<string, {entry: object}>} held Held entries by actor id.
 * @returns {object[]}
 */
export function withHeldWorkspaceActors(actors, held) {
  const bound = new Set(actors.map(entry => entry.actorId));
  const kept = [...held.values()].map(record => record.entry).filter(entry => !bound.has(entry?.actorId));
  return kept.length ? [...actors, ...kept] : actors;
}
