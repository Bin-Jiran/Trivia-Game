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
  (see step 7) — if one still exists, do not re-run it; ask the user what
  happened to it first. Re-running a spent INSERT duplicates rows.
- **Append-only check.** If the target category is image-backed
  (`image_url` is used for its rows) and already has rows in the DB, a
  delete+reload is forbidden — build an append-only INSERT (new rows only)
  or a targeted UPDATE (existing rows only) instead of a full category
  reload. Check CLAUDE.md for any category-specific append-only rule before
  starting.
- **Pending master-edit check (delete+reload only).** Before deleting
  anything, query `question_pending_master_edits` for the category being
  reloaded:
  ```sql
  SELECT question_id FROM question_pending_master_edits WHERE category = '<category>';
  ```
  `question_pending_master_edits.question_id` is `ON DELETE CASCADE` to
  `questions.id`. A delete+reload assigns new ids, so deleting the old rows
  would delete their pending-edit rows too — a panel fix would silently
  revert to the master's old text, and the record telling you to mirror
  that fix into the master would be destroyed in the same instant. The
  dashboard's pending count drops to zero and looks clean while data was
  actually lost. **If this query returns any rows, refuse the delete+reload**
  and report the affected question ids to the user instead of proceeding —
  fix those questions in the master and clear their pending rows first (or
  use a targeted UPDATE / append-only path instead, per the append-only
  check above).

  Caution: `question_pending_master_edits.category` holds whatever category
  string was current *when the panel edit happened*, not necessarily the
  category's current name — this project has renamed categories before. If
  the category being reloaded has been renamed recently, the query above can
  miss a pending row still filed under the old name. In that situation also
  check by `question_id` directly (the ids of every question currently in
  the category) rather than trusting the category-string match alone.

  Note: this same class of problem is not limited to delete+reload. A
  targeted UPDATE that changes a question's TEXT breaks `old_question` on
  any outstanding `question_pending_master_edits` row for that question —
  `old_question` is the key the pending-mirror view uses to locate the row
  in the master, and it now points at text that no longer exists in the DB.
  Any loader that rewrites question text on a row with an outstanding
  pending edit leaves that edit unmatchable. Flagged here for a future
  guard; not solved by this skill yet.
- **Format conversion.** The Excel master and Supabase use different
  formats — convert both directions:
  - Answers: master uses letters A–D → Supabase stores the full answer text.
  - Difficulty: master uses Arabic (سهل/متوسط/صعب) → Supabase uses English
    (easy/medium/hard).
- **`image_url` semantics.** NULL = text question. A path = classic
  image-in-question rendering. `is_image=true` is a separate, unused
  feature — never set both on one row.

## 2. Delete+reload preservation (delete+reload only)

A delete+reload assigns brand-new ids to every row in the category, which
loses two things that have no equivalent column in the master:

- **`active=false` rows.** Nothing in the master records which rows were
  deliberately deactivated, so a delete+reload must capture that state and
  restore it after the reload — matched by category + difficulty + question
  text, the same key the divergence-sweep skill uses to pair master and DB
  rows. The capture and re-apply happen inside the load transaction itself
  (step 5): capture immediately before the DELETE, so nothing deactivated in
  the gap between planning and execution is missed; re-apply after the
  INSERT; then verify the re-applied row count matches the captured count
  before COMMIT. A partial match — e.g. a text difference between the old DB
  row and the master's version — must abort the whole transaction, or a
  deliberately-deactivated question silently returns to rotation.
- **Unresolved `question_flags` for the category.** `question_flags.question_id`
  is also `ON DELETE CASCADE` to `questions.id`, so the DELETE half of a
  delete+reload removes that category's unresolved flags along with the old
  rows. This is expected and acceptable — those flags point at rows that no
  longer exist — but say so in the load summary given to the user; don't let
  it pass silently.

## 3. Back up before mutating

