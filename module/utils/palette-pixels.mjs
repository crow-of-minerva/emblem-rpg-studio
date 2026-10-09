/*
 * The palette codes in FECC (Fire Emblem Character Creator) sprites, which store the palette shade each pixel takes
 * in its red channel. This file maps red codes to shades per layer type, says which shades each layer type uses, builds
 * shade ramps and the default palette, and recolours pixel data. It has no DOM access, so Character Studio's model can
 * use it.
 *
 * Exact codes: each shade is identified by the exact red byte of the pixel, with green and blue zero, and the
 * recolour lookup is indexed by that byte, not by red / 10. Every palette except Skin is a five-stop ramp: lighter,
 * light_mid, neutral, dark_mid and darker. The multiples of 10 are the older three-shade codes and keep their meaning,
 * so older sprites recolour unchanged. The two in-between shades use the codes between them (hair: 10, 15, 20, 25,
 * 30). Skin keeps its five downward shades.
 *
 * Coarse slots: shipped grayscale assets carry a slot instead, slot = floor(red / 10), with non-zero green and blue:
 *
 *   0      Outline
 *   1-3    Hair (lighter, neutral, darker), or Eye on face and accessory layers
 *   4-8    Skin (lighter, neutral, darker, darker_darker, darker_darker_darker)
 *   9-11   Metal (lighter, neutral, darker), or Accessory on face and accessory layers
 *   12-14  Trim (lighter, neutral, darker)
 *   15-17  Cloth (lighter, neutral, darker)
 *   18-20  Leather (lighter, neutral, darker)
 *   21-22  Wild Card 1 (lighter, darker), never decoded
 *   23-24  Wild Card 2 (lighter, darker), never decoded
 *   25     Red 250, a static highlight, left as it is
 *
 * The wild-card palettes stand in for Palette 2 (eye) and Palette 8 (accessory) on body and token layers, where
 * slots 1-3 and 9-11 are taken. They recolour only through their exact codes, 210 to 240 with green and blue zero,
 * because the coarse path skips every red from 210 up. Older sprites that used red 210 and above as static
 * highlights kept non-zero green and blue at import, which keeps them static.
 */
import { hexToRgb as parseHex } from './colour.mjs';

/* -------------------------------------------- */
/*  Palettes                                    */
/* -------------------------------------------- */

/**
 * The palettes that get a shade row, in display order.
 *
 * The outline is a separate single-row entry rendered after these, since it has one colour rather than a ramp.
 * @type {object[]}
 */
export const SLOTS = [
  { key: 'hair',      label: 'Hair'      },
  { key: 'eye',       label: 'Eye'       },
  { key: 'skin',      label: 'Skin'      },
  { key: 'metal',     label: 'Metal'     },
  { key: 'trim',      label: 'Trim'      },
  { key: 'cloth',     label: 'Cloth'     },
  { key: 'leather',   label: 'Leather'   },
  { key: 'accessory', label: 'Accessory' }
];

/* -------------------------------------------- */

/**
 * Skin's ramp, which runs from light to progressively darker instead of evenly around a mid tone. It's kept as it
 * was, so existing sprites recolour unchanged.
 */
const SKIN_SHADES    = ['lighter', 'neutral', 'darker', 'darker_darker', 'darker_darker_darker'];
/* -------------------------------------------- */

/**
 * Every other palette's ramp: five stops, symmetric about the neutral. The first, third and fifth stops are the
 * older three shades, so an old sprite lands on the new ramp without moving.
 */
const NONSKIN_SHADES = ['lighter', 'light_mid', 'neutral', 'dark_mid', 'darker'];

/* -------------------------------------------- */

/**
 * The shade ramp a palette uses.
 * @param {string} slotKey        Palette key.
 * @returns {string[]}
 */
export function shadesFor(slotKey) {
  return slotKey === 'skin' ? SKIN_SHADES : NONSKIN_SHADES;
}

/* -------------------------------------------- */
/*  Derived Shades                              */
/* -------------------------------------------- */

/** The colour halfway between two. */
function midRgb(a, b) {
  return { r: Math.round((a.r + b.r) / 2), g: Math.round((a.g + b.g) / 2), b: Math.round((a.b + b.b) / 2) };
}

/* -------------------------------------------- */

