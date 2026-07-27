---
name: divergence-sweep
description: >
  Procedure for a full-cell comparison between the Excel master question
  bank and the live Supabase questions table, including image_url, to catch
  drift caused by a skipped, partial, or manually-edited load. Use when
  auditing whether the master spreadsheet and the database still match,
  verifying a load actually landed correctly, or investigating why a live
  question doesn't match the spreadsheet.
---

# Master ↔ database divergence sweep

This is a **read-only audit**. It never writes to the database or the Excel
file — it only reports mismatches.

## 1. Normalize both sides to the same format

Read the master Excel rows for the category (or categories) being swept, and
convert them the same way a load would:
- Answer letters (A–D) → full answer text
- Arabic difficulty (سهل/متوسط/صعب) → English (easy/medium/hard)

Query the matching Supabase rows. Comparing un-normalized data produces false
mismatches.

## 2. Pick the right matching key per category

Rows must be paired between master and DB before their cells can be
compared. The key depends on whether the category's question text is unique
per row:

- **Unique question text per row (most categories):** match on
  category + difficulty + question text.
- **Fixed/shared question text across all rows** (e.g. any category where
  every row asks the identical question, such as image-identification
  categories): question text can't disambiguate rows — match on `image_url`
  instead, since that's the field that's actually unique per row.

If unsure which applies, check whether the category's question text is
templated/identical across rows before picking a key.

## 3. Compare every relevant cell

For each matched pair, diff:
- question text
- all four choices/distractors
- correct answer
- difficulty
- category
- `image_url`

## 4. Report, don't fix

Produce a per-category report of:
- rows present in master but missing from the DB
- rows present in the DB but missing from master
- rows present in both with mismatched cells (name which cell(s))

Hand the report to the user. The fix path depends on what's found — a
missing-row gap for an image-backed category needs the append-only path from
the `content-loader` skill; a cell mismatch may need a targeted UPDATE. Don't
auto-apply a fix as part of the sweep.
