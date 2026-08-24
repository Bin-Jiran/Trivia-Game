require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'trivia_secret_key_2024';
const PORT = process.env.PORT || 3000;
// Render sets this per running instance — exactly the identity needed to tell "a
// row this process owns" apart from "a row some other, possibly still-live,
// instance owns" during a deploy's overlap window (see CLAUDE.md, Environment &
// deploys). Falls back to a fresh random id outside Render (local dev, anywhere
// else) — must be random, not a fixed string: two local processes sharing one
// fallback id would each treat the other's rows as "mine" and never sweep them,
// the same failure mode as the bug this whole mechanism exists to fix, just
// inverted. Generated once, held for the life of the process.
const INSTANCE_ID = process.env.RENDER_INSTANCE_ID || crypto.randomUUID();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// Maintenance mode now lives in the DB (maintenance_state table, see below) so
// flipping it doesn't need a redeploy. This env var is now only the BOOT-TIME
// SEED for a fresh table and the EMERGENCY FALLBACK if the DB can never be read
// -- see MAINTENANCE_CACHE_REFRESH_MS and isMaintenanceOn() further down.
const MAINTENANCE_ENV_FALLBACK = process.env.MAINTENANCE_MODE === 'true';

// Questions come from the Supabase `questions` table. AI generation is now only a
// gap-filler for short rounds. Defaults ON; set the AI_FALLBACK_ENABLED env var to the
// literal string 'false' (in Render's Environment tab) to disable it.
const AI_FALLBACK_ENABLED = process.env.AI_FALLBACK_ENABLED !== 'false';
const QUESTIONS_PER_ROUND = { easy: 12, medium: 12, hard: 12 };

// Supabase free-tier (Nano) session pooler caps each database-role at a
// "Pool Size" of 15 concurrent server connections, shared with the dashboard's
// SQL editor and any local scripts hitting the same project. max:10 leaves
// headroom under that shared budget for a single Render instance.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});
pool.on('error', (err) => {
  console.error('❌ Unexpected pg pool error:', err);
});

