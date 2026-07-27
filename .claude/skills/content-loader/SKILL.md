---
name: content-loader
description: >
  Procedure for loading new trivia questions from the Excel master into the
  Supabase database — gate checks, backups, byte-exact category extraction,
  single-transaction guarded SQL, and the append-only rule for image-backed
  categories. Use when adding new questions or a new category to the live
  database, generating INSERT SQL for a content load, or syncing an Excel
  master edit into Supabase.
---

# Content load procedure

## 1. Gate checks (before writing any SQL)

- **Not a re-run.** Confirm no leftover INSERT SQL file already exists in the
  repo for this content. Spent load files are always deleted after running
  (see step 5) — if one still exists, do not re-run it; ask the user what
  happened to it first. Re-running a spent INSERT duplicates rows.
- **Append-only check.** If the target category is image-backed
  (`image_url` is used for its rows) and already has rows in the DB, a
  delete+reload is forbidden — build an append-only INSERT (new rows only)
  or a targeted UPDATE (existing rows only) instead of a full category
  reload. Check CLAUDE.md for any category-specific append-only rule before
  starting.
- **Format conversion.** The Excel master and Supabase use different
  formats — convert both directions:
  - Answers: master uses letters A–D → Supabase stores the full answer text.
  - Difficulty: master uses Arabic (سهل/متوسط/صعب) → Supabase uses English
    (easy/medium/hard).
- **`image_url` semantics.** NULL = text question. A path = classic
  image-in-question rendering. `is_image=true` is a separate, unused
  feature — never set both on one row.

## 2. Back up before mutating

Before any INSERT/UPDATE runs, snapshot the affected table (or at minimum
the affected category's rows) into a timestamped backup table
(`questions_backup_<timestamp>`). Do not drop any existing pending backup
table without confirming with the user first — backups are only dropped
after the *next* load commits cleanly, never preemptively.

## 3. Extract the category string — never type it

Pull the exact category string from an authoritative source (the master
Excel's category column, or the existing tile in `public/index.html` if the
category already has a tile) using a tool read/grep — never hand-type Arabic
text into the SQL. Use that extracted string verbatim everywhere the SQL
references the category.

## 4. Write the SQL as one guarded transaction: INSERT, then verify, then COMMIT

The proven pattern verifies **after** inserting, inside the same
transaction, immediately before COMMIT — not before the insert:

```sql
BEGIN;

INSERT INTO questions (...) VALUES (...);
-- (or the append-only / targeted UPDATE form from step 1)

DO $$
DECLARE
  cat_total   int;
  bad_answers int;
  diff_count  int;
BEGIN
  -- exact category row count matches the planned total
  SELECT COUNT(*) INTO cat_total FROM questions WHERE category = '<category>';
  IF cat_total <> <expected_category_total> THEN
    RAISE EXCEPTION 'row count mismatch for <category>: expected %, got %',
      <expected_category_total>, cat_total;
  END IF;

  -- zero rows where the answer text isn't among that row's four choices
  SELECT COUNT(*) INTO bad_answers FROM questions
    WHERE category = '<category>'
      AND correct_answer NOT IN (choice_a, choice_b, choice_c, choice_d);
  IF bad_answers > 0 THEN
    RAISE EXCEPTION 'integrity check failed: % row(s) in <category> have an answer not among their four choices',
      bad_answers;
  END IF;

  -- per-difficulty counts match the plan (repeat per difficulty)
  SELECT COUNT(*) INTO diff_count FROM questions
    WHERE category = '<category>' AND difficulty = '<difficulty>';
  IF diff_count <> <expected_difficulty_total> THEN
    RAISE EXCEPTION 'difficulty count mismatch for <category>/<difficulty>: expected %, got %',
      <expected_difficulty_total>, diff_count;
  END IF;

  -- grand total across every category/difficulty touched by this load
  -- (only needed for multi-category loads) — same pattern, RAISE on mismatch
END $$;

COMMIT;
```

If any check fails, `RAISE EXCEPTION` aborts the whole transaction — nothing
commits, including the INSERT that already ran earlier in the same
transaction. This is the load-bearing step: pre-insert planning checks (step
1) catch known bad setups, but this post-insert, in-transaction verification
is what actually guarantees a bad load never lands.

## 5. Check the file before running it

Open the generated SQL file and confirm it contains real newlines, not a
literal `\n` text artifact — that has caused a syntax failure before. Confirm
it once visually before executing.

## 6. Run and clean up

1. Run the transaction. A successful COMMIT already means every check in
   step 4 passed — no separate post-hoc verification query is needed.
2. Delete the SQL file from the repo — spent load files are never kept
   around, to prevent an accidental re-run.
3. Tell the user the load succeeded and what backup table now exists so they
   can decide when it's safe to drop (only after the *next* successful
   load, per the standing rule).