/**
 * The two in-between stops, computed rather than authored.
 *
 * Deriving them means an artist sets three colours and gets five, so the extra stops cannot drift out of step with
 * the ramp they sit in. A ramp missing its edge colour falls back to the neutral rather than to nothing.
 * @param {object} block          The palette's colours.
 * @param {string} shade          Which stop.
 * @returns {object|null}
 */
export function derivedMidShade(block, shade) {
  if (shade !== 'light_mid' && shade !== 'dark_mid') return null;
  const n = block?.neutral ?? block?.base ?? null;
  if (!n) return null;
  const edge = shade === 'light_mid' ? block.lighter : block.darker;
  return edge ? midRgb(edge, n) : { ...n };
}

/* -------------------------------------------- */
/*  Shade Ramps and the Default Palette         */
/* -------------------------------------------- */

/**
 * Move a colour toward white by a fraction of the distance. A fraction rather than a fixed amount keeps a ramp's
 * character at any brightness: a dark base lightens noticeably while a near-white one barely moves.
 * @param {object} rgb            Colour.
 * @param {number} [k]            How far toward white, from 0 to 1.
 * @returns {object}
 */
function brighter({ r, g, b }, k = 0.18) {
  return {
    r: Math.min(255, Math.round(r + (255 - r) * k)),
    g: Math.min(255, Math.round(g + (255 - g) * k)),
    b: Math.min(255, Math.round(b + (255 - b) * k))
  };
}

/**
 * Move a colour toward black by a fraction of its own value.
 * @param {object} rgb            Colour.
 * @param {number} [k]            How far toward black, from 0 to 1.
 * @returns {object}
 */
function darker({ r, g, b }, k = 0.18) {
  return {
    r: Math.max(0, Math.round(r * (1 - k))),
    g: Math.max(0, Math.round(g * (1 - k))),
    b: Math.max(0, Math.round(b * (1 - k)))
  };
}

/** Parse a six-digit hex colour, or black when the text is not one. */
export function hexToRgbOrBlack(hex) {
  return parseHex(hex) ?? { r: 0, g: 0, b: 0 };
}

/**
 * Build a palette block from one base colour. It has every shade key either ramp uses (the five-stop ramp and skin's
 * extra darker stops), so one block works for any palette. It also keeps `base`, which the derived-shade fallbacks
 * read when a block has no neutral.
 * @param {string} baseHex        Base colour.
 * @returns {object}
 */
export function shadeBlock(baseHex) {
  const base = hexToRgbOrBlack(baseHex);
  return {
    base,
    lighter:              brighter(base, 0.18),
    light_mid:            brighter(base, 0.09),
    neutral:              { ...base },
    dark_mid:             darker(base, 0.09),
    darker:               darker(base, 0.18),
    darker_darker:        darker(base, 0.34),
    darker_darker_darker: darker(base, 0.48)
  };
}

/**
 * The starting palette: each new tab's per-side palettes (createTab in character/model/tab-model.mjs), and the base
 * of an imported asset's palette when no other is given (paletteFromColourMap).
 * @returns {object}
 */
export function defaultPalette() {
  return {
    outline:   '#382040',
    hair:      shadeBlock('#e0d840'),
    eye:       shadeBlock('#403219'),
    skin:      shadeBlock('#f8f8c0'),
    metal:     shadeBlock('#646464'),
    trim:      shadeBlock('#f7ad52'),
    cloth:     shadeBlock('#525273'),
    leather:   shadeBlock('#946442'),
    accessory: shadeBlock('#000000')
  };
}

/* -------------------------------------------- */
/*  Code Tables                                 */
/* -------------------------------------------- */

/** Layer types that read the face code table instead of the body one. */
const FACE_LIKE_TYPES = new Set(['face', 'accessory']);

/* -------------------------------------------- */

/**
 * Bottom of the wild-card red range. Older sprites also used this range for static highlights, so a pixel here
 * recolours only when its green and blue are both zero. decodeShadeKey applies that check.
 */
const WILDCARD_MIN = 210;
/* -------------------------------------------- */

/**
 * Red byte to palette shade, for body, token, armour and hair layers: the full eight-palette layout.
 * @type {Object<number, string>}
 */
