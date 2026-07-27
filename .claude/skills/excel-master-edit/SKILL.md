---
name: excel-master-edit
description: >
  Procedure for safely editing the Excel master question bank workbook —
  file-lock check, timestamped backup, true row deletion via spliceRows
  (never blanking), and fresh re-read verification. Use when deleting,
  inserting, or bulk-editing rows in the master Question Bank spreadsheet.
---

# Editing the Excel master safely

The master Excel file is the single source of truth for question content.
A silent bad save here is worse than a bad DB write, because nothing
downstream would catch it automatically.

## 1. Check the file isn't locked

Before opening the file for a write, confirm it isn't currently open in
Excel elsewhere (a locked file can fail to save, or silently save to a temp
copy instead of the real file). If there's any doubt, ask the user to close
it in Excel first rather than guessing.

## 2. Take a timestamped backup first

Copy the master file to a backup path with a timestamp suffix before making
any edit (e.g. `Question-Bank-backup-<timestamp>.xlsx`). Keep it until the
edit is verified good in step 5.

## 3. Edit programmatically

Make the change with a script rather than instructing hand-edits — this
keeps the operation repeatable and avoids partial/manual save mistakes.

## 4. True deletion, never blanking

When removing rows, use a real row-delete/splice operation that shifts the
rows below it upward (e.g. `worksheet.spliceRows(startRow, rowCount)`).
Never clear a row's cell contents and leave the empty row in place — a
blanked row leaves a gap that can be misread as real (empty) data by
anything reading the sheet by row position.

## 5. Save, then re-read fresh to verify

Fully close the file handle after saving. Then open the saved file again
as a completely fresh read (not the in-memory object still held from the
edit step) and confirm the change landed — check the row count and, for a
targeted edit, the specific cell values. This is the only way to catch a
silent save failure.

## 6. Flag any DB sync this implies

If the edited rows already exist in Supabase, this edit alone leaves master
and the live database diverged. Point the user to the `content-loader`
skill (or `divergence-sweep` to confirm what actually diverged) as the next
step — this skill only covers the spreadsheet edit itself.