Before any INSERT/UPDATE runs, snapshot the affected table (or at minimum
the affected category's rows) into a timestamped backup table
(`questions_backup_<timestamp>`). Do not drop any existing pending backup
table without confirming with the user first — backups are only dropped
after the *next* load commits cleanly, never preemptively.

## 4. Extract the category string — never type it

Pull the exact category string from an authoritative source (the master
Excel's category column, or the existing tile in `public/index.html` if the
category already has a tile) using a tool read/grep — never hand-type Arabic
text into the SQL. Use that extracted string verbatim everywhere the SQL
references the category, including the pending master-edit check and the
active-row capture query above.

## 5. Write the SQL as one guarded transaction: INSERT, then verify, then COMMIT

The proven pattern verifies **after** inserting, inside the same
transaction, immediately before COMMIT — not before the insert. For a
delete+reload, the full sequence inside one transaction is: capture
`active=false` rows, DELETE, INSERT, re-apply `active=false` (with its own
row-count verification), then the general verification block, then COMMIT.

```sql
BEGIN;

-- Delete+reload only: capture active=false rows before the DELETE removes them
CREATE TEMP TABLE _preserve_inactive ON COMMIT DROP AS
  SELECT difficulty, question FROM questions
    WHERE category = '<category>' AND active = FALSE;

DELETE FROM questions WHERE category = '<category>';

INSERT INTO questions (category, difficulty, question, choice1, choice2, choice3, choice4, answer, image_url)
  VALUES (...);
-- (or the append-only / targeted UPDATE form from step 1, for a non-reload load)

-- Delete+reload only: re-apply active=false, then verify every captured row was matched
DO $$
DECLARE
  expected_inactive  int;
  reapplied_inactive int;
BEGIN
  SELECT COUNT(*) INTO expected_inactive FROM _preserve_inactive;

  UPDATE questions SET active = FALSE
    WHERE category = '<category>' AND active = TRUE
      AND (difficulty, question) IN (SELECT difficulty, question FROM _preserve_inactive);
  GET DIAGNOSTICS reapplied_inactive = ROW_COUNT;

  IF reapplied_inactive <> expected_inactive THEN
    RAISE EXCEPTION 'active=false re-apply mismatch for <category>: expected %, re-applied % — a deactivated row would silently return to rotation',
      expected_inactive, reapplied_inactive;
  END IF;
END $$;

DO $$
DECLARE
  cat_total   int;
  diff_count  int;
BEGIN
  -- exact category row count matches the planned total
  SELECT COUNT(*) INTO cat_total FROM questions WHERE category = '<category>';
  IF cat_total <> <expected_category_total> THEN
    RAISE EXCEPTION 'row count mismatch for <category>: expected %, got %',
      <expected_category_total>, cat_total;
  END IF;

  -- No check here for "answer among its four choices" — questions already
  -- carries the CHECK constraint answer_is_a_choice (answer = choice1 OR
  -- choice2 OR choice3 OR choice4), present identically on dev and
  -- production. Postgres rejects a violating INSERT/UPDATE outright, before
  -- this block ever runs, so restating the check here would only duplicate
  -- a guarantee that already exists and risk drifting out of sync with it.

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
commits, including the DELETE, INSERT, and active re-apply that already ran
earlier in the same transaction. This is the load-bearing step: pre-insert
planning checks (step 1) catch known bad setups, but this post-insert,
in-transaction verification is what actually guarantees a bad load never
lands.

## 6. Check the file before running it

Open the generated SQL file and confirm it contains real newlines, not a
literal `\n` text artifact — that has caused a syntax failure before. Confirm
it once visually before executing.

## 7. Run and clean up

1. Run the transaction. A successful COMMIT already means every check in
   step 5 passed — no separate post-hoc verification query is needed.
2. Delete the SQL file from the repo — spent load files are never kept
   around, to prevent an accidental re-run.
3. Tell the user the load succeeded and what backup table now exists so they
   can decide when it's safe to drop (only after the *next* successful
   load, per the standing rule). For a delete+reload, also state how many
   `active=false` rows were re-applied and how many unresolved
   `question_flags` rows were cascaded away.
