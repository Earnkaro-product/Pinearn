// The product-category vocabulary, shared by the three places that need to
// agree about what a thing IS.
//
//   - the detector (vision-detect.server.ts) classifies each object it finds in
//     a pin, from the short label its model emits ("handbag", "sneakers"),
//   - the match pipeline (pinterest.functions.ts) classifies each product Lens
//     returns, from the retailer's title, and
//   - the category gate compares the two.
//
// They only work as a gate — "is this product actually the thing this tab is
// named after?" — if every side speaks the same closed vocabulary, which is why
// this lives in one module instead of being written three times. A drifted copy
// would fail silently: every mismatch simply reads as "no opinion" and the gate
// stops gating. This module owns the enum; vision-detect.server.ts re-exports
// it so existing importers keep working.
//
// This file is deliberately KEYWORD-HEAVY. Vocabulary is the throttle on how
// many shoppable products actually reach a tab: a title whose head noun isn't
// listed here reads as "other", and an "other" from the whole-image pool is
// dropped outright (see searchComponent). Every word added is a product that
// stops being invisible, and the look gate downstream is what pays for the
// looser reading — so when in doubt, list the word.

/** The closed set. `other` means "nothing recognisable", never "miscellaneous
 * product" — it is the value that switches the gate OFF for an item, so it must
 * stay the honest unknown.
 *
 * The list is also handed to the detector verbatim as the enum it must pick
 * from, so a category added here is a category the model starts reporting.
 * Anything NOT on this list is a shoppable thing the pipeline can only ever see
 * as "other": that is why the non-apparel half (kitchen, fitness, toys,
 * stationery, pet) exists at all — those pins were being detected and then
 * silently gated out. */
