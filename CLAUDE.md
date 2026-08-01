# Instructions

I'm a beginner. Explain what you're doing and why, in plain language, before each step. Don't assume I know coding terms.

# Project memory — Al-Falta (الفلتة) trivia game

Durable rules only. No live row counts here — they go stale; get counts from the database when needed.

## Data formats & source of truth
- The Excel master (`C:/Users/aljir/Trivia-Data/Question-Bank/`) is the single source of truth. Any edit to EITHER side — a master edit, or a direct database fix like the single-row exception below — requires mirroring the same change into the other, or master and live silently diverge.
- Master format: answers as letters A–D, difficulty in Arabic (سهل/متوسط/صعب). Supabase format: answers as full text, difficulty in English (easy/medium/hard). Every load converts both.
- `image_url` column: NULL = text question; a path (e.g. `/flags/kw.svg`) = classic image-in-question rendering. `is_image=true` is the separate (unused) 2×2 tile feature — never set both on one row.
- Never trust terminal display of Arabic strings (RTL reordering lies) — verify by code points or a DB query.

## Load patterns
- Content loads (new categories, bulk inserts, master→DB syncs) always follow the content-loader skill.
- Category delete+reload is PERMANENTLY FORBIDDEN for أنمي once image rows exist — use append-only or targeted-UPDATE loaders after that point.
- Spent INSERT files must never be re-run (it duplicates rows) — the content-loader skill handles this and file cleanup.

## New-tile workflow
- Adding a category tile follows the new-tile skill (byte-exact insertion + DB verification).
- The category grid is currently 28 tiles — keep this number in sync when adding/removing tiles.
- Tiles are image cards, not emoji+text: served from `public/categories/` as WebP, named by ASCII slug (`animals.webp`, `crests.webp`, …), source ratio 980×1490 rendered with `object-fit: contain` — never `cover`, which crops the baked-in white border. Titles are baked into the artwork, so renaming a category does NOT rename its file, but DOES require re-editing the image itself.
- Category-card selected state: the green frame is drawn as a `.cat-card.selected::after` overlay at z-index 1, NOT as a box-shadow on `.cat-card` itself. `.cat-card` has `overflow: hidden` and a fully opaque `<img>` child, so an inset shadow on the card is painted over by the artwork and never appears. The outward green glow must live on `.cat-card.selected` (an element's own shadow escapes its own `overflow: hidden`; a child's cannot). The numbered `.cat-badge` carries `z-index: 2` to stay above the frame. Commit 13efff6.
- The question image frame is chosen by path prefix on one line in `public/index.html`: default `.q-image` is 2:1 (flag-shaped); a path starting with `/crests/` toggles `.crest-frame` to 1:1. Adding a third image folder needs three edits — a new CSS aspect class, a new prefix toggle on that same line, and `image_url` values using the new prefix. Every toggle must be able to CLEAR the others, or a stale frame carries over to the next question.