// Backstop, not a fix: a future await pool.query() (or any other promise) missing its
// own try/catch would otherwise crash the entire process on rejection — every room and
// every connected player gone at once, since rooms are in-memory only. This logs loudly
// and keeps the process alive instead. It only ever fires for a rejection that had NO
// other handler anywhere — by definition it cannot swallow or suppress anything that
// already surfaces via a try/catch, a .catch(), or Express's own handling; those never
// reach here in the first place. Registered before initDB() runs so it's live for the
// very first async operation this process performs.
process.on('unhandledRejection', (reason) => {
  console.error('❌ UNHANDLED REJECTION (process kept alive):', reason && reason.stack || reason);
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL,
      dob TEXT NOT NULL, gender TEXT NOT NULL, password TEXT NOT NULL,
      total_score INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS game_history (
      id SERIAL PRIMARY KEY, user_id INTEGER, room_code TEXT, score INTEGER,
      played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS question_flags (
      id SERIAL PRIMARY KEY,
      question_key TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      question_text TEXT,
      options TEXT,
      correct_answer TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_at TIMESTAMP,
      resolution TEXT,
      UNIQUE (question_key, user_id)
    );
    CREATE TABLE IF NOT EXISTS admin_actions (
      id SERIAL PRIMARY KEY,
      actor_id INTEGER NOT NULL,
      actor_name TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id INTEGER,
      target_name TEXT,
      before_value TEXT,
      after_value TEXT,
      reason TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_admin_actions_target_id ON admin_actions(target_id);
    CREATE INDEX IF NOT EXISTS idx_admin_actions_created_at ON admin_actions(created_at);
    CREATE TABLE IF NOT EXISTS question_pending_master_edits (
      id SERIAL PRIMARY KEY,
      question_id INTEGER NOT NULL UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      old_question TEXT NOT NULL,       new_question TEXT NOT NULL,
      old_choice1 TEXT NOT NULL,        new_choice1 TEXT NOT NULL,
      old_choice2 TEXT NOT NULL,        new_choice2 TEXT NOT NULL,
      old_choice3 TEXT NOT NULL,        new_choice3 TEXT NOT NULL,
      old_choice4 TEXT NOT NULL,        new_choice4 TEXT NOT NULL,
      old_answer_letter TEXT NOT NULL,  new_answer_letter TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    -- One row per game ATTEMPT (create_room or play_again), not per room code — a
    -- room can play many attempts across its lifetime, each with its own charge and
    -- outcome. end_reason is NULL while the attempt is still open; the crash sweep
    -- (runCrashSweep(), run once at boot and then periodically) stamps 'crashed' on
    -- a row when its owning process (owner_instance_id, below) has no fresh
    -- heartbeat in server_instances. NOT simply "this process just booted, so my
    -- memory being empty means nothing else is running" — that assumption is FALSE
    -- during every deploy: Render's zero-downtime deploys keep the previous
    -- instance alive and serving for up to 60s + shutdown_delay after the new one
    -- already has traffic (confirmed in production: a 64-second overlap, three
    -- instances alive at once — see CLAUDE.md, Environment & deploys).
    CREATE TABLE IF NOT EXISTS game_attempts (
      id SERIAL PRIMARY KEY,
      room_code TEXT NOT NULL,
      host_user_id INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      started_at TIMESTAMP,
      categories TEXT[],
      charged_at TIMESTAMP,
      charged_user_ids INTEGER[],
      last_phase_reached INTEGER,
      end_reason TEXT CHECK (end_reason IS NULL OR end_reason = ANY (ARRAY[
        'completed', 'abandoned_idle_lobby', 'all_left_before_start',
        'all_left_midgame', 'abandoned_midgame', 'crashed', 'server_shutdown'
      ])),
      -- Which server process created this attempt -- server.js's INSTANCE_ID
      -- (RENDER_INSTANCE_ID, or a random fallback outside Render). Nullable for
      -- rows that predate this column; the crash sweep treats a NULL owner as
      -- always sweep-eligible (see runCrashSweep()), matching how it behaved
      -- before ownership tracking existed. Lets the sweep tell "a row MY process
      -- created" apart from "a row some OTHER, possibly still-live, process
      -- created" -- load-bearing during a deploy's overlap window, see
      -- CLAUDE.md's Environment & deploys single-instance entry.
      owner_instance_id TEXT,
      ended_at TIMESTAMP,
      -- NOT a liveness heartbeat: bumped only by the two touch triggers below, i.e.
      -- only when a DB write actually happens (an UPDATE to this row, or an INSERT
      -- into game_attempt_events). Most of what happens during a game -- question
      -- advances, timers, answers -- is in-memory only and never touches this
      -- column. So this is "when this row last CHANGED," not "when this attempt
      -- was last confirmedly alive." On a crash, ended_at is set to this value --
      -- the last RECORDED moment, not the actual moment of death. The crash sweep
      -- does now reason about recency -- but via server_instances.last_seen (a real
      -- per-PROCESS heartbeat, see below), never via this column. Do not fold
      -- staleness logic back onto last_updated_at -- it isn't a heartbeat.
      last_updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_game_attempts_room_code ON game_attempts(room_code);
    CREATE INDEX IF NOT EXISTS idx_game_attempts_ended_at ON game_attempts(ended_at);
    -- Per-event log for one attempt: every disconnect, rejoin, and voluntary leave,
    -- timestamped as it happens — not just the attempt's final outcome. This is what
    -- makes a refund decision answerable per player instead of guessed at: was THIS
    -- player still present when the attempt went silent, or do they have their own
    -- explicit leave/disconnect on record.
    CREATE TABLE IF NOT EXISTS game_attempt_events (
      id SERIAL PRIMARY KEY,
      attempt_id INTEGER NOT NULL REFERENCES game_attempts(id) ON DELETE CASCADE,
      user_id INTEGER,
      event_type TEXT NOT NULL CHECK (event_type = ANY (ARRAY[
        'disconnected', 'rejoined', 'left_voluntarily', 'left_for_other_room', 'banned_removed'
      ])),
      phase INTEGER,
      question_index INTEGER,
      detail JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_game_attempt_events_attempt_id ON game_attempt_events(attempt_id);
    -- One row per running server process, upserted every HEARTBEAT_INTERVAL_MS for
    -- as long as it lives. This is the ONLY liveness signal the crash sweep trusts —
    -- deliberately separate from game_attempts.last_updated_at, which reflects
    -- activity on a ROOM, not the health of the PROCESS that owns it. A room can go
    -- quiet for a while during totally normal play; that says nothing about whether
    -- its owning process has crashed.
    CREATE TABLE IF NOT EXISTS server_instances (
      instance_id TEXT PRIMARY KEY,
      last_seen TIMESTAMP NOT NULL DEFAULT NOW()
    );
    -- Single-row table (id fixed to 1) holding whether the game is in maintenance
    -- mode. Read through an in-process cache, never per socket event -- see
    -- MAINTENANCE_CACHE_REFRESH_MS.
    CREATE TABLE IF NOT EXISTS maintenance_state (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_by INTEGER REFERENCES users(id)
    );
  `);
  // game_attempts already exists in both dev and production from before this column
  // was added, so it can't rely on the CREATE TABLE literal above (which no-ops
  // entirely once the table exists) -- same situation game_history.attempt_id was
  // in. Nullable: the crash sweep treats a NULL owner as always sweep-eligible.
  await pool.query('ALTER TABLE game_attempts ADD COLUMN IF NOT EXISTS owner_instance_id TEXT');
  // Backward-compatible: add new columns to pre-existing tables without touching data.
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE question_flags ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE question_flags ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP');
  await pool.query('ALTER TABLE question_flags ADD COLUMN IF NOT EXISTS resolution TEXT');
  // question_flags migration: question_key (a client-supplied SHA-256 hash of question
  // text, unable to identify any of the 551 image-backed rows sharing an identical fixed
  // stem) is replaced by a real FK on questions.id. ON DELETE CASCADE so the guarded
  // single-row DELETE precedent (CLAUDE.md, id 2910) is never blocked by a flag report
  // pointing at the row being removed. The constraint names below are explicit (not left
  // to Postgres's auto-naming) so the DROP/guarded-re-add statements match on every
  // environment: both dev and production created the dropped ones from this same
  // original CREATE TABLE statement, so the generated names are guaranteed identical.
  await pool.query('ALTER TABLE question_flags DROP CONSTRAINT IF EXISTS question_flags_question_key_user_id_key');
  await pool.query('ALTER TABLE question_flags DROP COLUMN IF EXISTS question_key');
  await pool.query('ALTER TABLE question_flags DROP COLUMN IF EXISTS question_text');
  await pool.query('ALTER TABLE question_flags DROP COLUMN IF EXISTS options');
  await pool.query('ALTER TABLE question_flags DROP COLUMN IF EXISTS correct_answer');
  // question_id is added NULLABLE first — Postgres cannot add a NOT NULL column with no
  // default to a table that already has rows, and this runs on every boot forever, so it
  // must be safe regardless of row count, not just on the empty table it happened to run
  // against first. Any row still NULL after this (pre-migration rows keyed on the dropped
  // hash) has nothing to backfill question_id from, so it's deleted rather than kept
  // invalid — then SET NOT NULL is safe unconditionally.
  await pool.query('ALTER TABLE question_flags ADD COLUMN IF NOT EXISTS question_id INTEGER');
  // This runs on EVERY boot, forever. It is a no-op on every boot after the first only
  // because question_id is made NOT NULL immediately below — once that holds, no row can
  // ever have a NULL question_id again, so there is nothing left for this to match. If
  // that NOT NULL constraint is ever relaxed for any reason, this line becomes live and
  // destructive again, silently deleting whatever rows happened to have a NULL
  // question_id at that moment. This is the one destructive statement in initDB().
  await pool.query('DELETE FROM question_flags WHERE question_id IS NULL');
  // Verified empirically: SET NOT NULL on an already-NOT-NULL column is a native no-op
  // (no guard needed) — unlike the two ADD CONSTRAINT calls below, which both need one.
  await pool.query('ALTER TABLE question_flags ALTER COLUMN question_id SET NOT NULL');
  // Postgres has no ADD CONSTRAINT IF NOT EXISTS — a bare re-run errors, which would
  // silently truncate every statement after it on every boot following the first.
  // Verified empirically per constraint type, since the SQLSTATE differs between them:
  // a duplicate FOREIGN KEY is 42710/duplicate_object, but a duplicate UNIQUE constraint
  // is 42P07/duplicate_table (it's backed by an index, so it hits the relation-name
  // class instead) — tested each bare re-run before picking its guard, not assumed.
  await pool.query(`
    DO $mig$
    BEGIN
      ALTER TABLE question_flags ADD CONSTRAINT question_flags_question_id_fkey
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $mig$;
  `);
  await pool.query(`
    DO $mig2$
    BEGIN
      ALTER TABLE question_flags ADD CONSTRAINT question_flags_question_id_user_id_key UNIQUE (question_id, user_id);
    EXCEPTION WHEN duplicate_table THEN NULL;
    END $mig2$;
  `);
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_url TEXT');
  // game_attempts is the parent, game_history stays the per-player scored-game record
  // it already is — this just links a completed row back to its attempt (roster,
  // timing, end_reason) instead of the loose, non-FK room_code text match that's all
  // game_history has today. Nullable: only rows written going forward get one; old
  // rows stay NULL, no backfill attempted. Verified empirically safe to rerun — the
  // whole ADD COLUMN IF NOT EXISTS clause (column + its inline REFERENCES) is skipped
  // together once the column exists, unlike a bare ADD CONSTRAINT.
  await pool.query('ALTER TABLE game_history ADD COLUMN IF NOT EXISTS attempt_id INTEGER REFERENCES game_attempts(id)');
  // admin_actions is append-only: enforced here at the DB level (not just by never
  // writing an UPDATE/DELETE path in code) so it holds even against a future mistake.
  // Both triggers in one call so they're created atomically — either both exist or
  // neither does. Idempotent (CREATE OR REPLACE / DROP...IF EXISTS), safe every boot.
  await pool.query(`
    CREATE OR REPLACE FUNCTION admin_actions_block_mutation() RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'admin_actions is append-only: % not allowed', TG_OP;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS admin_actions_no_update_delete ON admin_actions;
    CREATE TRIGGER admin_actions_no_update_delete
      BEFORE UPDATE OR DELETE ON admin_actions
      FOR EACH ROW EXECUTE FUNCTION admin_actions_block_mutation();

    DROP TRIGGER IF EXISTS admin_actions_no_truncate ON admin_actions;
    CREATE TRIGGER admin_actions_no_truncate
      BEFORE TRUNCATE ON admin_actions
      FOR EACH STATEMENT EXECUTE FUNCTION admin_actions_block_mutation();
  `);
  // Keeps game_attempts.last_updated_at current on any write to the row or a child
  // event, at the DB level — not left to server.js to remember on every UPDATE/
  // INSERT call site, the same reasoning as makeRoom() centralizing per-attempt
  // field resets. This is NOT a heartbeat/poll mechanism (see the column comment on
  // last_updated_at itself) — it only fires when something actually writes. The
  // boot-time crash sweep depends on this being current, but deliberately ignores
  // age/recency entirely rather than treating gaps between writes as meaningful.
  await pool.query(`
    CREATE OR REPLACE FUNCTION game_attempts_touch() RETURNS trigger AS $fn$
    BEGIN
      NEW.last_updated_at := NOW();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS game_attempts_touch_on_update ON game_attempts;
    CREATE TRIGGER game_attempts_touch_on_update
      BEFORE UPDATE ON game_attempts
      FOR EACH ROW EXECUTE FUNCTION game_attempts_touch();

    CREATE OR REPLACE FUNCTION game_attempt_events_touch_parent() RETURNS trigger AS $fn$
    BEGIN
      UPDATE game_attempts SET last_updated_at = NOW() WHERE id = NEW.attempt_id;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS game_attempt_events_touch_parent_on_insert ON game_attempt_events;
    CREATE TRIGGER game_attempt_events_touch_parent_on_insert
      AFTER INSERT ON game_attempt_events
      FOR EACH ROW EXECUTE FUNCTION game_attempt_events_touch_parent();
  `);
  console.log('✅ Database ready');

  // The ADMIN_EMAIL account is the OWNER: it is both admin and super-admin. Idempotent —
  // safe to run every boot. Only this account may promote/demote other admins.
  if (process.env.ADMIN_EMAIL) {
    // lower(email) so this still matches regardless of how the stored value
    // is cased — same reasoning as the login query below.
    const adminEmail = process.env.ADMIN_EMAIL.trim().toLowerCase();
    const r = await pool.query(
      'UPDATE users SET is_admin = TRUE, is_super_admin = TRUE WHERE lower(email) = $1',
      [adminEmail]
    );
    if (r.rowCount > 0) console.log(`👑 Owner (super-admin) privileges ensured for ${adminEmail}`);
    else console.log(`👑 ADMIN_EMAIL set to ${adminEmail} — no matching account yet (will apply once they register)`);
  }

  // Seeded once from the env var so a fresh table never silently starts as "open".
  // ON CONFLICT DO NOTHING makes this a no-op on every boot after the first, and it
  // never overwrites a value an admin has since set via the panel.
  await pool.query(
    'INSERT INTO maintenance_state (id, enabled) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
    [MAINTENANCE_ENV_FALLBACK]
  );
  // Awaited so traffic gated by dbReady sees the real DB value, not just the
  // env-var seed -- same ordering reasoning as the first heartbeat just below.
  await refreshMaintenanceCache();

  // FIRST HEARTBEAT — must land, awaited, before anything else touches
  // game_attempts. Without this ordering there's a window that reopens the exact
  // bug being fixed: dbReady flips, a player creates a room, a game_attempts row
  // is stamped owner_instance_id=THIS, but THIS has no heartbeat row yet (the
  // interval hasn't fired its first tick) — a still-live PREDECESSOR's periodic
  // sweep would see an owned row with no matching heartbeat and mark it crashed,
  // exactly the false positive this whole mechanism exists to prevent. Retried a
  // few times (not just once) because nothing downstream is safe without it
  // landing — if it never does, initDB() throws and dbReady stays false forever.
  // Refusing new rooms is the correct failure mode here, not letting the race
  // reopen silently.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pool.query(
        'INSERT INTO server_instances (instance_id, last_seen) VALUES ($1, NOW()) ON CONFLICT (instance_id) DO UPDATE SET last_seen = NOW()',
        [INSTANCE_ID]
      );
      break;
    } catch (e) {
      if (attempt === 2) throw new Error(`first heartbeat write failed after 3 attempts, refusing to finish booting: ${e.message}`);
      await new Promise(res => setTimeout(res, 500));
    }
  }
  console.log(`💓 first heartbeat recorded for instance ${INSTANCE_ID}`);

  // Crash sweep — first invocation, awaited, before dbReady flips. See
  // runCrashSweep() (defined further down, alongside the rest of the room-lifecycle
  // machinery it depends on) for the actual predicate and reasoning.
  await runCrashSweep();

  // Flips after the first heartbeat AND the sweep above have both already
  // committed — create_room refuses until this is true, which is what makes the
  // sweep race-free: no fresh attempt row can exist without an owner that already
  // has a heartbeat backing it, and nothing this process created can be caught by
  // this SAME sweep pass (it already ran).
  dbReady = true;

  // Only start recurring after dbReady flips, per the same ordering.
  heartbeatIntervalHandle = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  sweepIntervalHandle = setInterval(runCrashSweep, PERIODIC_SWEEP_INTERVAL_MS);
  maintenanceRefreshIntervalHandle = setInterval(refreshMaintenanceCache, MAINTENANCE_CACHE_REFRESH_MS);
}
initDB().catch(console.error);

// Level ladder — the SINGLE SOURCE OF TRUTH for a player's badge (home, profile,
// admin list, admin adjust-points recompute all read this via safeUser()).
// index.html's LEVELS array is a display-only copy of the SAME bands; keep them
// identical (no build step lets us share one definition).
function getLevel(score) {
  if (score <= 500)  return { name:'البطريق', emoji:'🐧', img:'/levels/penguin.png', level:1, min:0,    max:500   };
  if (score <= 1500) return { name:'الذئب',   emoji:'🐺', img:'/levels/wolf.png',    level:2, min:501,  max:1500  };
  if (score <= 2500) return { name:'الدب',    emoji:'🐻', img:'/levels/bear.png',    level:3, min:1501, max:2500  };
  if (score <= 4000) return { name:'الأسد',   emoji:'🦁', img:'/levels/lion.png',    level:4, min:2501, max:4000  };
  if (score <= 6500) return { name:'التنين',  emoji:'🐉', img:'/levels/dragon.png',  level:5, min:4001, max:6500  };
  return { name:'الفلتة!', emoji:'💥', img:'/levels/falta.png', level:6, min:6501, max:99999 };
}
function displayName(u) { return `${u.first_name} ${u.last_name.substring(0,3)}`; }
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
function safeUser(u) {
  const level = getLevel(u.total_score || 0);
  return { id:u.id, first_name:u.first_name, last_name:u.last_name,
    email:u.email, phone:u.phone, dob:u.dob, gender:u.gender,
    total_score:u.total_score||0, display_name:displayName(u), level };
}

// Load the columns the admin player-management endpoints need to make decisions
// (permissions + current score). Never selects the password hash.
async function getUserRow(id) {
  const r = await pool.query(
    'SELECT id, first_name, last_name, email, total_score, is_admin, is_super_admin, is_banned FROM users WHERE id=$1',
    [id]
  );
  return r.rows[0] || null;
}

// Admin gate: verify the JWT exactly like the protected routes, then read the
// authoritative is_admin flag from the DB (never trust a token claim). 403 if not admin.
async function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const r = await pool.query(
      'SELECT id, is_admin, is_super_admin, first_name, last_name FROM users WHERE id=$1',
      [payload.id]
    );
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: 'غير موجود' });
    if (!user.is_admin) return res.status(403).json({ error: 'ممنوع' });
    req.adminId = user.id;
    // Super-admin (owner) status, read fresh from the DB. Endpoints that manage
    // admins gate on this; never trust a token claim for it.
    req.isSuperAdmin = !!user.is_super_admin;
    // The acting admin's own name, snapshotted into every admin_actions row this
    // request writes — see logAdminAction.
    req.adminName = `${user.first_name} ${user.last_name}`;
    next();
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
}

// Thrown inside an admin-action transaction to abort with a specific HTTP status
// (403/404) instead of the generic 500 every other failure gets. withTransaction
// rolls back on this exactly like any other throw — this only changes what the
// ROUTE handler responds with once the rollback is done.
class AdminActionAbort extends Error {
  constructor(status, body) { super('admin action aborted'); this.status = status; this.body = body; }
}

// Run fn(client) inside BEGIN/COMMIT; ROLLBACK+release on any throw (including
// AdminActionAbort), so a rejected permission check never leaves the transaction
// open and never writes an admin_actions row. The ROLLBACK is guarded in its own
// try/catch so a rollback failure can't mask the original error.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackErr) {
      console.error('❌ ROLLBACK failed:', rollbackErr.message, '(original error:', e.message + ')');
    }
    throw e;
  } finally {
    client.release();
  }
}

// Single insert point for admin_actions — append-only at the DB level too (see the
// triggers created in initDB()).
async function logAdminAction(client, { actorId, actorName, action, targetId, targetName, beforeValue, afterValue, reason }) {
  await client.query(
    `INSERT INTO admin_actions (actor_id, actor_name, action, target_id, target_name, before_value, after_value, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actorId, actorName, action, targetId ?? null, targetName ?? null, beforeValue ?? null, afterValue ?? null, reason]
  );
}

// Shared row-lock read every mutating admin endpoint below uses. FOR UPDATE holds
// the row lock for the rest of the transaction, so a concurrent write elsewhere
// (e.g. endGame's total_score update) blocks until this transaction commits,
// instead of racing a read-then-write and silently losing an update.
const ADMIN_TARGET_LOCK_SQL =
  `SELECT id, is_admin, is_super_admin, is_banned, total_score, first_name, last_name
     FROM users WHERE id=$1 FOR UPDATE`;

// FIX #2: Shuffle options while keeping track of correct answer
function shuffleOptions(options, answer) {
  const shuffled = [...options];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // Strip letter prefix and re-add after shuffle
  const letters = ['أ', 'ب', 'ج', 'د'];
  const stripped = shuffled.map(o => o.replace(/^[أبجد]\. /, ''));
  const newOptions = stripped.map((o, i) => `${letters[i]}. ${o}`);
  // Find new answer
  const answerText = answer.replace(/^[أبجد]\. /, '');
  const newAnswer = newOptions.find(o => o.replace(/^[أبجد]\. /, '') === answerText) || newOptions[0];
  return { options: newOptions, answer: newAnswer };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Format only — no verification email. Case/whitespace normalized on the
// SERVER (register + login below), never trusted from the client, so
// Khalifa@x.com and khalifa@x.com are always the same account.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/register', async (req, res) => {
  const { first_name, last_name, phone, dob, gender, password } = req.body;
  const email = (req.body.email || '').trim().toLowerCase();
  if (!first_name||!last_name||!phone||!email||!dob||!gender||!password)
    return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
  if (!EMAIL_RE.test(email))
    return res.status(400).json({ error: 'صيغة البريد الإلكتروني غير صحيحة' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users (first_name,last_name,phone,email,dob,gender,password) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [first_name,last_name,phone,email,dob,gender,hash]
    );
    const token = jwt.sign({ id: r.rows[0].id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: safeUser(r.rows[0]) });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'البريد أو الهاتف مسجل مسبقاً' });
    res.status(500).json({ error: 'خطأ في الخادم: ' + e.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { password } = req.body;
  const email = (req.body.email || '').trim().toLowerCase();
  try {
    // lower(email): matches regardless of how the stored value is cased, so
    // this is correct even before every row is backfilled to lowercase.
    const r = await pool.query('SELECT * FROM users WHERE lower(email)=$1', [email]);
    const user = r.rows[0];
    if (!user) return res.status(400).json({ error: 'البريد أو كلمة المرور غير صحيحة' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: 'البريد أو كلمة المرور غير صحيحة' });
    // Banned accounts cannot obtain a fresh session.
    if (user.is_banned) return res.status(403).json({ error: 'تم حظر حسابك. للاستفسار تواصل مع الإدارة.' });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: safeUser(user) });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.get('/api/me', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE id=$1', [payload.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'غير موجود' });
    res.json({ ...safeUser(r.rows[0]),
      is_admin: r.rows[0].is_admin || false,
      is_super_admin: r.rows[0].is_super_admin || false });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Protected test endpoint — only reachable by admins (foundation for the dashboard).
app.get('/api/admin/ping', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

// Admin dashboard metrics. Each metric is computed independently and falls back
// to 0 on error, so one failing query never breaks the whole response.
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  // In-memory live metrics (Socket.IO room state).
  let activeGames = 0, playersOnline = 0;
  try {
    activeGames = Object.keys(rooms).length;
    playersOnline = Object.values(rooms).reduce((n, r) => n + Object.keys(r.players || {}).length, 0);
  } catch (e) { /* keep whatever computed; defaults are 0 */ }

  // DB metrics — each guarded so a single failure yields 0 for that metric only.
  const count = async (sql) => {
    try { const r = await pool.query(sql); return parseInt(r.rows[0].c, 10) || 0; }
    catch (e) { return 0; }
  };
  const flaggedCount = await count('SELECT COUNT(DISTINCT question_id)::int AS c FROM question_flags WHERE resolved = FALSE');
  const pendingMirrorCount = await count('SELECT COUNT(*)::int AS c FROM question_pending_master_edits');
  const crashedCount = await count(
    "SELECT COUNT(*)::int AS c FROM game_attempts WHERE end_reason IN ('crashed','server_shutdown')"
  );

  res.json({ activeGames, playersOnline, flaggedCount, pendingMirrorCount, crashedCount });
});

const LEAVE_EVENT_TYPES = ['left_voluntarily', 'left_for_other_room'];
const END_REASON_LABELS_AR = {
  completed: 'اكتملت اللعبة', abandoned_idle_lobby: 'انتهت مهلة الغرفة (لم تبدأ)',
  all_left_before_start: 'غادر الجميع قبل البدء', all_left_midgame: 'غادر الجميع أثناء اللعبة',
  abandoned_midgame: 'انقطع الجميع ولم يعد أحد', crashed: 'تعطل الخادم', server_shutdown: 'إعادة نشر الخادم'
};

// Read-only review queue for refund complaints. Two modes on one endpoint:
//  - no `search`: the default queue -- crashed + server_shutdown attempts, newest
//    first (see CLAUDE.md, "the case needing attention").
//  - `search`: EVERY attempt (any end_reason) that a matching, ACTUALLY-CHARGED
//    user was part of -- charged_user_ids is the scope, because an attempt that
//    never reached question 1 was never charged and isn't part of a refund
//    conversation. Matches name/email/phone.
// Verdicts are computed HERE, server-side, so the rule lives in one place -- see
// CLAUDE.md, Currency charge boundary, for why crashed and server_shutdown must be
// read differently: a crash kills the process before it can log a leave event, so
// "no leave event" on a CRASHED attempt is an absence of evidence, not proof the
// player was connected -- refund is the default, not a claim. server_shutdown is
// the opposite: the SIGTERM handler was alive to write events, so "no leave event"
// there really does mean they were still connected. Verdicts are only meaningful
// for these two end_reasons; other rows (surfaced only via search) carry no
// per-player verdict, just the plain end_reason.
app.get('/api/admin/crashed-games', requireAdmin, async (req, res) => {
  const search = (req.query.search || '').toString().trim();
  try {
    let attempts;
    if (search) {
      const r = await pool.query(
        `SELECT DISTINCT ga.*, u.id AS matched_user_id, u.first_name, u.last_name
           FROM game_attempts ga
           JOIN users u ON ga.charged_user_ids @> ARRAY[u.id]
          WHERE u.first_name ILIKE $1 OR u.last_name ILIKE $1
             OR (u.first_name || ' ' || u.last_name) ILIKE $1
             OR u.phone ILIKE $1
          ORDER BY ga.created_at DESC`,
        [`%${search}%`]
      );
      attempts = r.rows;
    } else {
      const r = await pool.query(
        `SELECT * FROM game_attempts WHERE end_reason IN ('crashed','server_shutdown')
          ORDER BY created_at DESC`
      );
      attempts = r.rows;
    }
    if (!attempts.length) return res.json({ attempts: [] });

    const attemptIds = attempts.map(a => a.id);
    const allUserIds = [...new Set(attempts.flatMap(a => a.charged_user_ids || []))];

    const [eventsResult, usersResult] = await Promise.all([
      pool.query(
        'SELECT attempt_id, user_id, event_type, question_index FROM game_attempt_events WHERE attempt_id = ANY($1)',
        [attemptIds]
      ),
      allUserIds.length
        ? pool.query('SELECT id, first_name, last_name FROM users WHERE id = ANY($1)', [allUserIds])
        : Promise.resolve({ rows: [] })
    ]);

    const leftByAttemptUser = new Set(
      eventsResult.rows.filter(e => LEAVE_EVENT_TYPES.includes(e.event_type)).map(e => `${e.attempt_id}:${e.user_id}`)
    );
    const maxQIndexByAttempt = {};
    for (const e of eventsResult.rows) {
      if (e.question_index == null) continue;
      if (maxQIndexByAttempt[e.attempt_id] == null || e.question_index > maxQIndexByAttempt[e.attempt_id]) {
        maxQIndexByAttempt[e.attempt_id] = e.question_index;
      }
    }
    const userNames = Object.fromEntries(usersResult.rows.map(u => [u.id, `${u.first_name} ${u.last_name}`]));

    const result = attempts.map(a => {
      const verdictable = a.end_reason === 'crashed' || a.end_reason === 'server_shutdown';
      const players = (a.charged_user_ids || []).map(uid => {
        const left = leftByAttemptUser.has(`${a.id}:${uid}`);
        let verdict = null;
        if (verdictable) {
          if (left) verdict = 'left_voluntarily';
          else verdict = a.end_reason === 'server_shutdown' ? 'was_connected' : 'no_record_refund_default';
        }
        return { user_id: uid, name: userNames[uid] || `#${uid}`, verdict };
      });
      return {
        id: a.id, room_code: a.room_code, created_at: a.created_at, started_at: a.started_at,
        ended_at: a.ended_at, end_reason: a.end_reason, end_reason_label: END_REASON_LABELS_AR[a.end_reason] || a.end_reason,
        last_phase_reached: a.last_phase_reached,
        last_known_question_index: maxQIndexByAttempt[a.id] ?? null,
        categories: a.categories || [],
        eventsUnreliable: a.end_reason === 'crashed',
        players
      };
    });
    res.json({ attempts: result });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Maintenance status for the admin panel. Reads the DB directly (not the cache) so
// the panel always shows ground truth, not a value that could be up to
// MAINTENANCE_CACHE_REFRESH_MS stale. Open to any admin (unlike the toggle below)
// so a non-owner admin can still see whether the game is open.
app.get('/api/admin/maintenance', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ms.enabled, ms.updated_at, u.first_name, u.last_name
         FROM maintenance_state ms LEFT JOIN users u ON u.id = ms.updated_by
        WHERE ms.id = 1`
    );
    const row = r.rows[0] || { enabled: false };
    res.json({
      enabled: !!row.enabled,
      updated_at: row.updated_at || null,
      updated_by_name: row.first_name ? `${row.first_name} ${row.last_name}` : null
    });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Toggle maintenance mode — the launch switch and the kill switch, so restricted to
// the owner only, same tier as /promote and /demote. A second admin added later
// must not be able to take the game offline. Same audit pattern as every other
// mutating admin endpoint: FOR UPDATE lock, single transaction, admin_actions row.
// No target user/question, so targetId/targetName are null.
app.post('/api/admin/maintenance', requireAdmin, async (req, res) => {
  if (!req.isSuperAdmin) return res.status(403).json({ error: 'صلاحية المالك مطلوبة' });
  const enabled = req.body?.enabled;
  const reason = (req.body?.reason || '').toString().trim();
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'بيانات غير صالحة' });
  if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });
  if (reason.length > 500) return res.status(400).json({ error: 'السبب طويل جداً (الحد الأقصى 500 حرف)' });
  try {
    const result = await withTransaction(async (client) => {
      const r = await client.query('SELECT enabled FROM maintenance_state WHERE id=1 FOR UPDATE');
      const before = r.rows[0] ? r.rows[0].enabled : false;
      if (before === enabled) {
        throw new AdminActionAbort(400, { error: enabled ? 'الصيانة مفعّلة بالفعل' : 'الصيانة متوقفة بالفعل' });
      }
      await client.query(
        'UPDATE maintenance_state SET enabled=$1, updated_at=NOW(), updated_by=$2 WHERE id=1',
        [enabled, req.adminId]
      );
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName,
        action: enabled ? 'maintenance_on' : 'maintenance_off',
        targetId: null, targetName: null,
        beforeValue: String(before), afterValue: String(enabled), reason
      });
      return { enabled };
    });
    // Write-through: update this process's own cache immediately instead of
    // waiting for the next periodic refresh — see the comment on maintenanceCache.
    maintenanceCache = { enabled: result.enabled };
    res.json({ ok: true, enabled: result.enabled });
  } catch (e) {
    if (e instanceof AdminActionAbort) return res.status(e.status).json(e.body);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

const ANSWER_LETTERS = ['A', 'B', 'C', 'D'];
// English (DB/questions.difficulty) -> Arabic (Excel master format). Single source
// for every DB-format-to-master-format difficulty translation in this file --
// duplicating this literal is how one copy silently drifts from the others.
const DIFFICULTY_AR = { easy: 'سهل', medium: 'متوسط', hard: 'صعب' };

// Flagged questions for review, grouped by the real questions.id they point at (not
// a client-supplied text hash — see /api/flag-question). Content is joined LIVE from
// `questions` rather than duplicated into question_flags, so the review screen always
// shows the current row, never a stale report-time snapshot. Pending only
// (resolved = FALSE), oldest-first. image_url tells the client whether this is a
// read-only image row or a panel-editable text row.
app.get('/api/admin/flags', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT q.id, q.category, q.difficulty, q.question,
             q.choice1, q.choice2, q.choice3, q.choice4, q.answer,
             q.image_url, q.active,
             COUNT(qf.id)::int AS report_count,
             MIN(qf.created_at) AS first_reported
        FROM question_flags qf
        JOIN questions q ON q.id = qf.question_id
       WHERE qf.resolved = FALSE
       GROUP BY q.id
       ORDER BY first_reported ASC
    `);
    const flags = r.rows.map(row => ({
      question_id: row.id,
      category: row.category,
      difficulty: row.difficulty,
      question: row.question,
      choices: [row.choice1, row.choice2, row.choice3, row.choice4],
      answer: row.answer,
      image_url: row.image_url,
      active: row.active,
      report_count: row.report_count,
      first_reported: row.first_reported
    }));
    res.json({ flags });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Live active-row count for one category+difficulty bucket. Used by the review
// screen's deactivate confirmation to show what would remain — informational only,
// never a block; the admin decides what leaves rotation, not this number.
app.get('/api/admin/questions/active-count', requireAdmin, async (req, res) => {
  const category = (req.query.category || '').toString();
  const difficulty = (req.query.difficulty || '').toString();
  if (!category || !difficulty) return res.status(400).json({ error: 'بيانات غير صالحة' });
  try {
    const r = await pool.query(
      'SELECT COUNT(*)::int AS c FROM questions WHERE category=$1 AND difficulty=$2 AND active',
      [category, difficulty]
    );
    res.json({ count: r.rows[0].c });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

const QUESTION_EDIT_FIELDS = ['question', 'choice1', 'choice2', 'choice3', 'choice4', 'answer_index', 'reason'];

// Edits a TEXT question's content — the question, its four choices, and which one is
// correct. Image-backed rows are refused outright: image questions are
// review-and-deactivate only, the fix happens in the master, never here. Deactivated
// rows are also refused: reactivation is the ONLY path that resolves a flag report
// (see the flags/:id/keep endpoint's identical guard) — an edit that resolved the
// flag on a still-inactive row would silently empty its card while leaving it out of
// rotation, the exact failure the deactivate-then-reactivate workflow exists to
// prevent. The fixed field list above is the only thing ever read from the body; any
// other key is rejected rather than silently ignored. category/difficulty/image_url/
// active never appear in the UPDATE's column list at all, so this cannot touch them
// regardless of what the request contains. answer_index (0-3) selects by POSITION
// among the four submitted choices — not by matching text — so the master-format
// letter (A-D) is derived directly from that position with no text-matching
// ambiguity. Writes questions, the admin_actions audit row, and the
// pending-master-edit upsert (see question_pending_master_edits) all in ONE
// transaction, and resolves any pending flag reports for this question — the fix has
// been made.
app.put('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  const questionId = parseInt(req.params.id, 10);
  if (!Number.isInteger(questionId)) return res.status(400).json({ error: 'بيانات غير صالحة' });

  const body = req.body || {};
  const unexpected = Object.keys(body).filter(k => !QUESTION_EDIT_FIELDS.includes(k));
  if (unexpected.length) return res.status(400).json({ error: 'حقول غير متوقعة: ' + unexpected.join(', ') });

  const { question, choice1, choice2, choice3, choice4, answer_index } = body;
  const reason = (body.reason || '').toString().trim();
  const newChoicesRaw = [choice1, choice2, choice3, choice4];
  if (typeof question !== 'string' || !question.trim())
    return res.status(400).json({ error: 'سؤال غير صالح' });
  if (newChoicesRaw.some(c => typeof c !== 'string' || !c.trim()))
    return res.status(400).json({ error: 'الخيارات غير صالحة' });
  if (!Number.isInteger(answer_index) || answer_index < 0 || answer_index > 3)
    return res.status(400).json({ error: 'إجابة غير صالحة' });
  if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });
  if (reason.length > 500) return res.status(400).json({ error: 'السبب طويل جداً (الحد الأقصى 500 حرف)' });

  const newQuestion = question.trim();
  const newChoices = newChoicesRaw.map(c => c.trim());
  const newAnswer = newChoices[answer_index];
  const newAnswerLetter = ANSWER_LETTERS[answer_index];

  try {
    await withTransaction(async (client) => {
      const r = await client.query(
        `SELECT id, category, difficulty, question, choice1, choice2, choice3, choice4, answer, image_url, active
           FROM questions WHERE id=$1 FOR UPDATE`,
        [questionId]
      );
      const target = r.rows[0];
      if (!target) throw new AdminActionAbort(404, { error: 'السؤال غير موجود' });
      if (target.image_url != null)
        throw new AdminActionAbort(400, { error: 'الأسئلة المصوّرة للمراجعة فقط، لا يمكن تعديلها من هنا' });
      if (!target.active)
        throw new AdminActionAbort(400, { error: 'لا يمكن تعديل سؤال معطّل — أعد تفعيل السؤال أولاً' });

      // question_pending_master_edits.difficulty must be MASTER format (Arabic) --
      // questions.difficulty is DB format (English). An unmapped value here means
      // the column itself holds something unexpected; abort rather than silently
      // writing a value the Excel master doesn't use, which would leave this edit's
      // master-mirror obligation untrackable.
      const difficultyAr = DIFFICULTY_AR[target.difficulty];
      if (!difficultyAr) {
        console.error(`❌ unmapped difficulty "${target.difficulty}" on question ${questionId} — refusing edit, pending-master-edit row would be untrackable`);
        throw new AdminActionAbort(500, { error: 'صعوبة السؤال غير معروفة، تعذر إكمال التعديل' });
      }

      const oldChoices = [target.choice1, target.choice2, target.choice3, target.choice4];
      const oldAnswerIndex = oldChoices.indexOf(target.answer);
      const oldAnswerLetter = ANSWER_LETTERS[oldAnswerIndex] || null;

      await client.query(
        'UPDATE questions SET question=$1, choice1=$2, choice2=$3, choice3=$4, choice4=$5, answer=$6 WHERE id=$7',
        [newQuestion, newChoices[0], newChoices[1], newChoices[2], newChoices[3], newAnswer, questionId]
      );

      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'question_edit',
        targetId: questionId, targetName: target.question,
        beforeValue: JSON.stringify({
          question: target.question, choice1: target.choice1, choice2: target.choice2,
          choice3: target.choice3, choice4: target.choice4, answer: target.answer
        }),
        afterValue: JSON.stringify({
          question: newQuestion, choice1: newChoices[0], choice2: newChoices[1],
          choice3: newChoices[2], choice4: newChoices[3], answer: newAnswer
        }),
        reason
      });

      // Upsert, not insert: if this row already has an outstanding pending edit, the
      // old_* values stay exactly as they were (they describe what the MASTER still
      // has) — only new_* moves forward to this latest edit. Collapses multiple edits
      // before a mirror into a single (master-value) -> (current DB value) delta.
      // difficulty is passed as difficultyAr (already master-format Arabic), NOT
      // target.difficulty (DB-format English) — if the ON CONFLICT SET clause below
      // is ever extended to also update difficulty, source it from EXCLUDED.difficulty
      // (which reflects this same translated value) or from difficultyAr again, never
      // from target.difficulty directly, or this exact bug returns silently.
      await client.query(
        `INSERT INTO question_pending_master_edits
           (question_id, category, difficulty, old_question, new_question,
            old_choice1, new_choice1, old_choice2, new_choice2,
            old_choice3, new_choice3, old_choice4, new_choice4,
            old_answer_letter, new_answer_letter)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (question_id) DO UPDATE SET
           new_question = EXCLUDED.new_question,
           new_choice1 = EXCLUDED.new_choice1, new_choice2 = EXCLUDED.new_choice2,
           new_choice3 = EXCLUDED.new_choice3, new_choice4 = EXCLUDED.new_choice4,
           new_answer_letter = EXCLUDED.new_answer_letter`,
        [questionId, target.category, difficultyAr, target.question, newQuestion,
         target.choice1, newChoices[0], target.choice2, newChoices[1],
         target.choice3, newChoices[2], target.choice4, newChoices[3],
         oldAnswerLetter, newAnswerLetter]
      );

      await client.query(
        `UPDATE question_flags SET resolved=TRUE, resolved_at=now(), resolution='edited'
         WHERE question_id=$1 AND resolved=FALSE`,
        [questionId]
      );
    });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof AdminActionAbort) return res.status(e.status).json(e.body);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Deactivate / reactivate — pulls a question out of round-building rotation (or back
// in) without touching its content. Deliberately NOT automatic from flag state: the
// admin decides what leaves rotation, the review queue never does on its own. `active`
// has no equivalent column in the Excel master (DB-only operational state), so neither
// of these ever touches question_pending_master_edits — there is nothing to mirror.
// Asymmetric on question_flags, on purpose: deactivate does NOT resolve the flag (the
// card must stay on the review screen as the to-do item), reactivate DOES (it's the
// only action that closes a report on an inactive question — see the matching guards
// on /flags/:id/keep and the edit endpoint, which both refuse while active=false).
app.post('/api/admin/questions/:id/deactivate', requireAdmin, async (req, res) => {
  const questionId = parseInt(req.params.id, 10);
  const reason = (req.body?.reason || '').toString().trim();
  if (!Number.isInteger(questionId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });
  if (reason.length > 500) return res.status(400).json({ error: 'السبب طويل جداً (الحد الأقصى 500 حرف)' });
  try {
    await withTransaction(async (client) => {
      const r = await client.query('SELECT id, question, active FROM questions WHERE id=$1 FOR UPDATE', [questionId]);
      const target = r.rows[0];
      if (!target) throw new AdminActionAbort(404, { error: 'السؤال غير موجود' });
      await client.query('UPDATE questions SET active=FALSE WHERE id=$1', [questionId]);
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'question_deactivate',
        targetId: questionId, targetName: target.question,
        beforeValue: String(!!target.active), afterValue: 'false', reason
      });
    });
    res.json({ ok: true, active: false });
  } catch (e) {
    if (e instanceof AdminActionAbort) return res.status(e.status).json(e.body);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/admin/questions/:id/reactivate', requireAdmin, async (req, res) => {
  const questionId = parseInt(req.params.id, 10);
  const reason = (req.body?.reason || '').toString().trim();
  if (!Number.isInteger(questionId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });
  if (reason.length > 500) return res.status(400).json({ error: 'السبب طويل جداً (الحد الأقصى 500 حرف)' });
  try {
    await withTransaction(async (client) => {
      const r = await client.query('SELECT id, question, active FROM questions WHERE id=$1 FOR UPDATE', [questionId]);
      const target = r.rows[0];
      if (!target) throw new AdminActionAbort(404, { error: 'السؤال غير موجود' });
      await client.query('UPDATE questions SET active=TRUE WHERE id=$1', [questionId]);
      await client.query(
        `UPDATE question_flags SET resolved=TRUE, resolved_at=now(), resolution='reactivated'
         WHERE question_id=$1 AND resolved=FALSE`,
        [questionId]
      );
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'question_reactivate',
        targetId: questionId, targetName: target.question,
        beforeValue: String(!!target.active), afterValue: 'true', reason
      });
    });
    res.json({ ok: true, active: true });
  } catch (e) {
    if (e instanceof AdminActionAbort) return res.status(e.status).json(e.body);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// "لا مشكلة" — the reported question is actually fine. Resolves every pending report
// for this question_id, leaves the question itself completely unchanged. Refused
// while the question is deactivated: reactivation is the only path that resolves a
// report on an inactive row (same guard as the edit endpoint) — otherwise this would
// close the report and clear the card while the question stays out of rotation with
// nothing left anywhere marking that it still needs fixing.
app.post('/api/admin/flags/:questionId/keep', requireAdmin, async (req, res) => {
  const questionId = parseInt(req.params.questionId, 10);
  if (!Number.isInteger(questionId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  try {
    await withTransaction(async (client) => {
      const qr = await client.query('SELECT question, active FROM questions WHERE id=$1', [questionId]);
      const target = qr.rows[0];
      if (target && !target.active)
        throw new AdminActionAbort(400, { error: 'لا يمكن إغلاق بلاغ لسؤال معطّل — أعد تفعيل السؤال أولاً' });
      await client.query(
        `UPDATE question_flags SET resolved=TRUE, resolved_at=now(), resolution='ok'
         WHERE question_id=$1 AND resolved=FALSE`,
        [questionId]
      );
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'flag_keep',
        targetId: questionId, targetName: target?.question || null,
        beforeValue: null, afterValue: null, reason: 'marked no issue via triage'
      });
    });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof AdminActionAbort) return res.status(e.status).json(e.body);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Outstanding master-mirror obligations — one row per question with a DB edit not yet
// reflected in the Excel master. Oldest first.
app.get('/api/admin/master-sync', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, question_id, category, difficulty,
             old_question, new_question,
             old_choice1, new_choice1, old_choice2, new_choice2,
             old_choice3, new_choice3, old_choice4, new_choice4,
             old_answer_letter, new_answer_letter, created_at
        FROM question_pending_master_edits
       ORDER BY created_at ASC
    `);
    res.json({ pending: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Confirms a pending edit has been transcribed by hand into the Excel master. Deletes
// the work-queue row — question_pending_master_edits is a queue, not a log; the
// permanent record of the DB edit itself is the question_edit row already in
// admin_actions, which this does not touch.
app.post('/api/admin/master-sync/:id/mirrored', requireAdmin, async (req, res) => {
  const pendingId = parseInt(req.params.id, 10);
  if (!Number.isInteger(pendingId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  try {
    await withTransaction(async (client) => {
      const r = await client.query(
        'SELECT question_id, new_question FROM question_pending_master_edits WHERE id=$1 FOR UPDATE',
        [pendingId]
      );
      const target = r.rows[0];
      if (!target) throw new AdminActionAbort(404, { error: 'لا يوجد سجل بهذا الرقم' });
      await client.query('DELETE FROM question_pending_master_edits WHERE id=$1', [pendingId]);
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'master_mirror_confirmed',
        targetId: target.question_id, targetName: target.new_question,
        beforeValue: null, afterValue: null, reason: 'confirmed mirrored to Excel master'
      });
    });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof AdminActionAbort) return res.status(e.status).json(e.body);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── Player management (admin) ────────────────────────────────────────────────
// Self-protection rules enforced on the SERVER (never trust the client):
//  • The owner (is_super_admin) can never be banned, demoted, or lose super-admin.
//  • Only the owner may adjust the owner's OWN points; no other admin may touch
//    the owner's account at all.
//  • An admin cannot ban or demote themselves (no self-lockout).
//  • Only the owner (super-admin) may promote/demote admins.
const USERS_PAGE_SIZE = 25;

// Searchable, paginated user list. Search matches first/last/full name or email.
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const search = (req.query.search || '').toString().trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * USERS_PAGE_SIZE;
  try {
    let where = '';
    const params = [];
    if (search) {
      params.push('%' + search + '%');
      where = `WHERE (first_name ILIKE $1 OR last_name ILIKE $1
                   OR (first_name || ' ' || last_name) ILIKE $1 OR email ILIKE $1)`;
    }
    const totalR = await pool.query(`SELECT COUNT(*)::int AS c FROM users ${where}`, params);
    const total = totalR.rows[0].c;

    const listParams = params.slice();
    listParams.push(USERS_PAGE_SIZE, offset);
    const r = await pool.query(
      `SELECT id, first_name, last_name, email, total_score, created_at,
              is_admin, is_super_admin, is_banned
         FROM users ${where}
        ORDER BY is_super_admin DESC, is_admin DESC, total_score DESC, id ASC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    const users = r.rows.map(u => {
      const lvl = getLevel(u.total_score || 0);
      return {
        id: u.id,
        name: `${u.first_name} ${u.last_name}`,
        email: u.email,
        points: u.total_score || 0,
        level_name: lvl.name,
        level: lvl.level,
        created_at: u.created_at,
        is_admin: !!u.is_admin,
        is_super_admin: !!u.is_super_admin,
        is_banned: !!u.is_banned
      };
    });
    res.json({ users, total, page, pageSize: USERS_PAGE_SIZE, hasMore: offset + users.length < total });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Adjust points by a SIGNED amount (e.g. +500 / -200). Floors at 0 (never negative)
// and returns the recomputed level. The target row is read-locked (FOR UPDATE) inside
// the same transaction as the write and the admin_actions log — see ADMIN_TARGET_LOCK_SQL
// and withTransaction — so a concurrent write (e.g. endGame crediting this same user at
// round end) can never be silently lost, and before_value is guaranteed accurate.
app.post('/api/admin/users/:id/points', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const amount = parseInt(req.body?.amount, 10);
  const reason = (req.body?.reason || '').toString().trim();
  if (!Number.isInteger(targetId) || !Number.isInteger(amount))
    return res.status(400).json({ error: 'بيانات غير صالحة' });
  if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });
  if (reason.length > 500) return res.status(400).json({ error: 'السبب طويل جداً (الحد الأقصى 500 حرف)' });
  try {
    const result = await withTransaction(async (client) => {
      const r = await client.query(ADMIN_TARGET_LOCK_SQL, [targetId]);
      const target = r.rows[0];
      if (!target) throw new AdminActionAbort(404, { error: 'المستخدم غير موجود' });
      // Regular (non-owner) admins may only act on non-admin players. Only the owner
      // may touch any admin/owner account (including their own).
      if ((target.is_admin || target.is_super_admin) && !req.isSuperAdmin)
        throw new AdminActionAbort(403, { error: 'لا يمكنك تعديل حساب مشرف' });
      const before = target.total_score || 0;
      const newPoints = Math.max(0, before + amount);
      await client.query('UPDATE users SET total_score=$1 WHERE id=$2', [newPoints, targetId]);
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'points_adjust',
        targetId, targetName: `${target.first_name} ${target.last_name}`,
        beforeValue: String(before), afterValue: String(newPoints), reason
      });
      const lvl = getLevel(newPoints);
      return { points: newPoints, level_name: lvl.name, level: lvl.level };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AdminActionAbort) return res.status(e.status).json(e.body);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Ban: block future logins/sockets and kick any live session immediately. kickUser is
// an in-memory socket operation, so it stays OUTSIDE the transaction, run only after
// the ban + log have committed.
app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const reason = (req.body?.reason || '').toString().trim();
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });
  if (reason.length > 500) return res.status(400).json({ error: 'السبب طويل جداً (الحد الأقصى 500 حرف)' });
  try {
    await withTransaction(async (client) => {
      const r = await client.query(ADMIN_TARGET_LOCK_SQL, [targetId]);
      const target = r.rows[0];
      if (!target) throw new AdminActionAbort(404, { error: 'المستخدم غير موجود' });
      if (target.is_super_admin) throw new AdminActionAbort(403, { error: 'لا يمكن حظر المالك' });
      // Regular (non-owner) admins may only ban non-admin players.
      if (target.is_admin && !req.isSuperAdmin) throw new AdminActionAbort(403, { error: 'لا يمكنك حظر مشرف' });
      if (req.adminId === targetId) throw new AdminActionAbort(403, { error: 'لا يمكنك حظر نفسك' });
      await client.query('UPDATE users SET is_banned=TRUE WHERE id=$1', [targetId]);
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'ban',
        targetId, targetName: `${target.first_name} ${target.last_name}`,
        beforeValue: String(!!target.is_banned), afterValue: 'true', reason
      });
    });
    kickUser(targetId);
    res.json({ ok: true, is_banned: true });
  } catch (e) {
    if (e instanceof AdminActionAbort) return res.status(e.status).json(e.body);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Unban: restore login/socket access.
app.post('/api/admin/users/:id/unban', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const reason = (req.body?.reason || '').toString().trim();
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });
  if (reason.length > 500) return res.status(400).json({ error: 'السبب طويل جداً (الحد الأقصى 500 حرف)' });
  try {
    await withTransaction(async (client) => {
      const r = await client.query(ADMIN_TARGET_LOCK_SQL, [targetId]);
      const target = r.rows[0];
      if (!target) throw new AdminActionAbort(404, { error: 'المستخدم غير موجود' });
      // Regular (non-owner) admins may only act on non-admin players.
      if ((target.is_admin || target.is_super_admin) && !req.isSuperAdmin)
        throw new AdminActionAbort(403, { error: 'لا يمكنك تعديل حساب مشرف' });
      await client.query('UPDATE users SET is_banned=FALSE WHERE id=$1', [targetId]);
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'unban',
        targetId, targetName: `${target.first_name} ${target.last_name}`,
        beforeValue: String(!!target.is_banned), afterValue: 'false', reason
      });
    });
    res.json({ ok: true, is_banned: false });
  } catch (e) {
    if (e instanceof AdminActionAbort) return res.status(e.status).json(e.body);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Promote to admin — OWNER ONLY. Never grants super-admin (owner stays the sole one).
app.post('/api/admin/users/:id/promote', requireAdmin, async (req, res) => {
  if (!req.isSuperAdmin) return res.status(403).json({ error: 'صلاحية المالك مطلوبة' });
  const targetId = parseInt(req.params.id, 10);
  const reason = (req.body?.reason || '').toString().trim();
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });
  if (reason.length > 500) return res.status(400).json({ error: 'السبب طويل جداً (الحد الأقصى 500 حرف)' });
  try {
    await withTransaction(async (client) => {
      const r = await client.query(ADMIN_TARGET_LOCK_SQL, [targetId]);
      const target = r.rows[0];
      if (!target) throw new AdminActionAbort(404, { error: 'المستخدم غير موجود' });
      await client.query('UPDATE users SET is_admin=TRUE WHERE id=$1', [targetId]);
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'promote',
        targetId, targetName: `${target.first_name} ${target.last_name}`,
        beforeValue: String(!!target.is_admin), afterValue: 'true', reason
      });
    });
    res.json({ ok: true, is_admin: true });
  } catch (e) {
    if (e instanceof AdminActionAbort) return res.status(e.status).json(e.body);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Demote an admin — OWNER ONLY. The owner can't be demoted; admins can't demote
// themselves. The owner is never demotable, so there's always ≥1 super-admin.
app.post('/api/admin/users/:id/demote', requireAdmin, async (req, res) => {
  if (!req.isSuperAdmin) return res.status(403).json({ error: 'صلاحية المالك مطلوبة' });
  const targetId = parseInt(req.params.id, 10);
  const reason = (req.body?.reason || '').toString().trim();
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });
  if (reason.length > 500) return res.status(400).json({ error: 'السبب طويل جداً (الحد الأقصى 500 حرف)' });
  try {
    await withTransaction(async (client) => {
      const r = await client.query(ADMIN_TARGET_LOCK_SQL, [targetId]);
      const target = r.rows[0];
      if (!target) throw new AdminActionAbort(404, { error: 'المستخدم غير موجود' });
      if (target.is_super_admin) throw new AdminActionAbort(403, { error: 'لا يمكن إزالة صلاحية المالك' });
      if (req.adminId === targetId) throw new AdminActionAbort(403, { error: 'لا يمكنك إزالة صلاحياتك' });
      await client.query('UPDATE users SET is_admin=FALSE WHERE id=$1', [targetId]);
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'demote',
        targetId, targetName: `${target.first_name} ${target.last_name}`,
        beforeValue: String(!!target.is_admin), afterValue: 'false', reason
      });
    });
    res.json({ ok: true, is_admin: false });
  } catch (e) {
    if (e instanceof AdminActionAbort) return res.status(e.status).json(e.body);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Audit trail — read-only, newest first, capped at 200 rows + a total count so the UI
// can show how many are hidden. Actor/target names are resolved twice: the LEFT JOIN's
// CURRENT name is preferred, falling back to the actor_name/target_name snapshot taken
// at insert time so the log stays readable after a user is renamed or deleted.
//
// The target join is restricted to the five user-management actions. target_id means
// different things for different action types now (a users.id for ban/promote/etc.,
// a questions.id for question_edit/question_deactivate/question_reactivate/flag_keep/etc.) — joining
// unconditionally against `users` would occasionally match a question id that happens
// to collide with an unrelated user id and show the wrong name. For every other action
// type the join is meant to miss, falling back to the stored snapshot exactly as
// designed.
app.get('/api/admin/actions', requireAdmin, async (req, res) => {
  try {
    const totalR = await pool.query('SELECT COUNT(*)::int AS c FROM admin_actions');
    const total = totalR.rows[0].c;
    const r = await pool.query(`
      SELECT aa.id, aa.action, aa.target_id, aa.actor_name, aa.target_name,
             aa.before_value, aa.after_value, aa.reason, aa.created_at,
             actor.first_name  AS actor_first,  actor.last_name  AS actor_last,
             target.first_name AS target_first, target.last_name AS target_last
        FROM admin_actions aa
        LEFT JOIN users actor  ON actor.id  = aa.actor_id
        LEFT JOIN users target ON target.id = aa.target_id
                               AND aa.action IN ('points_adjust','ban','unban','promote','demote')
       ORDER BY aa.id DESC
       LIMIT 200
    `);
    const actions = r.rows.map(row => ({
      id: row.id,
      action: row.action,
      actor_name: (row.actor_first ? `${row.actor_first} ${row.actor_last}` : null) || row.actor_name,
      target_id: row.target_id,
      target_name: (row.target_first ? `${row.target_first} ${row.target_last}` : null) || row.target_name,
      before_value: row.before_value,
      after_value: row.after_value,
      reason: row.reason,
      created_at: row.created_at
    }));
    res.json({ actions, total });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

const FLAG_RATE_LIMIT_PER_HOUR = 10;

// Player flags a problematic question, identified by questions.id — never trusted as
// client-supplied text. Validated, in order, against what the server itself knows was
// actually served to THIS player in THIS room this game:
//   1. question_id/code well-typed
//   2. rooms[code] exists
//   3. the flagging user is (or was) a player in that room
//   4. question_id is in that room's servedQuestionIds (accumulated the whole game,
//      not just the current question — see askQuestion)
// A report arriving after the room has already been cleaned up is rejected outright,
// by design — once the room is gone there is no way to verify same-room-serving, and
// accepting an unverifiable claim would reopen the client-controlled-target hole this
// closes. Idempotent per (question_id, user_id) via ON CONFLICT. Rate-limited per user
// to stop the queue being flooded with arbitrary served ids.
app.post('/api/flag-question', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'غير مصرح' });

  const { question_id, code } = req.body || {};
  if (!Number.isInteger(question_id)) return res.status(400).json({ error: 'سؤال غير صالح' });
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'بيانات غير صالحة' });

  const room = rooms[code];
  if (!room) return res.status(400).json({ error: 'الغرفة غير موجودة' });
  if (!room.players[payload.id]) return res.status(403).json({ error: 'لست عضواً في هذه الغرفة' });
  if (!room.servedQuestionIds.has(question_id)) return res.status(400).json({ error: 'لم يُعرض هذا السؤال في هذه الغرفة' });

  try {
    const recent = await pool.query(
      `SELECT COUNT(*)::int AS c FROM question_flags WHERE user_id=$1 AND created_at > now() - interval '1 hour'`,
      [payload.id]
    );
    if (recent.rows[0].c >= FLAG_RATE_LIMIT_PER_HOUR) {
      return res.status(429).json({ error: 'وصلت للحد الأقصى من البلاغات، حاول لاحقاً' });
    }
    await pool.query(
      `INSERT INTO question_flags (question_id, user_id) VALUES ($1,$2)
       ON CONFLICT (question_id, user_id) DO NOTHING`,
      [question_id, payload.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// FIX #3: Special prompt for logos category
async function generateQuestions(categories, difficulty, count = 12) {
  const diffAr = { easy:'متوسط', medium:'صعب', hard:'صعب جداً' }[difficulty];
  const catStr = Array.isArray(categories) ? categories.join(' و ') : categories;
  const isLogos = Array.isArray(categories)
    ? categories.some(c => c.includes('شعار'))
    : catStr.includes('شعار');

  let prompt;
  if (isLogos) {
    prompt = `أنت مولّد أسئلة تريفيا متخصص في الشعارات. اطرح ${count} سؤال عن شعارات الشركات باللغة العربية بمستوى "${diffAr}".

لكل سؤال:
- اكتب وصفاً دقيقاً للشعار (الشكل، الألوان، العناصر المرئية) بدون ذكر اسم الشركة
- الخيارات هي أسماء شركات محتملة
- الإجابات الخاطئة يجب أن تكون شركات معروفة في نفس المجال

مثال:
{"question":"شعار يتميز بتفاحة ناقصة اللقمة باللون الرمادي اللامع على خلفية بيضاء","options":["أ. سامسونج","ب. آبل","ج. هواوي","د. سوني"],"answer":"ب. آبل","logo_question":true}

رد فقط بـ JSON array بدون أي نص إضافي.`;
  } else {
    prompt = `أنت مولّد أسئلة تريفيا متخصص. اطرح ${count} سؤال من فئة/فئات "${catStr}" بمستوى صعوبة "${diffAr}" باللغة العربية.

قواعد مهمة:
- الأسئلة يجب أن تكون غير متوقعة وتحتاج معرفة حقيقية
- الإجابات الخاطئة يجب أن تكون منطقية ومقنعة وليست واضحة
- لا تضع اسم الشيء نفسه ضمن إجاباته
- المموهات من نفس الفئة المنطقية للإجابة الصحيحة

رد فقط بـ JSON array:
[{"question":"نص السؤال","options":["أ. خيار1","ب. خيار2","ج. خيار3","د. خيار4"],"answer":"أ. خيار1"}]
تأكد أن answer هو نفس نص أحد elements في options حرفياً.`;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role:'user', content:prompt }] })
  });
  const data = await response.json();
  const raw = data.content?.map(b => b.text||'').join('') || '[]';
  const questions = JSON.parse(raw.replace(/```json|```/g,'').trim());

  // FIX #2: Shuffle all questions' options
  return questions.map(q => {
    const shuffled = shuffleOptions(q.options, q.answer);
    return { ...q, options: shuffled.options, answer: shuffled.answer };
  });
}

// ── Question bank (Supabase `questions` table) ───────────────────────────────
// Fisher–Yates copy — randomizes the 4 image tile positions (text uses shuffleOptions).
function shuffle(arr){ const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Map a DB row to the internal question object the game already emits. `id` is kept for
// per-game no-repeat tracking (never emitted). The four positions are shuffled;
// correctness stays BY VALUE (the `answer` column), so the shuffle never affects scoring.
function mapQuestionRow(row){
  const choices = [row.choice1, row.choice2, row.choice3, row.choice4];
  if (row.is_image) {
    return { id: row.id, question: row.question, images: shuffle(choices), answer: row.answer, is_image: true, image_url: row.image_url };
  }
  // Text: reuse the existing shuffle (also re-applies the أ/ب/ج/د prefixes), matched by value.
  const s = shuffleOptions(choices, row.answer);
  return { id: row.id, question: row.question, options: s.options, answer: s.answer, is_image: false, image_url: row.image_url };
}

// Available question count per category at one difficulty, excluding already-used IDs.
// One retry after 300ms on error; a second failure logs loudly (room/diff/cats) and
// falls back to an empty map — the round then degrades exactly as it always did.
async function availabilityByCategory(categories, difficulty, usedArr, ctx = {}){
  const m = new Map();
  for (let attempt = 1; attempt <= 2; attempt++){
    try {
      const r = await pool.query(
        `SELECT category, COUNT(*)::int AS cnt FROM questions
        WHERE active AND difficulty = $1 AND category = ANY($2::text[]) AND id <> ALL($3::int[])
        GROUP BY category`,
        [difficulty, categories, usedArr]
      );
      for (const row of r.rows) m.set(row.category, row.cnt);
      return m;
    } catch (e) {
      if (attempt === 1){
        console.log(`⚠️ availabilityByCategory failed, retrying in 300ms [room=${ctx.code || '?'}, diff=${difficulty}]: ${e.message}`);
        await sleep(300);
      } else {
        console.error(`❌ availabilityByCategory failed twice [room=${ctx.code || '?'}, diff=${difficulty}, cats=${categories.join('،')}]: ${e.message}`);
        if (ctx.failures) ctx.failures.push(`availabilityByCategory(${difficulty})`);
      }
    }
  }
  return m;
}

// Randomly pick `count` rows from the given categories at one difficulty, excluding used IDs.
// One retry after 300ms on error; a second failure logs loudly (room/diff/cats) and
// falls back to [] — the round then degrades exactly as it always did.
async function queryQuestions(categories, difficulty, count, usedArr, ctx = {}){
  if (count <= 0) return [];
  for (let attempt = 1; attempt <= 2; attempt++){
    try {
      const r = await pool.query(
        `SELECT id, is_image, question, choice1, choice2, choice3, choice4, answer, image_url
         FROM questions
        WHERE active AND difficulty = $1 AND category = ANY($2::text[]) AND id <> ALL($3::int[])
        ORDER BY random() LIMIT $4`,
        [difficulty, categories, usedArr, count]
      );
      return r.rows.map(mapQuestionRow);
    } catch (e) {
      if (attempt === 1){
        console.log(`⚠️ queryQuestions failed, retrying in 300ms [room=${ctx.code || '?'}, diff=${difficulty}, cats=${categories.join('،')}]: ${e.message}`);
        await sleep(300);
      } else {
        console.error(`❌ queryQuestions failed twice [room=${ctx.code || '?'}, diff=${difficulty}, cats=${categories.join('،')}]: ${e.message}`);
        if (ctx.failures) ctx.failures.push(`queryQuestions(${categories.join('،')}/${difficulty})`);
      }
    }
  }
  return [];
}

// Weighted allocation of `need` slots across the selected categories:
//   • base 1 per category that has anything available (so each appears at least once)
//   • remaining slots go to the biggest categories first (random tiebreak), one each,
//     capped at 2 per category and at each category's available count.
function allocateSlots(categories, availMap, need){
  const alloc = new Map();
  for (const c of categories) alloc.set(c, (availMap.get(c) || 0) >= 1 ? 1 : 0);
  let left = need - [...alloc.values()].reduce((a, b) => a + b, 0);
  const extra = shuffle(categories.filter(c => alloc.get(c) === 1 && (availMap.get(c) || 0) >= 2))
                  .sort((a, b) => (availMap.get(b) || 0) - (availMap.get(a) || 0));
  for (const c of extra){
    if (left <= 0) break;
    alloc.set(c, 2); left--;
  }
  return alloc;
}

// Build one difficulty round: weight 12 questions across the selected categories,
// excluding IDs already used this game, then (only if enabled, should never happen now)
// fill any genuine shortfall from the AI generator. Mutates `usedIds` with what it picks.
async function buildRound(categories, difficulty, usedIds, ctx = {}){
  const need = QUESTIONS_PER_ROUND[difficulty];
  const used = [...usedIds];
  const availMap = await availabilityByCategory(categories, difficulty, used, ctx);
  const alloc = allocateSlots(categories, availMap, need);
  const picks = await Promise.all(
    categories.filter(c => alloc.get(c) > 0)
              .map(c => queryQuestions([c], difficulty, alloc.get(c), used, ctx))
  );
  let questions = picks.flat();
  questions.forEach(q => { if (q.id != null) usedIds.add(q.id); });   // AI-fallback rows have no id
  // Shortfall detection/logging fires regardless of AI_FALLBACK_ENABLED — a round
  // coming up short of `need` must never be silent just because the fallback that
  // would have filled it happens to be off. Previously this whole block, including the
  // log line, only ran when AI_FALLBACK_ENABLED was true — with it permanently false in
  // production, a thin-bucket shortfall produced fewer than `need` questions with ZERO
  // signal anywhere. This does not add, re-enable, or change fallback behavior at all —
  // the fallback attempt below is still exactly as gated as it always was.
  if (questions.length < need) {
    const gap = need - questions.length;
    console.log(`⚠️ round shortfall: ${questions.length}/${need} [room=${ctx.code || '?'}, diff=${difficulty}, cats=${categories.join('،')}]`);
    if (AI_FALLBACK_ENABLED) {
      let aiCount = 0;
      try {
        const ai = await generateQuestions(categories, difficulty, gap);
        aiCount = ai.length;
        questions = questions.concat(ai);
      }
      catch (e) { console.error(`❌ AI fallback failed [room=${ctx.code || '?'}, diff=${difficulty}]: ${e.message}`); }
      // Fallback usage is always visible in logs, even without a DB error (thin bucket).
      console.log(`ℹ️ AI fallback filled ${aiCount}/${gap} gap of ${need} [room=${ctx.code || '?'}, diff=${difficulty}, cats=${categories.join('،')}]`);
      if (ctx.failures && ctx.failures.length){
        console.error(`❌ Round gap after DB failure [room=${ctx.code || '?'}, diff=${difficulty}] failed=[${ctx.failures.join(', ')}] aiFilled=${aiCount}/${gap}`);
      }
    }
  }
  return shuffle(questions);   // interleave categories instead of grouping them
}

const rooms = {};
function generateCode() { return String(Math.floor(1000+Math.random()*9000)); }

// Was room.phaseNames, copied onto every room even though it's never mutated —
// pure per-room duplication of a constant.
const PHASE_NAMES = ['easy','medium','hard'];

// Flips true inside initDB(), after — in this order — this instance's first
// heartbeat has landed AND the first crash sweep has already run and committed
// (see runCrashSweep()). create_room refuses until then: without the heartbeat
// ordering, a room created the instant dbReady flips could get an attempt row
// whose owner has no heartbeat yet, making it look crash-sweepable to any OTHER
// still-live instance during a deploy's overlap window. join_room/play_again need
// no equivalent gate: rooms={} starts empty every boot, so no room exists to join,
// and play_again requires an existing rooms[code] entry — both are transitively
// blocked by this alone.
let dbReady = false;

// In-memory, not DB-backed on purpose: this counts failures of the very writes
// meant to make refund decisions provable, so it can't depend on those same writes
// working. Exposed on /api/admin/stats (Stage 3).
let attemptRecordFailures = 0;

// Mutates only the fields that must not survive into a new game: sessionScore and
// excludedThisQuestion. Called for a genuinely new player (addOrTakeoverPlayer)
// and for every existing player at play_again. Fixes a real gap: a brand-new
// player's excludedThisQuestion was never explicitly set anywhere before this —
// only ever falsy by accident of being undefined.
function resetPlayerForNewAttempt(player) {
  player.sessionScore = 0;
  player.excludedThisQuestion = false;
  return player;
}

// The single exhaustive field list for a fresh room/attempt — including fields the
// old inline literal never declared at all (currentQuestion, advancing,
// allQuestions, questions, abandonTimer), which only existed in practice because
// some later function happened to touch them first. Anyone adding a new per-attempt
// field later has one place to add it; a durable field (one that should survive
// play_again) requires deliberately adding it to this function's parameter list
// instead — the safer default for a system about to charge money, since an
// accidentally-reset durable field is a minor annoyance and an
// accidentally-carried-forward per-attempt field is a real money bug.
function makeRoom(code, host, categories, players) {
  return {
    code, host, categories, players,
    phase: 0, qIndex: 0, timer: null, status: 'waiting', answered: {},
    hostEditing: false, idleTimer: null, servedQuestionIds: new Set(),
    currentQuestion: null, advancing: false, allQuestions: null, questions: null,
    abandonTimer: null, endTimer: null,
    attemptId: null, chargedWritten: false,
  };
}

// Fire-and-forget, never blocks room creation — the room runs regardless of
// whether this succeeds. Retries once (matching buildRound's existing pattern),
// then gives up loudly. If it never lands, askQuestion's charge write later finds
// room.attemptId still null and skips the charge rather than charge without a
// durable record.
async function insertAttemptRow(room) {
  const code = room.code;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await pool.query(
        'INSERT INTO game_attempts (room_code, host_user_id, owner_instance_id) VALUES ($1,$2,$3) RETURNING id',
        [code, room.host, INSTANCE_ID]
      );
      if (rooms[code] !== room) return;   // stale by the time this resolved
      room.attemptId = r.rows[0].id;
      return;
    } catch (e) {
      if (attempt === 0) { await new Promise(res => setTimeout(res, 300)); continue; }
      console.error(`❌ game_attempts INSERT failed after retry [room=${code}]: ${e.message}`);
      attemptRecordFailures++;
    }
  }
}

// Heartbeat cadence and crash-sweep staleness. Render's deploy timeline (the 60s
// health-check-to-SIGTERM window, shutdown_delay) is NOT part of this derivation —
// a live instance heartbeats every 20s for its whole life, including throughout a
// deploy's overlap window, so the overlap's length is irrelevant to how stale is
// too stale. STALENESS_SECONDS only has to tolerate missed heartbeat ticks: 150s
// is ~7.5x the 20s interval, so several consecutive missed writes are absorbed
// before a live process could ever be mistaken for dead. A late 'crashed' label
// costs nothing; a false one is the exact bug this mechanism exists to fix.
// (The one case where a dying instance stops heartbeating early — SIGTERM clears
// the interval, so it may go quiet for up to shutdown_delay before actually
// exiting — is already handled elsewhere: its rows are marked 'server_shutdown'
// before that point, or, if that write failed too, sweeping them as crashed is
// the correct outcome anyway. Not something this threshold needs to cover.)
const HEARTBEAT_INTERVAL_MS = 20 * 1000;
const STALENESS_SECONDS = 150;
const PERIODIC_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

// Handles for the two recurring timers — started once in initDB() after dbReady
// flips, cleared once in the SIGTERM handler before it does anything else.
// Module-level so both places can reach them.
let heartbeatIntervalHandle = null;
let sweepIntervalHandle = null;

let heartbeatFailureCount = 0;
// Proof of life for THIS process, independent of any room's own activity — a room
// can go quiet for a while during totally normal play; that says nothing about
// whether its owning process has crashed. A failed tick never cancels or
// reschedules the interval itself: the interval is the only clock, so the
// staleness window is "time since the last SUCCESSFUL write," and a single blip
// doesn't shorten it.
async function writeHeartbeat() {
  try {
    await pool.query(
      'INSERT INTO server_instances (instance_id, last_seen) VALUES ($1, NOW()) ON CONFLICT (instance_id) DO UPDATE SET last_seen = NOW()',
      [INSTANCE_ID]
    );
    heartbeatFailureCount = 0;
  } catch (e) {
    heartbeatFailureCount++;
    console.error(`❌ heartbeat write failed (${heartbeatFailureCount} in a row): ${e.message}`);
    if (heartbeatFailureCount === 3) {
      console.error('❌ heartbeat has failed 3 times in a row (~60s) — this instance may be unable to prove itself alive to others');
    }
  }
}

// Run once at boot (awaited, before dbReady flips — see initDB()) and then
// periodically for the process's life. A one-shot boot-only sweep is insufficient
// once the sweep can legitimately skip a row: if a predecessor is correctly
// skipped here as "still alive," and then genuinely crashes a few seconds later,
// nothing would revisit that row until THIS process's own next restart, which
// could be days away. Running periodically closes that gap — caught within
// minutes instead.
//
// Never touches a row this process itself owns, unconditionally, regardless of
// heartbeat freshness — a process always knows its own liveness directly and never
// needs to infer it from a table it might have just failed to write to. A
// transient DB blip that drops a few of THIS process's own heartbeat writes must
// never be able to make it conclude it's dead and sweep its own live games.
async function runCrashSweep() {
  try {
    const sweepResult = await pool.query(
      `UPDATE game_attempts SET end_reason='crashed', ended_at=last_updated_at
       WHERE end_reason IS NULL
         AND owner_instance_id IS DISTINCT FROM $1
         AND NOT EXISTS (
           SELECT 1 FROM server_instances si
           WHERE si.instance_id = game_attempts.owner_instance_id
             AND si.last_seen > NOW() - make_interval(secs => $2)
         )`,
      [INSTANCE_ID, STALENESS_SECONDS]
    );
    if (sweepResult.rowCount > 0) {
      console.log(`⚠️ crash sweep: marked ${sweepResult.rowCount} orphaned attempt(s) as crashed`);
    }
    // Table hygiene only — 24h is vastly larger than STALENESS_SECONDS, so this can
    // never delete a heartbeat row the sweep above would still have treated as
    // fresh. A missing row and a stale row are indistinguishable to the NOT EXISTS
    // check above, so deleting an already-stale one changes nothing about
    // correctness.
    const cleanupResult = await pool.query(
      "DELETE FROM server_instances WHERE last_seen < NOW() - INTERVAL '24 hours'"
    );
    if (cleanupResult.rowCount > 0) {
      console.log(`🧹 removed ${cleanupResult.rowCount} stale server_instances row(s)`);
    }
  } catch (e) {
    console.error(`❌ crash sweep failed: ${e.message}`);
  }
}

// Render sends SIGTERM before a restart (a normal `git push` deploy, which happens
// constantly on this project) specifically so a process can do cleanup like this.
// Marks every attempt this process still had open as 'server_shutdown' — distinct
// from 'crashed', so a routine deploy is never mistaken for one. Must genuinely
// await the write before exiting: process.exit() does not wait for pending async
// work on its own, so exiting without awaiting would fire the UPDATE and then kill
// the process before it lands, most of the time. Raced against a self-imposed
// timeout so a hung/unreachable DB still lets the process exit on its own terms
// rather than waiting to be force-killed with zero opportunity to log anything —
// on timeout this falls through to the next boot's crash sweep, same as a real
// crash, which is an acceptable outcome. A hard kill (SIGKILL/OOM) gets no signal
// at all and always falls through to the sweep — this handler can't do anything
// about that, by design of what SIGKILL means.
const SIGTERM_WRITE_TIMEOUT_MS = 3000;   // comfortably inside Render's own
                                          // SIGTERM→SIGKILL grace period — worth
                                          // confirming the actual value in Render's
                                          // docs/dashboard, not assumed here
process.on('SIGTERM', async () => {
  console.log('⚠️ SIGTERM received — marking live attempts as server_shutdown');
  // Cleared FIRST, before anything else: a heartbeat tick firing mid-shutdown would
  // refresh last_seen for a process that's about to die, making it look alive to
  // every OTHER instance's crash sweep for up to another STALENESS_SECONDS. The
  // sweep interval is cleared too, purely for tidiness — nothing correctness-
  // critical depends on stopping it, but there's no reason to leave a timer running
  // that competes with the SIGTERM write for the same tight time budget.
  if (heartbeatIntervalHandle) clearInterval(heartbeatIntervalHandle);
  if (sweepIntervalHandle) clearInterval(sweepIntervalHandle);
  if (maintenanceRefreshIntervalHandle) clearInterval(maintenanceRefreshIntervalHandle);
  const liveAttemptIds = Object.values(rooms).map(r => r.attemptId).filter(Boolean);
  if (liveAttemptIds.length) {
    try {
      const result = await Promise.race([
        pool.query(
          "UPDATE game_attempts SET end_reason='server_shutdown', ended_at=NOW() WHERE id = ANY($1) AND end_reason IS NULL",
          [liveAttemptIds]
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('SIGTERM write timed out')), SIGTERM_WRITE_TIMEOUT_MS)),
      ]);
      // rowCount, not liveAttemptIds.length — a row already claimed by another
      // instance's crash sweep (the exact race this whole design exists to close)
      // matches zero rows here with no error, which the old code couldn't tell
      // apart from success. A mismatch is itself a signal something else claimed
      // the row first and is worth knowing about, not silently swallowed.
      console.log(`✅ SIGTERM write: marked ${result.rowCount}/${liveAttemptIds.length} attempt(s) as server_shutdown`);
      if (result.rowCount < liveAttemptIds.length) {
        console.warn(`⚠️ ${liveAttemptIds.length - result.rowCount} attempt(s) were already resolved by something else before this write landed`);
      }
    } catch (e) {
      console.error(`❌ SIGTERM attempt-marking failed or timed out — falling through to next boot's sweep: ${e.message}`);
    }
  }
  // Deliberately NOT deleting this instance's server_instances row here. Once the
  // UPDATE above has landed, none of this instance's game_attempts rows are open
  // any more, so nothing depends on this row's freshness — its eventual staleness
  // (or the periodic 24h cleanup) is harmless either way. Deleting it would only
  // add a second query racing the same tight timeout budget, and doing so BEFORE
  // (or concurrently with) the UPDATE above would reopen a smaller version of the
  // exact bug this handler exists to fix: a window where this instance looks dead
  // (no heartbeat row) while its rows are still open, visible to any OTHER
  // instance's periodic sweep.
  process.exit(0);   // only reached after the await above resolves or times out
});

