/*
 * Asking the system to show newly saved art without a reload: redrawing an actor's tokens and its open Actor
 * Control Panel, and opening that panel from Character Studio.
 */

import { createStudioNotifier } from './notify.mjs';
import { openControlPanel, refreshAuthoringPanel, refreshTokenArt } from './system-bridge.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Document Refresh                            */
/* -------------------------------------------- */

/**
 * Show newly saved token art without a reload: the system's `presentation.tokenArt.refresh` redraws the actor's
 * tokens and its Control Panel, then the sheet re-renders and each placed token refreshes.
 */
export async function refreshActorTokenArt(actor) {
  try { await refreshTokenArt(actor.uuid, { force: true }); } catch (error) {
    notify.failure(`The system could not redraw the tokens of ${actor.name} with the new art.`, error);
  }
  actor.sheet?.render?.();
  for (const token of actor.getActiveTokens?.() ?? []) {
    token.renderFlags?.set?.({ refresh: true, refreshShape: true });
  }
  return undefined;
}

/**
 * Ask the system to redraw the actor's open Control Panel after an avatar save. Returns whether it did.
 */
export function refreshActorAuthoringPanel(actor) {
  try { return refreshAuthoringPanel(actor.uuid); } catch (error) {
    notify.failure(`The system could not redraw the Control Panel of ${actor.name}.`, error);
    return false;
  }
}

/**
 * Open the Actor Control Panel for an actor, from Character Studio's Control Panel header button. The system has a
 * Control Panel only for a Character, so a Vendor or Convoy opens its own sheet instead.
 * @param {Actor} actor
 */
export function openActorConfiguration(actor) {
  if (actor.type !== 'Character') return void actor.sheet?.render({ force: true });
  try {
    if (!openControlPanel(actor.uuid)) notify.warn('You may not open the Control Panel for ' + actor.name + '.');
  } catch (error) {
    notify.failure(`The system could not open the Control Panel for ${actor.name}.`, error);
  }
}
