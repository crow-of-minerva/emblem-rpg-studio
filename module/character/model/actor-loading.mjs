/*
 * Which Actors Character Studio will load: a world Actor of a type whose art the studio can address. Each way of
 * loading an Actor passes the checks it makes and their order, and every refusal's wording lives here.
 *
 * This only checks the Actor itself. Whether the signed-in user may edit its art is `actorArtAccessFor` in
 * foundry/access.mjs.
 */

/* -------------------------------------------- */
/*  Verdicts                                    */
/* -------------------------------------------- */

/**
 * The refusal for a compendium entry, or any Actor the world's Actor collection doesn't hold. Compendium entries
 * aren't imported: the studio writes art paths and compositions onto the Actor, so it needs the world copy the game
 * uses.
 */
const NOT_IN_WORLD_MESSAGE =
  'Character Studio supports world actors. Import compendium actors or use the linked world actor first.';

/* -------------------------------------------- */

/**
 * Whether the studio will load an Actor, and what to tell the user when it won't. `checks` sets the order, so it
 * decides which refusal an Actor failing both checks gets.
 * @param {object} params
 * @param {string} params.type                    The Actor's type.
 * @param {boolean} params.inWorld                Whether the world's Actor collection holds it.
 * @param {Set<string>} params.allowedTypes       The types whose art the studio can address by class, entry and type.
 * @param {string[]} [params.checks]              Which checks to make, in order: 'world' and 'type'.
 * @returns {{ok: boolean, message: string}}
 */
export function resolveActorLoad({ type, inWorld, allowedTypes, checks = ['world', 'type'] }) {
  for (const check of checks) {
    if (check === 'world' && !inWorld) {
      return { ok: false, message: NOT_IN_WORLD_MESSAGE };
    }
    if (check === 'type' && !allowedTypes.has(type)) {
      return { ok: false, message: `${type} actors cannot use the Emblem Character Studio.` };
    }
  }
  return { ok: true, message: '' };
}