// Maintenance mode is DB-backed so flipping it takes effect without a redeploy --
// a redeploy drops every in-memory room, which used to mean turning maintenance ON
// to stop new games also killed the games already running. Cached in-process and
// refreshed on a timer (never queried per socket event) so a toggle costs nothing
// on the hot path.
const MAINTENANCE_CACHE_REFRESH_MS = 10 * 1000;
// The admin toggle endpoint updates this SAME variable synchronously the instant
// its transaction commits -- so in the normal single-instance steady state (see
// CLAUDE.md, Environment & deploys) the toggle is effectively instant for all
// traffic, since there's only one process and it just wrote through itself. The
// periodic refresh below is a safety net for a SECOND instance still holding live
// traffic during a deploy's ~60s overlap window (confirmed 2026-08-23/24) -- that
// instance keeps serving its last-cached value for up to
// MAINTENANCE_CACHE_REFRESH_MS after the toggle, not instantly.
let maintenanceCache = { enabled: MAINTENANCE_ENV_FALLBACK };
let maintenanceRefreshFailureCount = 0;
let maintenanceRefreshIntervalHandle = null;
function isMaintenanceOn() { return maintenanceCache.enabled; }

// A FAILED read changes nothing -- the cache keeps serving its last known-good
// value, which until the very first successful read is still the env-var seed
// above. Deliberately not a fail-open/fail-closed choice: a transient blip is
// invisible to players, and a DB outage that never recovers falls back to
// whatever the env var says, indefinitely -- the "emergency override" role the
// env var keeps now that the DB is the normal source of truth.
// Logged loudly after 3 consecutive failures, same pattern as writeHeartbeat's
// heartbeatFailureCount -- without this, a sustained refresh failure is silent: an
// admin flips the toggle, the write succeeds, but this process keeps serving a
// stale cached value for hours with nothing anywhere saying so.
async function refreshMaintenanceCache() {
  try {
    const r = await pool.query('SELECT enabled FROM maintenance_state WHERE id=1');
    if (r.rows[0]) maintenanceCache = { enabled: r.rows[0].enabled };
    maintenanceRefreshFailureCount = 0;
  } catch (e) {
    maintenanceRefreshFailureCount++;
    console.error(`❌ maintenance cache refresh failed (${maintenanceRefreshFailureCount} in a row): ${e.message}`);
    if (maintenanceRefreshFailureCount === 3) {
      console.error('❌ maintenance cache has failed to refresh 3 times in a row (~30s) -- serving a possibly stale value; an admin toggle may not be taking effect on this instance');
    }
  }
}