const CODE_TO_SHADE_OTHER = {
  0: 'outline',
  // Hair (Palette 1)
  10: 'hair.lighter', 15: 'hair.light_mid', 20: 'hair.neutral', 25: 'hair.dark_mid', 30: 'hair.darker',
  // Skin (Palette 3): unchanged 5 shades
  40: 'skin.lighter', 50: 'skin.neutral', 60: 'skin.darker', 70: 'skin.darker_darker', 80: 'skin.darker_darker_darker',
  // Metal (Palette 4)
  90: 'metal.lighter', 95: 'metal.light_mid', 100: 'metal.neutral', 105: 'metal.dark_mid', 110: 'metal.darker',
  // Trim (Palette 5)
  120: 'trim.lighter', 125: 'trim.light_mid', 130: 'trim.neutral', 135: 'trim.dark_mid', 140: 'trim.darker',
  // Cloth (Palette 6)
  150: 'cloth.lighter', 155: 'cloth.light_mid', 160: 'cloth.neutral', 165: 'cloth.dark_mid', 170: 'cloth.darker',
  // Leather (Palette 7)
  180: 'leather.lighter', 185: 'leather.light_mid', 190: 'leather.neutral', 195: 'leather.dark_mid',
  200: 'leather.darker',
  // Eye, Wild Card 1 (Palette 2): 210 and 220 keep their older meaning, lighter and darker
  210: 'eye.lighter', 213: 'eye.light_mid', 215: 'eye.neutral', 217: 'eye.dark_mid', 220: 'eye.darker',
  // Accessory, Wild Card 2 (Palette 8): 230 and 240 keep their older meaning, lighter and darker
  230: 'accessory.lighter', 233: 'accessory.light_mid', 235: 'accessory.neutral', 237: 'accessory.dark_mid',
  240: 'accessory.darker'
};

/* -------------------------------------------- */

/**
 * Red byte to palette shade, for face and accessory layers, where the hair codes drive the eye palette and the metal
 * codes the accessory palette. The wild-card range does nothing on these layers.
 * @type {Object<number, string>}
 */
const CODE_TO_SHADE_FACE = {
  0: 'outline',
  10: 'eye.lighter', 15: 'eye.light_mid', 20: 'eye.neutral', 25: 'eye.dark_mid', 30: 'eye.darker',
  40: 'skin.lighter', 50: 'skin.neutral', 60: 'skin.darker', 70: 'skin.darker_darker', 80: 'skin.darker_darker_darker',
  90: 'accessory.lighter', 95: 'accessory.light_mid', 100: 'accessory.neutral', 105: 'accessory.dark_mid',
  110: 'accessory.darker',
  120: 'trim.lighter', 125: 'trim.light_mid', 130: 'trim.neutral', 135: 'trim.dark_mid', 140: 'trim.darker',
  150: 'cloth.lighter', 155: 'cloth.light_mid', 160: 'cloth.neutral', 165: 'cloth.dark_mid', 170: 'cloth.darker',
  180: 'leather.lighter', 185: 'leather.light_mid', 190: 'leather.neutral', 195: 'leather.dark_mid',
  200: 'leather.darker'
};

/* -------------------------------------------- */

/**
 * The code table a layer type reads.
 * @param {string} feccType       Layer's part type.
 * @returns {Object<number, string>}
 */
export function codeTableFor(feccType) {
  return FACE_LIKE_TYPES.has(feccType) ? CODE_TO_SHADE_FACE : CODE_TO_SHADE_OTHER;
}

/* -------------------------------------------- */

/**
 * The red codes a palette's shades encode as in the body table, in `shadesFor` order.
 *
 * The importer builds its drop boxes and its automatic ramps from these (fecc-sprite-importer.mjs, fecc-import.mjs).
 * @param {string} slotKey        Palette key.
 * @returns {number[]}
 */
export function codesFor(slotKey) {
  const codes = Object.keys(CODE_TO_SHADE_OTHER).map(Number);
  return shadesFor(slotKey).map(shade => codes.find(code => CODE_TO_SHADE_OTHER[code] === `${slotKey}.${shade}`));
}

/* -------------------------------------------- */

/**
 * The code a layer type reads as the same shade a body-table code names.
 *
 * The importer's chips carry body-table codes whatever it imports, and a face or accessory layer reads the eye and
 * accessory palettes from other codes, so the encode and the layer's palette go through this. A code the layer type
 * has no matching shade for, and anything that is not a body-table code, comes back unchanged.
 * @param {number} code           Body-table code.
 * @param {string} feccType       Layer's part type.
 * @returns {number}
 */
