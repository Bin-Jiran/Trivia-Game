---
name: new-tile
description: >
  Procedure for adding a new category tile to the category-selection grid
  in public/index.html — preparing the banner image, byte-exact Arabic
  insertion, codepoint/DB verification, and keeping the tracked grid tile
  count in sync. Use when adding a new selectable trivia category to the
  game's UI.
---

# Adding a category tile

## 1. Get the exact category string first

Get the category's exact Arabic name from an authoritative source — the
Excel master's category column (extracted with a read, not retyped) is
preferred if the category already has content planned. Never type the
Arabic name from memory: Arabic text is easy to get byte-wrong even when it
looks identical on screen.

## 2. Prepare the banner image

Every tile is a banner image, not an emoji + label. Prepare:

- **Source artwork**: 980×1490 portrait, with the category title baked into
  the image itself (no separate text label is rendered over it).
- **Export**: compress to WebP, ~640px wide, quality ~88, landing around
  150KB. Keep it a portrait image at the same 980:1490 proportions as the
  source — the tile markup (step 3) depends on that exact ratio to avoid
  cropping.
- **Filename**: an ASCII slug, never the Arabic category name (e.g.
  `animals.webp`, `crests.webp`). This is load-bearing: a category rename
  later changes only the Arabic string used elsewhere, never this filename
  — so pick a slug that describes the category concept, not its current
  Arabic wording.
- **Save to** `public/categories/`.

## 3. Match the existing tile format exactly

Every tile in the grid follows this pattern:

```html
<div class="cat-card" onclick="toggleCat(this,'NAME')" data-cat="NAME"><img src="/categories/SLUG.webp" alt="NAME" loading="lazy"><div class="cat-badge"></div></div>
```

All three occurrences of `NAME` (the `toggleCat` argument, `data-cat`, and
`alt`) must be the identical extracted string from step 1 — copy it, don't
retype it a second time. `SLUG` is the filename chosen in step 2, without
the `.webp` extension.

The card's image rendering relies on `object-fit: contain` paired with
`aspect-ratio: 980 / 1490` on the `img` — never `object-fit: cover`, which
crops the image to fill the box and cuts off the baked-in border. Don't
override these per-tile; the shared CSS rule already applies to every
`.cat-card img`.

## 4. Insert as the last tile in the grid

New tiles are appended at the end of the existing `.cat-card` list (the grid
is not alphabetized — it's in the order tiles were added). Anchor the
insertion on the current last tile line so the edit is unambiguous, and add
the new line immediately after it, before the grid container closes.

## 5. Verify by extracting from the file, not by re-typing

After saving the edit, read the new line back out of `public/index.html`
with a tool call — do not re-type the string to "double check" it, since a
second hand-typed copy could introduce the same kind of mistake it's meant
to catch.

## 6. Verify against the database

Use the string extracted in step 5 (not a fresh retype) to run:

```sql
SELECT COUNT(*) FROM questions WHERE category = '<extracted string>';
```

It must return the expected, already-known row count for that category. If
it returns 0 or an unexpected number, the tile string and the DB category
string don't actually match byte-for-byte. Never trust how the Arabic text
*looks* in a terminal to judge this — right-to-left rendering can visually
reorder characters and make a mismatched string look fine. Trust the query
result, or a direct code-point comparison, not the visual.

## 7. Update the tracked count and confirm in-browser

- Update the grid tile count tracked in CLAUDE.md to the new total.
- Load the game in a browser and confirm the tile renders with its full
  image (including the baked-in border, not cropped), is selectable, and
  toggles correctly.