io.use((socket, next) => {
  const payload = verifyToken(socket.handshake.auth.token);
  if (!payload) return next(new Error('غير مصرح'));
  pool.query('SELECT * FROM users WHERE id=$1', [payload.id]).then(r => {
    if (!r.rows[0]) return next(new Error('غير موجود'));
    // Banned accounts cannot open new sockets. Re-checked on every connection
    // (the JWT itself stays valid for 30 days), so a ban blocks reconnection.
    if (r.rows[0].is_banned) return next(new Error('محظور'));
    socket.user = safeUser(r.rows[0]);
    socket.isAdmin = !!r.rows[0].is_admin;   // captured from the row already fetched (for maintenance mode)
    next();
  }).catch(() => next(new Error('خطأ')));
});

io.on('connection', socket => {
  socket.on('create_room', ({ categories }) => {
    // See dbReady's own comment — this closes the boot-sweep race: no fresh attempt
    // row can be inserted until the sweep has already run and committed.
    if (!dbReady) return socket.emit('error_msg', 'الخادم لا يزال يجهز، حاول خلال لحظات');
    if (isMaintenanceOn() && !socket.isAdmin) {
      return socket.emit('maintenance_blocked', 'اللعبة قيد الصيانة حالياً، حاول لاحقاً');
    }
    // Enforce 6–12 categories on the server too (mirrors the client check).
    if (!Array.isArray(categories) || categories.length < 6 || categories.length > 12) {
      return socket.emit('error_msg', 'اختر من ٦ إلى ١٢ فئة');
    }
    // One account, one room: a brand-new code can't already be in `rooms`, so
    // any membership found here is unambiguously a DIFFERENT room — evict it.
    leaveOtherRooms(socket);
    const code = generateCode();
    rooms[code] = makeRoom(code, socket.user.id, categories, {});
    addOrTakeoverPlayer(rooms[code], socket);
    socket.emit('room_created', { code, categories });
    io.to(code).emit('players_update', getPlayers(code));
    resetRoomIdleTimer(code);
    insertAttemptRow(rooms[code]);
  });

  socket.on('join_room', ({ code }) => {
    const room = rooms[code];
    const uid = socket.user.id;
    // Someone already IN this room (by user id) is allowed back in even
    // after the game has started — everyone else still gets the usual
    // rejection. No new player may enter a started game.
    const isReturningPlayer = !!room && room.status !== 'waiting' && !!room.players[uid];
    // Maintenance blocks only a genuinely NEW join — never a player already on
    // this room's roster reconnecting to a game that's still running. Gating this
    // ahead of isReturningPlayer would strand an already-charged, already-playing
    // user exactly when they most need to get back in.
    if (isMaintenanceOn() && !socket.isAdmin && !isReturningPlayer) {
      return socket.emit('maintenance_blocked', 'اللعبة قيد الصيانة حالياً، حاول لاحقاً');
    }
    // A room mid-cleanup (room.endTimer is only ever set in the post-game
    // window, awaiting play_again or its 120s auto-delete) is treated as
    // gone for join/rejoin purposes too — same message as not existing.
    if (!room || room.endTimer) return socket.emit('error_msg', 'الغرفة غير موجودة');
    if (room.status !== 'waiting' && !isReturningPlayer) {
      return socket.emit('error_msg', 'اللعبة بدأت');
    }
    // One account, one room: drop membership in any OTHER room first. Excluding
    // `code` itself means rejoining THIS room never hits this path — that stays
    // the takeover flow in addOrTakeoverPlayer below, untouched.
    leaveOtherRooms(socket, code);
    addOrTakeoverPlayer(room, socket);
    if (room.status === 'waiting') {
      // hostEditing lets a player who joins mid-edit see the dimmed grid +
      // indicator immediately, instead of only finding out on the next broadcast.
      socket.emit('room_joined', { code, categories:room.categories, host:room.host, hostEditing:!!room.hostEditing });
    } else {
      const wasFullyAbandoned = !!room.abandonTimer;   // checked BEFORE resumeAbandonedRoom clears it
      resumeAbandonedRoom(room);
      sendRejoinState(room, socket);
      if (room.attemptId) {
        pool.query(
          'INSERT INTO game_attempt_events (attempt_id, user_id, event_type, phase, question_index, detail) VALUES ($1,$2,$3,$4,$5,$6)',
          [room.attemptId, uid, 'rejoined', room.phase, room.qIndex, JSON.stringify({ was_fully_abandoned: wasFullyAbandoned })]
        ).catch(e => console.error(`❌ event write failed [room=${code}]: ${e.message}`));
      }
      // In-game presence banner for everyone ELSE in the room — socket.to()
      // (not io.to()) so the rejoining player is never told they rejoined.
      // gender never leaves the server: only the already-conjugated verb does.
      socket.to(code).emit('player_presence', {
        display_name: room.players[uid].display_name,
        verb: room.players[uid].gender === 'female' ? 'انضمت' : 'انضم',
        type: 'join'
      });
    }
    io.to(code).emit('players_update', getPlayers(code));
    resetRoomIdleTimer(code);
  });

  // Side-effect-free peek for the client's automatic rejoin prompt: does a
  // stored code from a previous session still point at something this user
  // could actually rejoin? Mirrors join_room's own real gate exactly (same
  // three conditions: exists, in progress, still a member) so the answer is
  // a true prediction — but the response is a bare boolean either way, no
  // room details, so a dead/foreign code leaks nothing about what it was.
  socket.on('check_rejoin', ({ code }) => {
    const room = rooms[code];
    const available = !!room && room.status !== 'waiting' && !room.endTimer && !!room.players[socket.user.id];
    // Same reordering as join_room: only a non-returning caller can be blocked by
    // maintenance. available already IS exactly that "is this a genuine returning
    // player" predicate, so it's reused directly — still leaks nothing about a
    // dead/foreign code either way, maintenance or not.
    if (isMaintenanceOn() && !socket.isAdmin && !available) {
      return socket.emit('maintenance_blocked', 'اللعبة قيد الصيانة حالياً، حاول لاحقاً');
    }
    socket.emit('rejoin_available', { available });
  });

  // Host entered the category-selection screen from the lobby's "رجوع" — tell
  // everyone else so they can show the "host is editing" indicator.
  socket.on('edit_categories_start', () => {
    const code = socket.roomCode; const room = rooms[code];
    if (!room || room.host !== socket.user.id) return;
    room.hostEditing = true;
    socket.to(code).emit('host_editing_start');
  });

  // Host edited categories from the lobby-back screen and saved — update the SAME
  // room in place (code and players unchanged) and push the new list live. This is
  // also one of the "editing ended" paths — the client clears its own indicator
  // when it gets categories_updated, so no separate host_editing_end is needed here.
  socket.on('update_room_categories', ({ categories }) => {
    const code = socket.roomCode; const room = rooms[code];
    if (!room || room.host !== socket.user.id) return;
    if (!Array.isArray(categories) || categories.length < 6 || categories.length > 12) {
      return socket.emit('error_msg', 'اختر من 6 إلى 12 فئة');
    }
    room.categories = categories;
    room.hostEditing = false;
    io.to(code).emit('categories_updated', { categories });
    resetRoomIdleTimer(code);
  });

  // "خروج من الغرفة" for a non-host, and also the host's own deliberate exit
  // (backFromCreate now confirms then emits this same event) — leaving is
  // always a handoff, never a close; the room persists via removePlayerFromRoom.
  // This handler adds the two steps specific to a socket that's still alive to
  // run them itself (disconnect can't, since the socket is already gone).
  socket.on('leave_room', () => {
    const code = socket.roomCode; const room = rooms[code];
    if (!code || !room) return;
    if (room.attemptId) {
      pool.query(
        'INSERT INTO game_attempt_events (attempt_id, user_id, event_type, phase, question_index) VALUES ($1,$2,$3,$4,$5)',
        [room.attemptId, socket.user.id, 'left_voluntarily', room.phase, room.qIndex]
      ).catch(e => console.error(`❌ event write failed [room=${code}]: ${e.message}`));
    }
    socket.leave(code); socket.roomCode = null;
    removePlayerFromRoom(io, socket, code);
  });

  // Play again: reset the SAME room back to a fresh lobby and keep it alive. Goes
  // through makeRoom() rather than field-by-field mutation, and REPLACES rooms[code]
  // rather than mutating the old object in place — which means play_again gets the
  // same `rooms[code] !== room` staleness protection every other async path in this
  // file already relies on, for free. code/host/categories/players carry forward
  // explicitly; everything else is a fresh per-attempt default by construction,
  // including attemptId and chargedWritten, and including servedQuestionIds — a
  // real gap the old field-by-field reset had: it was never cleared here before,
  // so a question served in game 1 stayed valid for a flag report in game 2.
  socket.on('play_again', () => {
    if (isMaintenanceOn() && !socket.isAdmin) {
      return socket.emit('maintenance_blocked', 'اللعبة قيد الصيانة حالياً، حاول لاحقاً');
    }
    const code = socket.roomCode; const oldRoom = rooms[code];
    if (!oldRoom) return socket.emit('error_msg', 'انتهت الغرفة، أنشئ غرفة جديدة');
    if (oldRoom.endTimer) clearTimeout(oldRoom.endTimer);
    if (oldRoom.timer) clearInterval(oldRoom.timer);
    // abandonTimer is always already null by this point in every real path (the
    // prior game's own resumeAbandonedRoom/endGame already resolved it) — cleared
    // explicitly anyway rather than relied upon, same principle as makeRoom() itself.
    if (oldRoom.abandonTimer) clearTimeout(oldRoom.abandonTimer);
    Object.values(oldRoom.players).forEach(resetPlayerForNewAttempt);
    rooms[code] = makeRoom(code, oldRoom.host, oldRoom.categories, oldRoom.players);
    const room = rooms[code];
    io.to(code).emit('room_reset', { code, categories: room.categories, host: room.host });
    io.to(code).emit('players_update', getPlayers(code));
    resetRoomIdleTimer(code);
    insertAttemptRow(room);
  });

  socket.on('start_game', async () => {
    const code = socket.roomCode; const room = rooms[code];
    if (!room || room.host !== socket.user.id) return;
    // A lobby that hasn't started is not a game in progress — block it the same
    // as create_room, before anything is mutated, so the room is left exactly as
    // it was (still 'waiting', idle timer untouched) rather than half-transitioned.
    if (isMaintenanceOn() && !socket.isAdmin) {
      return socket.emit('maintenance_blocked', 'اللعبة قيد الصيانة حالياً، حاول لاحقاً');
    }
    clearRoomIdleTimer(room);   // leaving 'waiting' — idle timeout doesn't apply mid-game
    room.status = 'loading';
    io.to(code).emit('game_loading', { message:'جاري تحضير الأسئلة...' });
    try {
      // One per-game used-ID set, threaded through all three rounds so no question
      // repeats (built sequentially so each round excludes earlier rounds' picks).
      const usedIds = new Set();
      const ctx = { code, failures: [] };   // threads the room code into retry/fallback logs
      const easy   = await buildRound(room.categories, 'easy',   usedIds, ctx);
      const medium = await buildRound(room.categories, 'medium', usedIds, ctx);
      const hard   = await buildRound(room.categories, 'hard',   usedIds, ctx);
      // Every player could have disconnected (room torn down) — or even the
      // same 4-digit code reused by an unrelated brand-new room — while
      // these awaits were in flight. Re-check identity before touching room
      // state or starting the game; if it's gone, abort quietly.
      if (rooms[code] !== room) return;
      room.allQuestions = { easy, medium, hard };
      room.status = 'playing'; room.phase = 0;
      if (room.attemptId) {
        try {
          await pool.query(
            'UPDATE game_attempts SET started_at = NOW(), categories = $1 WHERE id = $2',
            [room.categories, room.attemptId]
          );
        } catch (e) {
          console.error(`❌ started_at write failed [room=${code}]: ${e.message}`);
        }
      }
      startPhase(code);
    } catch(e) {
      console.error(e);
      if (rooms[code] !== room) return;   // same staleness check on the failure path
      room.status = 'waiting';
      io.to(code).emit('error_msg', 'خطأ في تحميل الأسئلة');
      resetRoomIdleTimer(code);   // back to 'waiting' — resume idle tracking
    }
  });

  socket.on('submit_answer', ({ answer }) => {
    const code = socket.roomCode; const room = rooms[code];
    if (!room || room.status !== 'playing') return;
    const q = room.currentQuestion;
    const uid = socket.user.id;
    if (!q || room.answered[uid] || room.players[uid].excludedThisQuestion) return;
    room.answered[uid] = true;
    const correct = answer === q.answer;
    const pts = { easy:100, medium:200, hard:300 }[PHASE_NAMES[room.phase]];
    if (correct) room.players[uid].sessionScore += pts;
    // FIX #1: Only send correct_answer AFTER player has answered
    socket.emit('answer_result', { correct, correct_answer:q.answer, points:correct?pts:0 });
    io.to(code).emit('players_update', getPlayers(code));
    maybeAdvanceQuestion(code);
  });

  // A disconnect mid-lobby still removes the player outright (unchanged).
  // Mid-game (status isn't 'waiting'), a dropped connection must not evict
  // the player or block the round — mark them disconnected instead so their
  // score/host status survive and submit_answer/maybeAdvanceQuestion can
  // stop waiting on them. leave_room and kickUser are deliberate exits, not
  // covered here — they keep going through removePlayerFromRoom regardless
  // of room status.
  socket.on('disconnect', () => {
    const code = socket.roomCode; const room = rooms[code];
    if (!code || !room) return;
    if (room.status === 'waiting') removePlayerFromRoom(io, socket, code);
    else markPlayerDisconnected(io, socket, code);
  });
});