export function codeForType(code, feccType) {
  const table = codeTableFor(feccType);
  const shade = CODE_TO_SHADE_OTHER[code];
  if (!shade || table[code] === shade) return code;
  const match = Object.keys(table).find(c => table[c] === shade);
  return match === undefined ? code : Number(match);
}

/* -------------------------------------------- */
/*  Active Shades                               */
/* -------------------------------------------- */

/**
 * Derive from the code tables, per family, which shades of each palette they reference. An empty array means the
 * palette does nothing for that layer type, and the colour panel greys out its whole row.
 * @returns {object}
 */
function buildActiveShades() {
  const fromTable = (table) => {
    const out = {};
    for (const code of Object.keys(table)) {
      const v = table[code];
      if (v === 'outline') continue;
      const dot = v.indexOf('.');
      const pal = v.slice(0, dot), shade = v.slice(dot + 1);
      (out[pal] ??= new Set()).add(shade);
    }
    const norm = {};
    for (const slot of SLOTS) {
      const set = out[slot.key];
      norm[slot.key] = set ? shadesFor(slot.key).filter(s => set.has(s)) : [];
    }
    return norm;
  };
  return { face: fromTable(CODE_TO_SHADE_FACE), other: fromTable(CODE_TO_SHADE_OTHER) };
}

/* -------------------------------------------- */

/** The derived table, computed once. */
const ACTIVE_SHADES = buildActiveShades();

/* -------------------------------------------- */

/**
 * Which shades of one palette a layer type actually uses.
 * @param {string} feccType       Layer's part type.
 * @param {string} slotKey        Palette key.
 * @returns {Set<string>}
 */
export function activeShadesFor(feccType, slotKey) {
  const family = FACE_LIKE_TYPES.has(feccType) ? 'face' : 'other';
  return new Set(ACTIVE_SHADES[family][slotKey] ?? []);
}

/* -------------------------------------------- */
/*  Decoding                                    */
/* -------------------------------------------- */

/**
 * Decode an exact red byte to a palette shade, or null where it does not recolour on this layer type.
 *
 * Code zero maps to the outline, which callers treat as its own bucket rather than as a palette.
 * @param {number} code           Red byte.
 * @param {string} feccType       Layer's part type.
 * @returns {string|null}
 */
export function slotToPaletteShade(code, feccType) {
  return codeTableFor(feccType)[code] ?? null;
}

/* -------------------------------------------- */

/**
 * Decode a coarse slot, the red byte bucketed by tens, to a palette shade, for shipped grayscale assets. Their three
 * shades land on the five-stop ramp's first, third and fifth stops.
 * @param {number} slot           Coarse slot index.
 * @param {string} feccType       Layer's part type.
 * @returns {string|null}
 */
function coarseSlotToShade(slot, feccType) {
  const faceLike = FACE_LIKE_TYPES.has(feccType);
  switch (slot) {
    case 0:  return 'outline';
    case 1:  return faceLike ? 'eye.lighter'  : 'hair.lighter';
    case 2:  return faceLike ? 'eye.neutral'  : 'hair.neutral';
    case 3:  return faceLike ? 'eye.darker'   : 'hair.darker';
    case 4:  return 'skin.lighter';
    case 5:  return 'skin.neutral';
    case 6:  return 'skin.darker';
    case 7:  return 'skin.darker_darker';
    case 8:  return 'skin.darker_darker_darker';
    case 9:  return faceLike ? 'accessory.lighter' : 'metal.lighter';
    case 10: return faceLike ? 'accessory.neutral' : 'metal.neutral';
    case 11: return faceLike ? 'accessory.darker'  : 'metal.darker';
    case 12: return 'trim.lighter';
    case 13: return 'trim.neutral';
    case 14: return 'trim.darker';
    case 15: return 'cloth.lighter';
    case 16: return 'cloth.neutral';
    case 17: return 'cloth.darker';
    case 18: return 'leather.lighter';
    case 19: return 'leather.neutral';
    case 20: return 'leather.darker';
    default: return null;
  }
}

/* -------------------------------------------- */

