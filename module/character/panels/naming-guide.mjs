/*
 * Naming help for the import panel's name prompts. A "?" button in the prompt's header whispers the naming rules to
 * the user's own chat log. The card is built from the routing tables in parts/asset-routing.mjs, so it always
 * matches what the router does with a name.
 */

import { describeRouting, routeAssetNameForSide } from '../parts/asset-routing.mjs';
import { categoryLabel, TOKEN_RAIL_CATEGORIES, AVATAR_RAIL_CATEGORIES } from '../parts/part-categories.mjs';
import { whisperToCurrentUser } from '../../foundry/documents.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/**
 * Example names for each side. The card asks the router where each one lands, so the examples always match the
 * rules.
 * @type {Object<string, string[]>}
 */
const EXAMPLE_NAMES = {
  token:  ['soldier-pole-idle', 'mercenary-sword-ddg', 'mage-magic-crit', 'thief-ddg',
    'wolf-beast-atk', 'heart-effect'],
  avatar: ['Lyn_Armour', 'Lyn_Face', 'Lyn_Hair', 'Lyn_HairBack', 'Lyn']
};

/* -------------------------------------------- */
/*  Header Button                               */
/* -------------------------------------------- */

/**
 * Add the naming-help button to a name prompt's window header, left of its other controls. The import panel's name
 * prompts call it from their render callback, which runs on every render, so a header that already has the button
 * is skipped.
 * @param {foundry.applications.api.DialogV2} dialog      The name prompt.
 * @param {string} side                                    'avatar' or 'token', so the card matches the prompt.
 */
export function addNamingHelpButton(dialog, side) {
  const header = dialog.element.querySelector('.window-header');
  if (!header || header.querySelector('[data-naming-help]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'header-control icon fa-solid fa-question';
  button.dataset.namingHelp = '';
  button.dataset.tooltip = 'Post the naming conventions to your chat log';
  button.setAttribute('aria-label', 'Naming conventions');
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    postNamingGuide(side);
  });
  header.insertBefore(button, header.querySelector('.header-control'));
}

/* -------------------------------------------- */
/*  Chat Card                                   */
/* -------------------------------------------- */

/**
 * Whisper one side's naming guide to the current user only, since nobody else at the table needs it. A failure is
 * reported, not thrown, because this runs from a click handler and nothing above it would catch the error.
 */
async function postNamingGuide(side) {
  try {
    await whisperToCurrentUser(namingGuideHtml(side));
    notify.info('Naming conventions sent to your chat log.');
  } catch (error) {
    notify.failure('The naming guide could not be posted to chat.', error);
  }
}

/**
 * The guide card's markup for one side. Trays are listed in the Parts Library's rail order, and the fallback tray's
 * line also names the case that falls back to it.
 */
function namingGuideHtml(side) {
  const avatar = side === 'avatar';
  const rules = describeRouting(side);
  const esc = foundry.utils.escapeHTML;
  const wordsByTray = new Map(rules.trays.map(t => [t.category, t.words]));
  const fallback = avatar ? 'no slot word' : 'any other ending';
  const trays = (avatar ? AVATAR_RAIL_CATEGORIES : TOKEN_RAIL_CATEGORIES)
    .filter(c => wordsByTray.has(c) || c === rules.fallbackTray)
    .map(c => {
      const parts = [codeList(wordsByTray.get(c) ?? []), c === rules.fallbackTray ? fallback : ''].filter(Boolean);
      return `<li><strong>${esc(categoryLabel(c))}</strong>: ${parts.join(', or ')}</li>`;
    }).join('');
  const examples = EXAMPLE_NAMES[avatar ? 'avatar' : 'token'].map(name => {
    const { category, subTab } = routeAssetNameForSide(side, name);
    const where = rules.subTabCategories.includes(category)
      ? `${categoryLabel(category)} › ${subTab ?? 'Default'}`
      : categoryLabel(category);
    return `<li><code>${esc(name)}</code> → ${esc(where)}</li>`;
  }).join('');
  const shared = `
    <p>Characters other than letters, digits, <code>_</code> and <code>-</code> become <code>_</code>.
      A blank name saves as <code>custom_assetN</code>, and a name already in use asks whether to overwrite it,
      append a number, or rename it.</p>
    <h4>Examples</h4>
    <ul>${examples}</ul>`;
  return avatar ? avatarGuideHtml(trays, shared) : tokenGuideHtml(rules, trays, shared);
}