function getPlayers(code) {
  // Only the fields the client actually renders (name, level badge, scores,
  // host flag, connection/answered state) — room.players itself still holds
  // the full safeUser() object (email, phone, dob, gender, socketId, …),
  // none of which belongs in a payload broadcast to every other player in
  // the room.
  const room = rooms[code];
  return Object.values(room.players).map(p => ({
    id: p.id, display_name: p.display_name, level: p.level,
    total_score: p.total_score, sessionScore: p.sessionScore,
    isHost: p.id === room.host,
    connected: p.connected,
    answered: !!room.answered[p.id]
  })).sort((a,b) => b.sessionScore-a.sessionScore);
}

// Insert a player into a room, keyed by user id — or, if that user id is
// already present (their previous socket never disconnected cleanly, e.g. a
// refreshed tab racing the old connection's teardown), TAKE OVER the existing
// entry instead of creating a duplicate: sessionScore, host status, and
// answered state are untouched, only the tracked socketId moves to the new
// socket. The superseded socket is force-disconnected — but only after its
// own roomCode is cleared, so ITS disconnect handler sees "not in a room" and
// never reaches removePlayerFromRoom to fight over the entry the new socket
// just took (removePlayerFromRoom's own socketId check is the second layer
// of defense against that race — see there for why both matter).
function addOrTakeoverPlayer(room, socket) {
  const uid = socket.user.id;
  const existing = room.players[uid];
  socket.join(room.code);
  socket.roomCode = room.code;
  if (existing) {
    const oldSocketId = existing.socketId;
    existing.socketId = socket.id;
    existing.connected = true;   // whoever just (re)claimed this uid's slot is, by definition, connected now
    if (oldSocketId && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        oldSocket.roomCode = null;
        oldSocket.leave(room.code);
        oldSocket.disconnect(true);
      }
    }
    return existing;
  }
  const player = resetPlayerForNewAttempt({ ...socket.user, socketId: socket.id, connected: true });
  room.players[uid] = player;
  return player;
}

