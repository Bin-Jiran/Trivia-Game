---
name: new-tile
description: >
  Procedure for adding a new category tile to the category-selection grid
  in public/index.html — byte-exact Arabic insertion, codepoint/DB
  verification, and keeping the tracked grid tile count in sync. Use when
  adding a new selectable trivia category to the game's UI.
---

# Adding a category tile

## 1. Get the exact category string first

Get the category's exact Arabic name from an authoritative source — the
Excel master's category column (extracted with a read, not retyped) is
preferred if the category already has content planned. Never type the
Arabic name from memory: Arabic text is easy to get byte-wrong even when it
looks identical on screen.

## 2. Match the existing tile format exactly

Every tile in the grid follows this pattern:

```html
<div class="cat-opt" onclick="toggleCat(this,'NAME')"><div class="cicon">EMOJI</div><div class="cname">NAME</div></div>
```

Both occurrences of `NAME` (the `toggleCat` argument and the `cname` text)
must be the identical extracted string from step 1 — copy it, don't retype
it a second time. Pick a representative emoji for `EMOJI`.

## 3. Insert as the last tile in the grid

New tiles are appended at the end of the existing `.cat-opt` list (the grid
is not alphabetized — it's in the order tiles were added). Anchor the
insertion on the current last tile line so the edit is unambiguous, and add
the new line immediately after it, before the grid container closes.

## 4. Verify by extracting from the file, not by re-typing

After saving the edit, read the new line back out of `public/index.html`
with a tool call — do not re-type the string to "double check" it, since a
second hand-typed copy could introduce the same kind of mistake it's meant
to catch.

## 5. Verify against the database

Use the string extracted in step 4 (not a fresh retype) to run:

```sql
SELECT COUNT(*) FROM questions WHERE category = '<extracted string>';
```

It must return the expected, already-known row count for that category. If
it returns 0 or an unexpected number, the tile string and the DB category
string don't actually match byte-for-byte. Never trust how the Arabic text
*looks* in a terminal to judge this — right-to-left rendering can visually
reorder characters and make a mismatched string look fine. Trust the query
result, or a direct code-point comparison, not the visual.

## 6. Update the tracked count and confirm in-browser

- Update the grid tile count tracked in CLAUDE.md to the new total.
- Load the game in a browser and confirm the tile renders, is selectable,
  and toggles correctly.