export const PRODUCT_CATEGORIES = [
  "top",
  "outerwear",
  "dress",
  "bottom",
  "innerwear",
  "footwear",
  "bag",
  "accessory",
  "watch",
  "jewellery",
  "eyewear",
  "headwear",
  "beauty",
  "electronics",
  "furniture",
  "decor",
  "kitchen",
  "fitness",
  "toys",
  "stationery",
  "pet",
  "other",
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(PRODUCT_CATEGORIES);

/** Coerce an arbitrary string to a category, or "other". Used where something
 * upstream claims to have already categorised an item — including detections
 * cached under an older, shorter enum, whose now-unknown values degrade to
 * "other" rather than breaking the row. */
export function toCategory(raw: unknown): ProductCategory {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return CATEGORY_SET.has(s) ? (s as ProductCategory) : "other";
}

// Plural-only where the singular is a trap — `shorts`, never `short`, which
// would swallow every "Short Sleeves Shirt" on Myntra. Same reasoning behind
// `denims`, `flats`, `slips`, `creams`, `shades`.
//
// Multi-word forms are spelled out wherever a bare noun would over-claim:
// `pet collars` (never `collars`, which is on every shirt), `paint brushes`
// (never `brushes`, which is makeup), `ring lights` (never bare, which is
// jewellery), `drinking glasses` (bare `glasses` is eyewear).
//
// Order breaks ties only (see `categoryOfTitle`), so it matters far less than
// it looks, but it still puts the more specific reading first: "Blazer" is
// outerwear before it is the `top` it is worn over.
const TITLE_CATEGORY_RULES: Array<[ProductCategory, RegExp]> = [
  [
    "footwear",
    /\b(shoes?|sneakers?|trainers?|sandals?|chappals?|slippers?|flip[- ]?flops?|heels?|stilettos?|pumps?|loafers?|boots?|booties?|juttis?|mojaris?|kolhapuris?|espadrilles?|sliders?|floaters?|wedges?|oxfords?|brogues?|derbys?|moccasins?|ballerinas?|ballet flats|flats\b|mules?|clogs?|crocs?|gladiators?|peep[- ]?toes?|platform heels?|boat shoes?|court shoes?|chelsea boots?|combat boots?|ankle boots?|running shoes?|sports shoes?|walking shoes?|footwear)\b/,
  ],
  [
    "bag",
    /\b(bags?|handbags?|totes?|backpacks?|rucksacks?|clutch(?:es)?|purses?|slings?|satchels?|duffels?|duffle bags?|wallets?|pouch(?:es)?|haversacks?|suitcases?|luggage|trolley bags?|cabin bags?|briefcases?|messenger bags?|crossbody|shoulder bags?|bucket bags?|hobo bags?|saddle bags?|laptop bags?|gym bags?|travel bags?|weekenders?|waist bags?|fanny packs?|belt bags?|card ?holders?|coin purses?|potlis?|batuas?|vanity cases?|makeup pouch(?:es)?)\b/,
  ],
  [
    "watch",
    /\b(watch(?:es)?|smartwatch(?:es)?|chronographs?|timepieces?|wrist ?watch(?:es)?|fitness bands?|smart bands?|fitness trackers?|watch straps?)\b/,
  ],
  [
    "eyewear",
    // Bare `glasses` is eyewear EXCEPT when it is drinkware — "Wine Glasses"
    // read as spectacles until this lookbehind existed.
    /\b(sunglass(?:es)?|eyeglass(?:es)?|(?<!(?:wine|drinking|water|shot|cocktail|beer|juice|whisky|highball|martini) )glasses|spectacles?|goggles|sun ?shades?|eyewear|optical frames?|aviators?|wayfarers?|clubmasters?|reading glasses|blue ?light glasses|contact lenses)\b/,
  ],
  [
    "jewellery",
    // `rings` minus "ring light" (electronics) — the two tie at position 0 and
    // ties go to whichever rule is listed first, so the exclusion is explicit.
    /\b(earrings?|necklaces?|pendants?|pendant sets?|bracelets?|bangles?|kadas?|rings?(?![- ]?lights?)|anklets?|payals?|jhumkas?|jewell?ery|chokers?|studs?|hoops?|danglers?|ear cuffs?|mangalsutras?|brooch(?:es)?|cufflinks?|nose ?pins?|naths?|maang ?tikkas?|lockets?|charms?|chains?|armlets?|waist chains?|tiaras?|toe rings?|jewel(?:lery)? sets?)\b/,
  ],
  [
    "headwear",
    /\b(caps?|hats?|beanies?|headbands?|turbans?|berets?|fedoras?|bucket hats?|visors?|skull ?caps?|helmets?|hijabs?|head ?scarves|head ?scarf)\b/,
  ],
  [
    "outerwear",
    /\b(blazers?|jackets?|shackets?|coats?|overcoats?|peacoats?|raincoats?|trench(?:es)?|trench coats?|shrugs?|cardigans?|waistcoats?|gilets?|parkas?|windcheaters?|windbreakers?|bombers?|puffers?|anoraks?|ponchos?|capes?|boleros?|kimonos?|dusters?|sherwanis?|nehru jackets?|varsity jackets?|denim jackets?|fleece jackets?|quilted jackets?|sweat ?jackets?)\b/,
  ],
  [
    "dress",
    // "Night Dress" and "Nightdress" are innerwear, and they lose the
    // last-match-wins race to a bare `dress` sitting later in the string.
    /\b((?<!night )(?<!night)dress(?:es)?|sundress(?:es)?|gowns?|frocks?|jumpsuits?|rompers?|playsuits?|lehengas?|sarees?|saris?|anarkalis?|kaftans?|abayas?|maxis?|maxi dress(?:es)?|midi dress(?:es)?|mini dress(?:es)?|bodycon|shift dress(?:es)?|wrap dress(?:es)?|shirt dress(?:es)?|sheath dress(?:es)?|salwar suits?|churidar suits?)\b/,
  ],
  [
    "bottom",
    /\b(jeans|denims|trousers?|pants?|slacks?|chinos?|joggers?|track ?pants?|sweatpants?|shorts|bermudas?|jorts|skirts?|palazzos?|leggings?|jeggings?|tights|cargos?|cargo pants?|culottes?|capris?|dhotis?|lungis?|salwars?|churidars?|patialas?|harem pants?|parachute pants?|wide[- ]?leg pants?|flared pants?|dungarees|overalls|breeches|jodhpurs|bottom ?wear)\b/,
  ],
  [
    "top",
    /\b(shirts?|t[- ]?shirts?|tees?|tops?|crop tops?|tank tops?|blouses?|blousons?|kurtas?|kurtis?|cholis?|tunics?|camisoles?|hoodies?|sweatshirts?|sweaters?|pullovers?|jumpers?|knitwear|jerseys?|bodysuits?|polos?|polo shirts?|henleys?|turtlenecks?|peplum tops?|flannel shirts?|oxford shirts?|graphic tees?|muscle tees?|raglans?|top ?wear)\b/,
  ],
  [
    "innerwear",
    /\b(bras?|sports bras?|bralettes?|lingerie|panties|briefs|boxers?|trunks|innerwear|shapewear|corsets?|bustiers?|nightwear|night ?dress(?:es)?|nighty|nighties|night ?suits?|pyjamas?|pajamas?|sleepwear|loungewear|robes?|bathrobes?|swimwear|swimsuits?|bikinis?|monokinis?|thermals?|slips\b|petticoats?|camis\b|vests?\b(?! bag))\b/,
  ],
  [
    "accessory",
    /\b(belts?|scarves|scarf|stoles?|shawls?|dupattas?|mufflers?|socks?|stockings?|ties?\b|bow ?ties?|gloves?|mittens?|scrunchies?|hair ?bands?|hair ?clips?|hair ?ties?|hair accessor\w*|bandanas?|handkerchiefs?|pocket squares?|suspenders?|keychains?|key ?rings?|lanyards?|umbrellas?|sarongs?|arm ?warmers?|leg ?warmers?|face masks?)\b/,
  ],
  [
    "beauty",
    /\b(lipsticks?|lip ?balms?|lip ?gloss(?:es)?|lip ?liners?|serums?|foundations?|concealers?|primers?|mascaras?|kajals?|kohl|eyeliners?|eye ?shadows?|brow pencils?|highlighters?(?![- ]?pens?)|bronzers?|blush(?:es)?|compacts?|face powders?|palettes?|setting sprays?|nail ?polish(?:es)?|nail ?paints?|perfumes?|fragrances?|attars?|body mists?|deodorants?|talc|moisturis\w*|moisturiz\w*|face wash(?:es)?|cleansers?|toners?|face packs?|sheet masks?|scrubs?|exfoliators?|face creams?|body creams?|night creams?|[bc]{2} creams?|creams\b|body lotions?|body wash(?:es)?|shampoos?|conditioners?|hair oils?|hair masks?|hair colou?rs?|hair ?serums?|sunscreens?|soaps?|makeup|make[- ]?up|cosmetics?|skincare|beauty kits?|mehendi|henna|sindoor|razors?|trimmers?|hair ?dryers?|straighteners?|curling irons?)\b/,
  ],
  [
    // Phone cases are spelled a dozen ways and are their own product; the
    // multi-word forms are listed out rather than a bare `case|cover`, which
    // would claim every cushion cover and suitcase on the page. `consoles`
    // excludes the console TABLE, which is furniture.
    "electronics",
    /\b(phones?|smartphones?|iphones?|laptops?|macbooks?|tablets?|ipads?|cameras?|dslrs?|gopros?|drones?|headphones?|earbuds?|earphones?|airpods?|neckbands?|speakers?|soundbars?|home theatres?|chargers?|power ?banks?|(?<!rate )monitors?|keyboards?|gaming mouse|wireless mouse|mouse ?pads?|consoles?(?![- ]?table)|controllers?|televisions?|smart tvs?|projectors?|printers?|routers?|webcams?|microphones?|tripods?|gimbals?|ring[- ]?lights?|hard ?drives?|pen ?drives?|memory cards?|ssds?|adapters?|cables?|vr headsets?|e[- ]?readers?|kindles?|air purifiers?|vacuum cleaners?|steam irons?|electronics?|gadgets?|(?:phone|mobile|back)[- ](?:case|cover)s?)\b/,
  ],
  [
    "furniture",
    /\b(sofas?|sectionals?|couch(?:es)?|armchairs?|chairs?|office chairs?|tables?|console tables?|coffee tables?|study tables?|dining sets?|desks?|(?<!(?:pet|dog|cat) )beds?|bunk beds?|daybeds?|mattress(?:es)?|headboards?|wardrobes?|almirahs?|shelves|shelf|wall shelves|bookcases?|book ?shel(?:f|ves)|cabinets?|sideboards?|dressers?|chest of drawers|nightstands?|bedside tables?|stools?|bar stools?|benches|ottomans?|poufs?|recliners?|futons?|shoe racks?|racks?|tv units?|cribs?|cots?|hammocks?|swings?|furniture)\b/,
  ],
  [
    "decor",
    /\b(cushions?|cushion covers?|pillows?|pillow covers?|curtains?|blinds?|lamps?|lamp ?shades?|lanterns?|fairy lights?|string lights?|vases?|rugs?|carpets?|doormats?|bedsheets?|bed ?covers?|duvets?|comforters?|quilts?|blankets?|throws?|bedding|planters?|artificial plants?|faux plants?|clocks?|wall clocks?|mirrors?|candles?|candle ?holders?|diyas?|torans?|incense|wall art|wall hangings?|wall stickers?|wallpapers?|tapestr(?:y|ies)|macrame|paintings?|posters?|photo frames?|picture frames?|showpieces?|figurines?|sculptures?|dream ?catchers?|wind ?chimes?|table runners?|table ?cloths?|coasters?|baskets?|storage boxes?|d[eé]cor)\b/,
  ],
  [
    "kitchen",
    /\b(cookware|kadais?|pans?|frying pans?|sauce ?pans?|pressure cookers?|cookers?|tawas?|casseroles?|dinnerware|dinner sets?|crockery|serveware|plates?|bowls?|mugs?|cups?|drinking glasses|wine glasses|tumblers?|water bottles?|flasks?|thermos|lunch ?boxes?|tiffins?|containers?|jars?|cutlery|spoons?|forks?|knives|knife|chopping boards?|kettles?|toasters?|air ?fryers?|microwaves?|ovens?|blenders?|mixer grinders?|juicers?|coffee makers?|espresso machines?|induction cook ?tops?|refrigerators?|dish racks?|aprons?|oven mitts?|bakeware|cake moulds?|teapots?|utensils?|peelers?|graters?|strainers?|whisks?|spice racks?|kitchenware)\b/,
  ],
  [
    "fitness",
    /\b(yoga mats?|exercise mats?|dumbbells?|kettlebells?|barbells?|weight plates?|ankle weights?|resistance bands?|treadmills?|exercise bikes?|spin bikes?|skipping ropes?|jump ropes?|foam rollers?|ab rollers?|pull[- ]?up bars?|gym gloves?|protein powders?|whey|shakers?|cricket bats?|footballs?|basketballs?|badminton rackets?|tennis rackets?|shuttlecocks?|bicycles?|cycles?|sports ?wear|active ?wear|gym ?wear)\b/,
  ],
  [
    "toys",
    /\b(toys?|soft toys?|plush toys?|stuffed animals?|teddy bears?|dolls?|action figures?|board games?|card games?|puzzles?|jigsaws?|building blocks?|lego|rattles?|ride[- ]?ons?|remote control cars?|play ?sets?|activity kits?)\b/,
  ],
  [
    "stationery",
    /\b(notebooks?|note ?pads?|journals?|bullet journals?|diaries|planners?|pens?|pencils?|colour pencils?|crayons?|markers?|highlighter pens?|sticky notes?|sticker sheets?|washi tapes?|sketchbooks?|sketch ?pads?|art supplies|paint brush(?:es)?|acrylic paints?|water ?colou?rs?|calligraphy|desk organis\w*|desk organiz\w*|folders?|staplers?|erasers?|sharpeners?|geometry boxes?|bookmarks?|greeting cards?|gift wraps?|calendars?|books?|novels?|cook ?books?|stationery)\b/,
  ],
  [
    "pet",
    /\b(pet beds?|dog beds?|cat beds?|pet collars?|dog collars?|cat collars?|leash(?:es)?|pet harness(?:es)?|pet bowls?|dog bowls?|litter boxes?|scratching posts?|pet toys?|dog toys?|cat toys?|kennels?|aquariums?|fish tanks?|bird cages?|pet food|dog food|cat food|pet grooming)\b/,
  ],
];

/** The category a retailer's product title reads as, or "other" when nothing in
 * it is recognisable.
 *
 * When a title names more than one category, the LAST one wins. Product titles
 * are head-final — the thing being sold is the noun at the end, and everything
 * before it is brand, pattern and fit ("Buy ALDO Women Textured Sneakers -
 * Casual Shoes for Women"). First-match-wins read `"7 rings" iPhone Case` as a
 * ring and threw a perfectly good phone case out of the phone-case tab.
 *
 * Equal positions go to the rule listed FIRST, which is why a handful of rules
 * carry explicit exclusions ("ring light", "console table") instead of relying
 * on ordering. */
export function categoryOfTitle(title: string): ProductCategory {
  const t = title.toLowerCase();
  let best: ProductCategory = "other";
  let bestAt = -1;
  for (const [category, re] of TITLE_CATEGORY_RULES) {
    const at = t.search(re);
    if (at > bestAt) {
      best = category;
      bestAt = at;
    }
  }
  return best;
}

// Pairs the detector itself blurs, so treating them as a conflict would throw
// away correct matches: a watch is routinely classified as jewellery, a
// one-piece is called a dress by one model pass and a top by the next, and an
// open shirt, shacket or cardigan sits on the top/outerwear line for the
// detector AND for retailer titles ("Denim Shirt Jacket"). The look gate
// catches the cases where the blur let a genuinely different garment through.
//
// The wider vocabulary needs MORE of these, not fewer: a camisole is both a
// top and innerwear, a mug is both kitchen and decor, running shoes are both
// footwear and fitness. Every pair here is a real ambiguity in retailer
// titles, never a shortcut — an unjustified pair would let a genuinely wrong
// product sit under a tab.
const COMPATIBLE_CATEGORIES: ReadonlyArray<readonly [ProductCategory, ProductCategory]> = [
  ["watch", "jewellery"],
  ["watch", "accessory"],
  ["watch", "fitness"],
  ["dress", "top"],
  ["outerwear", "top"],
  ["innerwear", "top"],
  ["innerwear", "bottom"],
  ["innerwear", "dress"],
  ["accessory", "bag"],
  ["accessory", "jewellery"],
  ["accessory", "headwear"],
  ["bag", "fitness"],
  ["footwear", "fitness"],
  ["top", "fitness"],
  ["bottom", "fitness"],
  ["kitchen", "decor"],
  ["kitchen", "electronics"],
  ["furniture", "decor"],
  ["stationery", "decor"],
  ["toys", "decor"],
  ["pet", "toys"],
];

export function categoriesAgree(tag: ProductCategory, match: ProductCategory): boolean {
  if (tag === "other" || match === "other") return true; // nothing to disagree with
  if (tag === match) return true;
  return COMPATIBLE_CATEGORIES.some(
    ([a, b]) => (tag === a && match === b) || (tag === b && match === a),
  );
}