// A returning player (join_room let them through because they're already in
// room.players) skips the lobby entirely — no room_joined here — and lands
// straight on the question screen in a waiting state until the next question
// actually starts. If a question is currently live and unrevealed, exclude
// them from THAT one only (see maybeAdvanceQuestion / askQuestion's
// per-question reset of the flag). room.advancing being true means we're
// between questions or between phases, where nothing is currently
// answerable by anyone — so a rejoin then needs no exclusion at all, they're
// simply ready in time for whatever's broadcast next.
function sendRejoinState(room, socket) {
  const uid = socket.user.id;
  const midQuestion = room.status === 'playing' && room.currentQuestion && !room.advancing;
  if (midQuestion) room.players[uid].excludedThisQuestion = true;
  const phaseName = DIFFICULTY_AR[PHASE_NAMES[room.phase]] || '';
  socket.emit('rejoined_game', { code: room.code, phase: room.phase + 1, phaseName, isHost: room.host === uid });
}

// A rejoin arriving while the room was abandoned (see markPlayerDisconnected)
// cancels the abandonment countdown and, if a question was frozen mid-flight,
// silently retires it — NOT a reveal: nobody was present to see the
// countdown end, so broadcasting the correct answer now would just hand it
// out for free. question_reset clears any stale per-question UI on a client
// that's still (somehow) showing it, without leaking the answer, then the
// same 2.5s gap as a normal advance before the next question. Whatever
// answers/scores were already recorded before the room emptied out are
// untouched — this only concludes the one question nobody was left to
// finish. The rejoining player does NOT get handed this question to answer
// — sendRejoinState (called right after this) routes them the same way any
// other mid-game rejoin is routed, so they join in properly from the NEXT
// question (room.advancing stays true for the full 2.5s gap, same as a
// normal advance, so they're correctly treated as a between-questions
// rejoin, not excluded from anything).
function resumeAbandonedRoom(room) {
  if (!room.abandonTimer) return;
  clearTimeout(room.abandonTimer);
  room.abandonTimer = null;
  if (room.status !== 'playing' || !room.currentQuestion || room.advancing) return;
  room.advancing = true;
  io.to(room.code).emit('question_reset');
  room.qIndex++;
  setTimeout(() => askQuestion(room.code), 2500);
}