## Image assets & intellectual property
- No image in this repo has a recorded source, license, or attribution. Any new image asset MUST record its origin before it is committed.
- شعارات كروية (club crests) are trademarked third-party marks. They are a known App Store risk under Apple Guideline 5.2.1 and must be resolved before any app-store submission (Track C).
- Anime character artwork is copyright, not trademark — there is no "identifying the thing" defense. Text questions naming a work are facts and carry no risk; images are the exposure.
- Kuwait joined the Berne Convention on 2 Dec 2014, so foreign works are automatically protected here. Do not assume local jurisdiction is a shelter.
- RULE: every new image asset must have its source recorded (where it came from and on what basis it's usable) before it is committed. No exceptions. An asset with no recorded origin does not go into the repo.
- STATUS: the IP route for image assets is NOT YET DECIDED. Do not start the أنمي image wave, بباي الطيبين wave 2, or the خمن الشعار restore until it is.

## UI conventions
- White borders follow TWO families, chosen by the element's BACKGROUND, not by its size:
  - Bold chrome — 2px solid #fff — on saturated colored surfaces: `.hero-btn`, `.gnav-item.gnav-active`, `.btn-logout`, `.opt`, `.q-box`, `.join-box`, `.points-tag`, `.phase-banner`, badges, `.meter .m-bar`. (`.navgroup` is 3px — large container, deliberate outlier.)
  - Smoked glass — 1px rgba(255,255,255,0.22) — on dark translucent surfaces: `.info-item`, `.level-plaque`, `.code-box`, `.glass-chip`, `.howto-box`, `.lb-frost`, `.podium-bg`, `.maint-box`, `.phase-frost`.
  A dark translucent element takes the smoked-glass border even when it sits among bold chrome. Commit 6bf80e7.
- `.hero-btn` is flat (no "0 5px 0" ledge shadow); press feedback is `transform: scale(0.97)`, matching `.cat-card` and `.btn-logout`.
- `#p-level-name` is written with `.textContent` by `showProfile()` — it must stay a LEAF element. The "المستوى:" label is a SIBLING inside the `.level-plaque` wrapper, never a child of `#p-level-name`.
- The centre home bulb is also a `.gnav-item`, so any `.gnav-active` styling must exclude it with `:not(.gnav-home)` or the transparent bulb icon gets a border box drawn around it.

## Content conventions
- أنمي: one category (per-title split rejected); every question carries its title, convention «في {Title}، …»; a future split is a prefix-match relabel. Character-image questions will NOT name the anime. Titles/character/technique names in English, question text in Arabic.
  - أنمي answers and distractors are ENGLISH ONLY; بباي الطيبين answers and distractors use ARABIC DUB names instead. This split is deliberate — أنمي is the international-naming category, بباي الطيبين is the nostalgia category and uses the names people grew up hearing. Do not unify them.
  - أنمي image questions (when they exist) are Type A: the image shows a character, the answer is the CHARACTER name, fixed stem «من هذه الشخصية؟». The question must never name the anime. Distractors are other character names, in English.
- بباي الطيبين (formerly كرتون, renamed 2026-07-28): nostalgia cartoons for the Gulf audience up to the 2000s generation. Arabic DUBBED names throughout (titles and characters) — the English-titles rule of أنمي explicitly does NOT apply here. Category name is بباي الطيبين; question prefix stays «في كرتون {الاسم}،» — كرتون here is the ordinary word for "cartoon," not the old category name, so this wording applies to existing AND future rows alike. Do not "correct" it to بباي الطيبين. Image-backed BY DESIGN — append-only forever, even while text-only, for BULK operations (delete+reload, category-wide deletes). No theme-song lyrics reproduction, ever. Overlap guard: shows covered in أنمي (currently Hunter x Hunter, Dragon Ball, Pokémon, and any future additions) must never appear in بباي الطيبين and vice versa.
  - EXCEPTION (established 2026-08-01): a single confirmed-bad row (wrong premise, unfixable without duplicating another row) may be removed with a targeted, individually-guarded single-row DELETE in master+DB — this is NOT the same operation append-only forbids. Precedent: id 2910 «من أي تراث استُمدت أغلب الحكايات؟», deleted because its premise (Grimm as the dominant source) was false for a show that draws each episode from a different people's folklore. Any such deletion must: locate by question text (never id) and report the id first, run inside a guarded single-row transaction (exact row-count checks, abort on anything unexpected), verify a sibling row of the same sub-topic still exists if one should, mirror the exact same deletion in the master with a true spliceRows (never blanked), and pass a full-category divergence sweep afterward. Bulk/category-wide deletion is still permanently forbidden — this exception is for one badly-wrong row at a time, not a loophole for re-loads.
  - بباي الطيبين content MUST use the ARABIC DUB names, never the original or international names. The best predictor is the dubbing studio: مركز الزهرة and the Gulf-region dubs Arabized character names heavily; Western properties and later dubs kept them. Verified dub mappings:
    - كابتن ماجد: Misaki = ياسين، Hyuga = بسام، Wakabayashi = وليد، Wakashimazu = رعد (goalkeeper)، Roberto = فواز. ضربة النمر belongs to بسام, not رعد.
    - سلام دانك: Sakuragi = حسان، Akagi = سعد، Rukawa = فادي، Haruko = ميسون، Sendoh = سامي؛ Shohoku = فريق الصقور، Ryonan = فريق الوثبة؛ other players جواد، بدر، سهيل.
    - أبطال الديجيتال: Taichi = أمجد، Hikari = هند، Greymon = صنديد؛ other companions أزرق، سلحوف، صقر، خرموش، صدى.
    - عدنان ولينا: Jimsy = عبسي، Lepka = علام، Dr. Lao = الدكتور رامي، Monsley = سميرة.
    - جريندايزر: the ranch owner is دامبي (not دانبي).
    - Shows that KEPT original names (verified clean): المحقق كونان، يوغي، سلاحف النينجا، توم وجيري، ماوكلي، هايدي، سالي، ريمي، جزيرة الكنز، فلونه، ساندي بل، ليدي ليدي، ماروكو، بيل وسبستيان، وداعاً ماركو، عهد الأصدقاء، الليث الأبيض، النمر المقنع، مغامرات سندباد.
    - CONFIDENCE: names actually used in a verified DB fix and stated outright in sources — حسان/سعد/فادي، أمجد، هند، عبسي، فواز، ياسين، بسام، فريق الصقور. Sourced but NOT yet used in any fix, verify before relying on them — ميسون، سامي، فريق الوثبة، جواد/بدر/سهيل (confirmed as Shohoku players, but which maps to Mitsui/Miyagi/Kogure is UNKNOWN)، علام، الدكتور رامي، سميرة. Digimon companions خرموش (هند) and صدى (وسيم) have known owners. Pure-guess names with no source at all (صنديد, and the ownerless Digimon companions) are NOT recorded here — they live in `unverified-dub-names.md` and must be sourced before any use.
  - WRONG-SHOW ATTRIBUTION is a real failure mode, found twice: عبقور is Doraemon (not Dr. Slump, which is مغامرات رنا), and سنان is a forest animal cartoon (the ninja show is نينجا المغامر / كبامارو). Verify the show identity, not just the facts.
  - The master's "Checked (C) / Unchecked (U)" column is NOT a reliable verification signal — every row reads C, including rows later found wrong. Do not treat C as evidence of review.
  - Full source-verified audit of بباي الطيبين completed 2026-08-01: all 28 shows checked against Arabic-language sources; 11 corrected, 17 clean. Category at 125 rows, master↔DB sweep-verified.
- Answer and its three distractors always use the same language/spelling per row.
- أساطير: answers and distractors in English (names); meaning-answers may stay Arabic.
- قصص الأنبياء covers past prophets only; سيرة النبي محمد ﷺ stays in إسلامي. Sourcing: Quranic narrative and mainstream tafsir only.
- «بني إسرائيل» in قصص الأنبياء is the Quranic term (children of يعقوب عليه السلام) — it is unrelated to the state and must NEVER be caught by any إسرائيل content cleanup.
- Flag questions: fixed question «لمن هذا العلم؟», 2-letter lowercase SVG filenames in `public/flags/` (exceptions: `gb-eng`/`gb-sct`/`gb-wls` for England/Scotland/Wales), distractors from visually similar flags, never-pair rule for indistinguishable flags (e.g. Indonesia/Monaco, Romania/Chad, the UK blue-ensign family). Flag `image_url` is now recorded in the master Excel as well (backfilled from the DB, sweep-verified).
- شعارات كروية (football crests): fixed question «لمن هذا الشعار؟», `image_url` = `/crests/{name}.png` in `public/crests/`; the 1:1 crest frame is applied by path-prefix detection (`/crests/`) in index.html, so the path convention is load-bearing. Saudi club files are suffixed `-ksa`, Kuwaiti `-kw`, European clubs unsuffixed. Image-backed category — append-only FOREVER (no delete+reload).
- Bucket floors: 20 rows per difficulty for general categories, 15 for Gulf-niche (أكلات كويتية، عود وعطور، مكياج، أزياء، الكويت).

## Environment & deploys
- Local development connects to the LIVE Supabase database — there is no separate local/staging DB. Running the game on localhost reads and writes real data (playing a test game creates real `game_history` rows). Before the currency system ships, a separate Supabase project for local dev is required, since test games would otherwise debit real balances and write to the real ledger.
- Render's Environment tab is the live config; the local `.env` has NO effect on the deployed site.
- `MAINTENANCE_MODE`: only the literal lowercase string `true` enables it. The game has never launched — turning maintenance off IS the launch decision, not routine cleanup. Admins bypass maintenance via `users.is_admin`.
- `AI_FALLBACK_ENABLED` is env-driven (`process.env.AI_FALLBACK_ENABLED !== 'false'`, default ON); the live value is set in Render and is `false`, verified silent in logs (fallback retired — rounds must fill from the bank).
- Local `.env` omits `AI_FALLBACK_ENABLED`, and `server.js` defaults it to ON when the variable is missing. Render sets it to `false`. Local testing therefore does NOT reproduce production round-filling. Set `AI_FALLBACK_ENABLED=false` in local `.env`.
- Pushing to `main` auto-deploys on Render and restarts the server (drops in-memory rooms). Until launch, deploys are free — no players.
- The خمن الشعار tile was removed at commit 96316a2 (0 DB rows, was AI-fallback-served); restore it from git history when the logo category gets real content.
- Git tracks folders only via files — use `.gitkeep` for empty folders. New binary assets go through "Add file → Upload files" on GitHub web, or Claude Code copies them locally.

## Round contract (server.js)
- 3 rounds (easy/medium/hard), 12 questions each; players select 6–12 categories.
- Allocation: base 1 per category, cap 2, no cross-category top-up. With exactly 6 categories every category serves exactly 2 per round.
- Round-building queries retry once (300ms) on failure, then log loudly (room, difficulty, categories). Any AI-fallback contribution is always logged (`ℹ️ AI fallback filled …`) — with the fallback off, that line should never appear.
- `generateQuestions` returns an empty array (does not throw) on API auth failure — a broken API key shows up only as `aiFilled=0`, not as an error. Known future fix.

## Lobby & room lifecycle
- Bottom nav (profile/levels/shop/how-to-play) is hidden on the category-selection and lobby screens only — visible everywhere else. Both screens carry a fixed top-left red pill back button reusing the admin panel's `.back` style (from `admin-players.html`).
- Room lifecycle: host's back button on the LOBBY reopens category selection to edit in place — same room code, same players, new list broadcast live to everyone on save. Host's back button on CATEGORY SELECTION (with a room already open) closes the room entirely; every other player gets the centered «تم اغلاق الغرفة» popup. A non-host's back button instead reads «خروج من الغرفة» — leaves just that player, gated by a blocking نعم/لا confirmation (no auto-dismiss, unlike the toast/popup). Host-only actions (`close_room`, `update_room_categories`) are guarded on both the client (no UI path exposed to non-hosts) and the server (`room.host !== socket.id`) — a tampered client can't bypass either.
- No ready system: the host's start button begins the game immediately regardless of other players' state. No per-player ready flag exists anywhere in the code.
- Centered popups (dark box, colored border, same shape as the max-selection one) are reserved for blocking/important events only — room closed, category limit reached. Routine successes (e.g. saving edited categories) get no popup or toast; a live-updating view is the feedback.

## Currency charge boundary (design law, not yet built)
- The pulp is deducted server-side in the SAME transaction that dispatches question 1 of round 1 (the single `io.to(code).emit('question', ...)` in `askQuestion()`, server.js ~932). Never earlier. Leaving before that moment is free — this is a CONSEQUENCE of where the charge fires, not a feature to build. Nothing to enforce, no refund path, no race.
- Free-leave is a SILENT GRACE: no leave button, no UI mention of it during the countdown. Advertising it invites abandonment. The only exit during the countdown is therefore a disconnect (tab close, app background, browser back) — which is what makes the grace self-enforcing. VERIFY before building: confirm the s-phase screen carries no back/leave control inherited from the category-UI overhaul. If it does, hide it during phase 0 rather than leaving a one-tap free exit on screen.
- Minimum players is 1. If players bail during the countdown the game continues normally for whoever remains; there is no abort path. If ALL players leave, the room is deleted and `askQuestion()` no-ops via its existing `if (!room || room.status !== 'playing') return;` guard, so the charge never fires. This case needs no new code.
- TIMING GAP — reviewed and ACCEPTED, do not "fix" this: the server dispatches question 1 at `phase_start` + 3000ms (`setTimeout` in `startPhase`), but the client does not display it until `introEndsAt` = phase_start arrival + 3850ms (`runIntroCountdown`, index.html ~1332). The charge therefore fires ~850ms + one leg of latency BEFORE the player sees question 1. This gap is stable, not drifting — latency delays the countdown start and the question arrival equally, so it cancels. Decision: leave both timers as they are. With silent grace and no leave button, nobody can deliberately exploit a sub-second window they cannot see. The real cost is the rare unlucky disconnect inside that window — a player charged for a game where no question ever appeared — and the mitigation is the admin manual-refund tooling on list B, NOT a timing change. REVISIT this decision if either of these changes: (a) the admin refund tooling is cut from scope, or (b) the client intro countdown is lengthened beyond 3850ms, which widens the gap proportionally.
- "Auto-refund for crashed games" means the GAME crashed (server-side failure / room collapsed) — NOT that a player dropped. A player drop and a rage-quit are indistinguishable at the socket level, so refunding on player drop would be a refund button in disguise.

## Known blockers before currency ships
- DOUBLE-SPEND: `join_room` (server.js ~715) never checks whether `socket.roomCode` is already set, and rooms key players by `socket.id`, not user identity. There is no `socket.user.id` → active room map. The same account in two tabs can join two rooms and be charged twice against one validated balance. Enforce one active game per account, keyed on `socket.user.id`, BEFORE any charge code.
- DUPLICATE EXIT HANDLERS: `leave_room` (server.js ~779-800) and `disconnect` (server.js ~865-882) are near-duplicate cleanup logic. Extract into one shared `removePlayer(code, socketId, reason)` before adding money logic, or charge/refund behaviour will drift between the two exit paths.
- NO RECONNECT PATH: membership is keyed by `socket.id`, so a dropped player gets a new socket id and cannot rejoin a game in progress. Acceptable while free; a refund-dispute generator once games are paid. Needs a resume path (list B).