/**
 * The token side's card: tray by ending, then sub-tab by keyword.
 * @param {object} rules                  The side's rules from describeRouting.
 * @param {string} trays                  Tray list items.
 * @param {string} shared                 Markup common to both sides.
 * @returns {string}
 */
function tokenGuideHtml(rules, trays, shared) {
  const esc = foundry.utils.escapeHTML;
  const idle = esc(categoryLabel(rules.fallbackTray));
  const subTabs = rules.subTabs
    .map(s => `<li><strong>${esc(s.tab)}</strong>: ${codeList([...s.keywords, ...s.abbreviations])}</li>`).join('');
  const shortForms = rules.subTabs.flatMap(s => s.abbreviations);
  const subTabTrays = rules.subTabCategories.map(c => esc(categoryLabel(c))).join(', ');
  const creature = rules.subTabs.find(s => s.tab === 'Creature');
  return `
    <div class="emblem-studio-naming-guide">
      <h3>Sprite naming conventions</h3>
      <p>With <strong>Save to library</strong> on, a sprite's name decides where it is filed.
        Name sprites <code>unit-variant-weapon-pose</code>, e.g. <code>soldier-pole-idle</code>.</p>
      <h4>1. Tray: the ending</h4>
      <ul>${trays}</ul>
      <p>Trailing numbers are ignored. With no tray word at the end, the last tray word anywhere in the name
        decides, and the word <code>idle</code> always means ${idle}.</p>
      <h4>2. Sub-tab: a keyword (${subTabTrays})</h4>
      <p>The first rule that matches wins, in this order:</p>
      <ul>${subTabs}</ul>
      <p>A keyword matches the start of a word, so <code>beastmaster</code> counts as <code>beast</code> but
        <code>elbow</code> is not a <code>bow</code>.
        ${shortForms.length ? `The short forms ${codePhrase(shortForms, 'and')} must be a whole word.` : ''}
        With no keyword, the sprite files under Default.
        ${creature ? `Species names are not keywords, so a wolf needs one of ${codePhrase(creature.keywords, 'or')}
        in its name to file as a Creature.` : ''}</p>
      ${shared}
    </div>`;
}

/**
 * The avatar side's card: tray by slot word, with no sub-tabs.
 * @param {string} trays                  Tray list items.
 * @param {string} shared                 Markup common to both sides.
 * @returns {string}
 */
function avatarGuideHtml(trays, shared) {
  return `
    <div class="emblem-studio-naming-guide">
      <h3>Avatar part naming conventions</h3>
      <p>With <strong>Save to library</strong> on, a part's name decides its tray. Name parts
        <code>Name_Slot</code> the way the shipped pack does, e.g. <code>Lyn_Hair</code>. Underscores, hyphens,
        spaces and capital letters all separate words, so <code>Lyn_HairBack</code>, <code>lyn-hair-back</code> and
        <code>LynHairBack</code> file the same way.</p>
      <h4>Tray: the slot word</h4>
      <ul>${trays}</ul>
      <p>The slot word at the end decides, or the last slot word anywhere in the name when none is at the end.
        Trailing numbers are ignored, and avatar trays have no sub-tabs.</p>
      ${shared}
    </div>`;
}

/* -------------------------------------------- */
/*  Formatting                                  */
/* -------------------------------------------- */

/** Words as a comma-separated list of code spans, for rule listings. */
function codeList(words) {
  return words.map(w => `<code>${foundry.utils.escapeHTML(w)}</code>`).join(', ');
}

/** Words as code spans joined into a phrase such as "a, b or c", with `conjunction` ('and' or 'or') before the last. */
function codePhrase(words, conjunction) {
  if (words.length < 2) return codeList(words);
  return `${codeList(words.slice(0, -1))} ${conjunction} ${codeList(words.slice(-1))}`;
}