const ROOM_IDLE_MS = 30 * 60 * 1000;
const ROOM_ABANDON_MS = 2 * 60 * 1000;

// Idle-lobby cleanup: a room sitting in 'waiting' with no join/leave/edit
// activity for 30 minutes deletes itself (there's no other way for a
// populated lobby to end now that closing a room is no longer a concept —
// see removePlayerFromRoom). Only meaningful pre-game: start_game clears
// this timer, and endGame's own 120s post-game timer covers the post-game
// case, so calling this while status isn't 'waiting' is always a no-op.
function resetRoomIdleTimer(code) {
  const room = rooms[code];
  if (!room || room.status !== 'waiting') return;
  if (room.idleTimer) clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(() => {
    const r = rooms[code];
    if (!r) return;
    if (r.timer) clearInterval(r.timer);
    if (r.endTimer) clearTimeout(r.endTimer);
    if (r.attemptId) {
      pool.query(
        "UPDATE game_attempts SET end_reason='abandoned_idle_lobby', ended_at=NOW() WHERE id=$1 AND end_reason IS NULL",
        [r.attemptId]
      ).catch(e => console.error(`❌ end_reason write failed [room=${code}]: ${e.message}`));
    }
    delete rooms[code];
  }, ROOM_IDLE_MS);
}

function clearRoomIdleTimer(room) {
  if (room && room.idleTimer) { clearTimeout(room.idleTimer); room.idleTimer = null; }
}

// Shared cleanup for a player leaving a room — called by leave_room (explicit
// exit, including the host's own exit: leaving is now always a handoff, never
// a close), disconnect (unannounced drop), and kickUser (admin ban). Callers
// are responsible for anything specific to how the player left (e.g.
// leave_room's socket.leave/roomCode reset, kickUser's error_msg + forced
// disconnect) — this only touches room state.
//
// CRITICAL: only remove the player if THIS socket is still their current one.
// A takeover (addOrTakeoverPlayer) already force-disconnects the superseded
// socket, which fires ITS OWN 'disconnect' handler — without this check, that
// stale disconnect would delete the entry the new socket just took over,
// kicking the player who simply reconnected. socketId is the source of truth
// for "who currently owns this player slot," not the socket calling in.
function removePlayerFromRoom(io, socket, code) {
  const room = rooms[code];
  if (!room) return;
  const uid = socket.user.id;
  const player = room.players[uid];
  if (!player || player.socketId !== socket.id) return;
  const wasHost = room.host === uid;
  delete room.players[uid];
  if (Object.keys(room.players).length === 0) {
    if (room.timer) clearInterval(room.timer);
    if (room.endTimer) clearTimeout(room.endTimer);
    if (room.idleTimer) clearTimeout(room.idleTimer);
    if (room.attemptId) {
      const reason = (room.status === 'waiting' || room.status === 'loading')
        ? 'all_left_before_start' : 'all_left_midgame';
      pool.query(
        "UPDATE game_attempts SET end_reason=$1, ended_at=NOW() WHERE id=$2 AND end_reason IS NULL",
        [reason, room.attemptId]
      ).catch(e => console.error(`❌ end_reason write failed [room=${code}]: ${e.message}`));
    }
    delete rooms[code];
    return;
  }
  // The host can vanish mid-edit (closed the tab, lost connection, or used
  // "خروج من الغرفة") — make sure the remaining players' "host is editing"
  // indicator doesn't get stuck on.
  if (wasHost && room.hostEditing) {
    room.hostEditing = false;
    io.to(code).emit('host_editing_end');
  }
  if (wasHost) {
    room.host = Number(Object.keys(room.players)[0]);
    io.to(code).emit('host_changed', { host: room.host });
  }
  io.to(code).emit('players_update', getPlayers(code));
  resetRoomIdleTimer(code);
}