/**
 * Decode one pixel to the palette shade it stands for on a layer type, or null where it recolours nothing. A zero
 * green and blue with a code in red decodes exactly; anything else, including the shipped assets' stray reds, falls to
 * the coarse slot, which skips every red from WILDCARD_MIN up because older sprites used that range for highlights.
 * @param {number} r              Red byte.
 * @param {number} g              Green byte.
 * @param {number} b              Blue byte.
 * @param {string} feccType       Layer's part type.
 * @returns {string|null}         `<palette>.<shade>`, or `outline`.
 */
export function decodeShadeKey(r, g, b, feccType) {
  const exact = g === 0 && b === 0 ? slotToPaletteShade(r, feccType) : null;
  if (exact) return exact;
  if (r >= WILDCARD_MIN) return null;
  return coarseSlotToShade((r / 10) | 0, feccType);
}

/* -------------------------------------------- */
/*  Colour Lookups                              */
/* -------------------------------------------- */

/**
 * The palette colour a shade key names, or null where the palette cannot supply one.
 *
 * The outline falls back to black. Palettes saved before the five-stop expansion have no in-between shades, so those
 * take the same derived mid-tone the colour panel displays, and an old palette recolours a new sprite rather than
 * leaving two of its five stops blank.
 * @param {object} palette        The palette.
 * @param {string|null} key       `<palette>.<shade>`, `outline`, or null.
 * @returns {object|null}
 */
function shadeColour(palette, key) {
  if (!key) return null;
  if (key === 'outline') return parseHex(palette.outline) ?? { r: 0, g: 0, b: 0 };
  const dot = key.indexOf('.');
  const block = palette[key.slice(0, dot)];
  const shade = key.slice(dot + 1);
  return (block?.[shade] ?? derivedMidShade(block, shade)) || null;
}

/* -------------------------------------------- */

/**
 * Build the 256-entry lookup, indexed by red byte, of the colour each exact code takes on a layer type.
 *
 * Entries are null where the code does not recolour. The canvas view maps brush colours to and from codes with it.
 * @param {object} palette                        The palette.
 * @param {string} feccType                       Layer's part type.
 * @returns {Array<object|null>}
 */
export function buildLut(palette, feccType) {
  const lut = new Array(256).fill(null);
  const table = codeTableFor(feccType);
  for (const code of Object.keys(table)) lut[code] = shadeColour(palette, table[code]);
  return lut;
}

/* -------------------------------------------- */

/**
 * Build recolourImageData's two lookups by red byte: `zeroed` for a pixel whose green and blue are zero, `tinted` for
 * any other. An exact code the palette can't colour takes its coarse slot's colour, and the canvas view rebuilds these
 * on every frame of a brush stroke, so each shade is looked up once.
 * @param {object} palette                        The palette.
 * @param {string} feccType                       Layer's part type.
 * @returns {{zeroed: Array<object|null>, tinted: Array<object|null>}}
 */
function buildPixelLuts(palette, feccType) {
  const colours = new Map();
  const colourOf = key => {
    if (!colours.has(key)) colours.set(key, shadeColour(palette, key));
    return colours.get(key);
  };
  const zeroed = [];
  const tinted = [];
  for (let r = 0; r < 256; r++) {
    tinted.push(colourOf(decodeShadeKey(r, 1, 1, feccType)));
    zeroed.push(colourOf(decodeShadeKey(r, 0, 0, feccType)) ?? tinted[r]);
  }
  return { zeroed, tinted };
}

/* -------------------------------------------- */
/*  Recolouring                                 */
/* -------------------------------------------- */

/**
 * Rewrite every opaque pixel of decoded image data against the palette, in place, decoding as decodeShadeKey does and
 * leaving a pixel with no colour to take as it is. Every palette recolour in Studio goes through it.
 * @param {Uint8ClampedArray} data        Pixel data, mutated in place.
 * @param {object} palette                The palette.
 * @param {string} feccType               Layer's part type.
 */
export function recolourImageData(data, palette, feccType) {
  const { zeroed, tinted } = buildPixelLuts(palette, feccType);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i];
    const c = data[i + 1] === 0 && data[i + 2] === 0 ? zeroed[r] : tinted[r];
    if (!c) continue;
    data[i]     = c.r;
    data[i + 1] = c.g;
    data[i + 2] = c.b;
  }
}