// Prevents one account from being a member of two rooms at once (the
// double-spend path: two rooms, two currency charges once that ships).
// Called before create_room/join_room actually add the player anywhere.
// A deliberate create/join elsewhere is a stronger, unambiguous signal than a
// disconnect — disconnects get ROOM_ABANDON_MS of grace because the drop
// might be accidental, but a user actively starting a different room has
// clearly decided not to return to the old one. So this evicts regardless of
// the old room's status (waiting, mid-game, whatever) using the exact same
// removePlayerFromRoom cleanup leave_room already relies on — host
// reassigned, room deleted if they were last, remaining players get the same
// players_update/host_changed broadcast as any ordinary leave. No new
// cleanup logic, just an automatic call to the existing one.
//
// If the stale membership's socket is still alive (e.g. another tab/device
// sitting in that old room), it's notified and disconnected the same way
// kickUser handles a ban — otherwise that tab's UI would silently go stale,
// still showing a room it's no longer part of.
function leaveOtherRooms(socket, exceptCode) {
  const uid = socket.user.id;
  for (const code of Object.keys(rooms)) {
    if (code === exceptCode) continue;
    const room = rooms[code];
    const player = room.players[uid];
    if (!player) continue;
    if (room.attemptId) {
      pool.query(
        'INSERT INTO game_attempt_events (attempt_id, user_id, event_type, phase, question_index) VALUES ($1,$2,$3,$4,$5)',
        [room.attemptId, uid, 'left_for_other_room', room.phase, room.qIndex]
      ).catch(e => console.error(`❌ event write failed [room=${code}]: ${e.message}`));
    }
    const liveSocket = io.sockets.sockets.get(player.socketId);
    removePlayerFromRoom(io, liveSocket || { user: { id: uid }, id: player.socketId }, code);
    if (liveSocket) {
      liveSocket.emit('error_msg', 'تم إخراجك من هذه الغرفة لأنك انضممت لغرفة أخرى');
      liveSocket.disconnect(true);
    }
  }
}

// Mid-game counterpart to removePlayerFromRoom: an unannounced disconnect
// while status isn't 'waiting' must NOT evict the player — their score and
// host status stay exactly where they are, and a rejoin path now exists
// (join_room's mid-game branch + resumeAbandonedRoom) to bring them back.
// Same socketId staleness guard as removePlayerFromRoom, same reasoning
// (see there). Only the actual admin/explicit-leave paths (kickUser,
// leave_room) still fully remove a player regardless of status.
function markPlayerDisconnected(io, socket, code) {
  const room = rooms[code];
  if (!room) return;
  const uid = socket.user.id;
  const player = room.players[uid];
  if (!player || player.socketId !== socket.id) return;
  player.connected = false;
  if (room.attemptId) {
    pool.query(
      'INSERT INTO game_attempt_events (attempt_id, user_id, event_type, phase, question_index) VALUES ($1,$2,$3,$4,$5)',
      [room.attemptId, uid, 'disconnected', room.phase, room.qIndex]
    ).catch(e => console.error(`❌ event write failed [room=${code}]: ${e.message}`));
  }

  const anyoneConnected = Object.values(room.players).some(p => p.connected);
  if (!anyoneConnected) {
    // Not necessarily abandoned for good — a rejoin path exists now, so
    // give everyone ROOM_ABANDON_MS to come back instead of deleting the
    // room outright. Stop the live question timer (nobody's there to
    // answer it — askQuestion won't start a new one either while empty,
    // see there) but leave room.players, scores, and host status intact;
    // resumeAbandonedRoom cancels this and concludes the frozen question
    // when someone does return.
    if (room.timer) { clearInterval(room.timer); room.timer = null; }
    if (room.abandonTimer) clearTimeout(room.abandonTimer);
    room.abandonTimer = setTimeout(() => {
      const r = rooms[code];
      if (!r) return;
      if (r.timer) clearInterval(r.timer);
      if (r.endTimer) clearTimeout(r.endTimer);
      if (r.idleTimer) clearTimeout(r.idleTimer);
      if (r.attemptId) {
        pool.query(
          "UPDATE game_attempts SET end_reason='abandoned_midgame', ended_at=NOW() WHERE id=$1 AND end_reason IS NULL",
          [r.attemptId]
        ).catch(e => console.error(`❌ end_reason write failed [room=${code}]: ${e.message}`));
      }
      delete rooms[code];
    }, ROOM_ABANDON_MS);
    return;
  }

  io.to(code).emit('players_update', getPlayers(code));
  // In-game presence banner for whoever's left. The disconnecting socket is
  // already gone by this point (this runs from the 'disconnect' handler), so
  // io.to() here can never reach them anyway — no explicit exclusion needed,
  // unlike the rejoin side of this event in join_room.
  io.to(code).emit('player_presence', {
    display_name: player.display_name,
    verb: player.gender === 'female' ? 'غادرت' : 'غادر',
    type: 'leave'
  });
  // The player who just dropped might have been the only one left who
  // hadn't answered yet — disconnecting must be able to advance the
  // question just as answering does, or the round would sit until the 15s
  // timer times out even though every remaining connected player is done.
  maybeAdvanceQuestion(code);
}

// Force every live socket of a banned user out of the game. Reuses
// removePlayerFromRoom for the room cleanup (drop the player, reassign host
// or delete an empty room), then disconnects the socket so they can't keep
// playing the current session.
function kickUser(userId) {
  for (const s of io.sockets.sockets.values()) {
    if (!s.user || s.user.id !== userId) continue;
    const room = rooms[s.roomCode];
    if (room && room.attemptId) {
      pool.query(
        'INSERT INTO game_attempt_events (attempt_id, user_id, event_type, phase, question_index) VALUES ($1,$2,$3,$4,$5)',
        [room.attemptId, userId, 'banned_removed', room.phase, room.qIndex]
      ).catch(e => console.error(`❌ event write failed [room=${s.roomCode}]: ${e.message}`));
    }
    removePlayerFromRoom(io, s, s.roomCode);
    s.emit('error_msg', 'تم حظرك من قبل الإدارة');
    s.disconnect(true);
  }
}

function startPhase(code) {
  const room = rooms[code];
  const phaseName = PHASE_NAMES[room.phase];
  room.questions = room.allQuestions[phaseName];
  room.qIndex = 0; room.answered = {};
  const phaseAr = DIFFICULTY_AR[phaseName];
  io.to(code).emit('phase_start', { phase:room.phase+1, name:phaseAr, total:3 });
  if (room.attemptId) {
    pool.query('UPDATE game_attempts SET last_phase_reached = $1 WHERE id = $2', [room.phase, room.attemptId])
      .catch(e => console.error(`❌ last_phase_reached write failed [room=${code}]: ${e.message}`));
  }
  setTimeout(() => askQuestion(code), 3000);
}

function askQuestion(code) {
  const room = rooms[code];
  if (!room || room.status !== 'playing') return;
  if (room.qIndex >= room.questions.length) { endPhase(code); return; }
  const q = room.questions[room.qIndex];
  room.currentQuestion = q; room.answered = {}; room.advancing = false;
  // AI-fallback rows have no id (dead in practice — fallback is retired) — nothing to
  // track for those. Real DB rows always have one, accumulated for the whole game so a
  // flag from later in the game still validates against a question served earlier.
  if (q.id != null) room.servedQuestionIds.add(q.id);
  // Whoever rejoined mid-question was excluded from THAT one only — clear it
  // for everyone (a no-op for anyone who didn't have it set) now that a new
  // question is actually starting, so they're back in the count from here on.
  Object.values(room.players).forEach(p => { p.excludedThisQuestion = false; });
  // The CLAUDE.md-documented charge boundary: the single io.to(code).emit('question', ...)
  // below, for phase 0 / question 0 only. Guarded by chargedWritten so later questions
  // never re-fire it. If attemptId is still null here (the INSERT never landed despite
  // its retry), the charge is skipped rather than fired with no durable record to back
  // it — gameplay is unaffected either way, this is bookkeeping only.
  if (!room.chargedWritten) {
    room.chargedWritten = true;
    if (room.attemptId) {
      const chargedIds = Object.keys(room.players).map(Number);
      pool.query(
        'UPDATE game_attempts SET charged_at = NOW(), charged_user_ids = $1 WHERE id = $2',
        [chargedIds, room.attemptId]
      ).catch(e => console.error(`❌ charged_at write failed [room=${code}, attempt=${room.attemptId}]: ${e.message}`));
    } else {
      console.error(`❌ ATTEMPT RECORD MISSING — CHARGE SKIPPED [room=${code}]`);
      attemptRecordFailures++;
    }
  }
  const pts = { easy:100, medium:200, hard:300 }[PHASE_NAMES[room.phase]];
  io.to(code).emit('question', {
    id:q.id ?? null,
    index:room.qIndex+1, total:room.questions.length,
    question:q.question, options:q.options, points:pts, phase:room.phase+1,
    is_logo:q.logo_question||false,
    is_image:q.is_image||false,
    images:q.images||null,
    image_url:q.image_url||null
  });
  let timeLeft = 15;
  io.to(code).emit('timer', { seconds:timeLeft });
  // The advance timeouts that lead here aren't connectivity-aware and can't
  // be cancelled (no stored id) — so this can still run with zero connected
  // players (e.g. the last one left during the brief gap before this fired).
  // Set the question up as normal (so a rejoin sees accurate state via
  // resumeAbandonedRoom) but don't start a ticking timer nobody's there to
  // see — that would just tick to time_up unattended and keep the cascade
  // going. The room sits frozen here until someone rejoins.
  if (!Object.values(room.players).some(p => p.connected)) return;
  room.timer = setInterval(() => {
    timeLeft--;
    io.to(code).emit('timer', { seconds:timeLeft });
    if (timeLeft <= 0) {
      clearInterval(room.timer);
      // A pre-existing race, unrelated to disconnect handling: a late
      // submit_answer already in flight when time ran out can call
      // maybeAdvanceQuestion right around the same moment this fires.
      // room.advancing is the single flag both paths check-and-set, so
      // whichever gets here first wins and the other is a no-op.
      if (room.advancing) return;
      room.advancing = true;
      io.to(code).emit('time_up', { correct_answer:q.answer });
      room.qIndex++;
      setTimeout(() => askQuestion(code), 2500);
    }
  }, 1000);
}

// Shared by submit_answer (after an answer arrives) and markPlayerDisconnected
// (after a connected player drops) — disconnected players must not block
// advancement, so this must be reachable from BOTH directions: the last
// connected player might finish the round by ANSWERING or by DISCONNECTING.
// Only counts connected players on both sides of the comparison — a
// disconnected player's stale `answered:true` entry (never purged, per
// design) must not inflate the numerator once they're excluded from the
// denominator, or the round could cut off a still-present player early.
//
// room.advancing is a one-shot guard against firing this twice for the same
// question: e.g. the last connected player answers (advancing this question)
// and then immediately disconnects — both paths call this function, and
// without the guard the second call would double-increment qIndex and leak
// the first call's timer (askQuestion overwrites room.timer without clearing
// it). The same flag also protects against the separate, pre-existing race
// with the 15s timer's own time_up branch (see there).
function maybeAdvanceQuestion(code) {
  const room = rooms[code];
  if (!room || room.status !== 'playing' || !room.currentQuestion || room.advancing) return;
  // Connected AND not sitting out this specific question — a player who just
  // rejoined mid-question doesn't count until the NEXT question starts (the
  // flag is cleared for everyone in askQuestion once that happens).
  const eligibleUids = Object.keys(room.players).filter(id => {
    const p = room.players[id];
    return p.connected && !p.excludedThisQuestion;
  });
  const total = eligibleUids.length;
  if (total === 0) return;   // room cleanup (not advancement) handles the all-disconnected case
  const answeredCount = eligibleUids.filter(id => room.answered[id]).length;
  if (answeredCount < total) return;
  room.advancing = true;
  if (room.timer) clearInterval(room.timer);
  const q = room.currentQuestion;
  io.to(code).emit('reveal_answer', { correct_answer:q.answer });
  io.to(code).emit('timer', { seconds:0 });
  room.qIndex++;
  setTimeout(() => askQuestion(code), 2500);
}

function endPhase(code) {
  const room = rooms[code];
  room.phase++;
  if (room.phase >= 3) {
    endGame(code);
  } else {
    // Brief transition message instead of full leaderboard
    io.to(code).emit('phase_transition', { nextPhase: room.phase + 1 });
    setTimeout(() => startPhase(code), 3000);
  }
}

async function endGame(code) {
  const room = rooms[code];
  const leaderboard = getPlayers(code);
  for (const p of leaderboard) {
    const pts = Math.floor(p.sessionScore/100);
    try {
      await pool.query('UPDATE users SET total_score=total_score+$1 WHERE id=$2', [pts, p.id]);
      await pool.query('INSERT INTO game_history (user_id,room_code,score,attempt_id) VALUES ($1,$2,$3,$4)', [p.id, code, p.sessionScore, room.attemptId]);
    } catch (e) {
      // The in-memory game is already over regardless of whether this write lands, and
      // there is nothing sensible to retry against — the room may already be gone by
      // the time a retry would run. The goal is only that a DB hiccup can't take the
      // whole process down with it (this isn't a request handler — there's no response
      // to fail gracefully with), and that the failure is loud, not silent. One
      // player's failed write does not stop the loop: the rest of the leaderboard still
      // gets a chance to persist, and everyone still gets the game_end broadcast below
      // rather than being stuck on a game that will never resolve.
      console.error(`❌ endGame DB write failed [room=${code}, user=${p.id}]: ${e.message}`);
    }
  }
  // Those DB writes are awaited sequentially per player — the room could have
  // been torn down (every player disconnected) while they were in flight, or
  // the same 4-digit code could even have been reused by an unrelated new
  // room. Re-check identity before broadcasting a stale leaderboard to
  // whoever's actually in that room now, or scheduling this room's post-game
  // cleanup timer on a room object that isn't (or is no longer) rooms[code].
  if (rooms[code] !== room) return;
  io.to(code).emit('game_end', { leaderboard });
  if (room.attemptId) {
    pool.query(
      "UPDATE game_attempts SET end_reason='completed', ended_at=NOW() WHERE id=$1 AND end_reason IS NULL",
      [room.attemptId]
    ).catch(e => console.error(`❌ end_reason write failed [room=${code}]: ${e.message}`));
  }
  if (room.endTimer) clearTimeout(room.endTimer);
  room.endTimer = setTimeout(() => { delete rooms[code]; }, 120000);
}

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
