require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'trivia_secret_key_2024';
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// Maintenance mode: when 'true', only admins may create/join/restart games. Unset or
// anything other than 'true' = game fully open (default). Flip via the Render env var.
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true';

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
  `);
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
  const totalUsers   = await count('SELECT COUNT(*)::int AS c FROM users');
  // One game = one room_code (game_history has a row per player), and "today" is
  // measured against Kuwait local midnight (UTC+3, no DST).
  const gamesToday   = await count(
    "SELECT COUNT(DISTINCT room_code)::int AS c FROM game_history " +
    "WHERE (played_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kuwait') >= date_trunc('day', now() AT TIME ZONE 'Asia/Kuwait')"
  );
  const flaggedCount = await count('SELECT COUNT(DISTINCT question_id)::int AS c FROM question_flags WHERE resolved = FALSE');
  const pendingMirrorCount = await count('SELECT COUNT(*)::int AS c FROM question_pending_master_edits');

  res.json({ activeGames, playersOnline, totalUsers, gamesToday, flaggedCount, pendingMirrorCount });
});

const ANSWER_LETTERS = ['A', 'B', 'C', 'D'];

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
// review-and-deactivate only, the fix happens in the master, never here. The fixed
// field list above is the only thing ever read from the body; any other key is
// rejected rather than silently ignored. category/difficulty/image_url/active never
// appear in the UPDATE's column list at all, so this cannot touch them regardless of
// what the request contains. answer_index (0-3) selects by POSITION among the four
// submitted choices — not by matching text — so the master-format letter (A-D) is
// derived directly from that position with no text-matching ambiguity. Writes
// questions, the admin_actions audit row, and the pending-master-edit upsert (see
// question_pending_master_edits) all in ONE transaction, and resolves any pending
// flag reports for this question — the fix has been made.
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
        `SELECT id, category, difficulty, question, choice1, choice2, choice3, choice4, answer, image_url
           FROM questions WHERE id=$1 FOR UPDATE`,
        [questionId]
      );
      const target = r.rows[0];
      if (!target) throw new AdminActionAbort(404, { error: 'السؤال غير موجود' });
      if (target.image_url != null)
        throw new AdminActionAbort(400, { error: 'الأسئلة المصوّرة للمراجعة فقط، لا يمكن تعديلها من هنا' });

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
        [questionId, target.category, target.difficulty, target.question, newQuestion,
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

// Dismiss a flag report (the report was bad) — resolves every pending report for this
// question_id. Touches only question_flags, never questions itself.
app.post('/api/admin/flags/:questionId/dismiss', requireAdmin, async (req, res) => {
  const questionId = parseInt(req.params.questionId, 10);
  if (!Number.isInteger(questionId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  try {
    await withTransaction(async (client) => {
      const qr = await client.query('SELECT question FROM questions WHERE id=$1', [questionId]);
      await client.query(
        `UPDATE question_flags SET resolved=TRUE, resolved_at=now(), resolution='dismissed'
         WHERE question_id=$1 AND resolved=FALSE`,
        [questionId]
      );
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'flag_dismiss',
        targetId: questionId, targetName: qr.rows[0]?.question || null,
        beforeValue: null, afterValue: null, reason: 'dismissed via triage'
      });
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// "لا مشكلة" — the reported question is actually fine. Resolves every pending report
// for this question_id, leaves the question itself completely unchanged.
app.post('/api/admin/flags/:questionId/keep', requireAdmin, async (req, res) => {
  const questionId = parseInt(req.params.questionId, 10);
  if (!Number.isInteger(questionId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  try {
    await withTransaction(async (client) => {
      const qr = await client.query('SELECT question FROM questions WHERE id=$1', [questionId]);
      await client.query(
        `UPDATE question_flags SET resolved=TRUE, resolved_at=now(), resolution='ok'
         WHERE question_id=$1 AND resolved=FALSE`,
        [questionId]
      );
      await logAdminAction(client, {
        actorId: req.adminId, actorName: req.adminName, action: 'flag_keep',
        targetId: questionId, targetName: qr.rows[0]?.question || null,
        beforeValue: null, afterValue: null, reason: 'marked no issue via triage'
      });
    });
    res.json({ ok: true });
  } catch (e) {
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
// a questions.id for question_edit/question_deactivate/flag_dismiss/etc.) — joining
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
    if (MAINTENANCE_MODE && !socket.isAdmin) {
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
    const cats = categories;
    rooms[code] = { code, host:socket.user.id, categories:cats, players:{}, phase:0,
      phaseNames:['easy','medium','hard'], qIndex:0, timer:null, status:'waiting', answered:{},
      hostEditing:false, idleTimer:null,
      // Accumulated across the WHOLE game (not reset per phase) — every question.id
      // actually dispatched in this room. /api/flag-question validates against this,
      // never against a client-supplied id alone, so a player can only flag something
      // that was genuinely served to them here.
      servedQuestionIds:new Set() };
    addOrTakeoverPlayer(rooms[code], socket);
    socket.emit('room_created', { code, categories:cats });
    io.to(code).emit('players_update', getPlayers(code));
    resetRoomIdleTimer(code);
  });

  socket.on('join_room', ({ code }) => {
    if (MAINTENANCE_MODE && !socket.isAdmin) {
      return socket.emit('maintenance_blocked', 'اللعبة قيد الصيانة حالياً، حاول لاحقاً');
    }
    const room = rooms[code];
    // A room mid-cleanup (room.endTimer is only ever set in the post-game
    // window, awaiting play_again or its 120s auto-delete) is treated as
    // gone for join/rejoin purposes too — same message as not existing.
    if (!room || room.endTimer) return socket.emit('error_msg', 'الغرفة غير موجودة');
    const uid = socket.user.id;
    // Someone already IN this room (by user id) is allowed back in even
    // after the game has started — everyone else still gets the usual
    // rejection. No new player may enter a started game.
    const isReturningPlayer = room.status !== 'waiting' && !!room.players[uid];
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
      resumeAbandonedRoom(room);
      sendRejoinState(room, socket);
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
    if (MAINTENANCE_MODE && !socket.isAdmin) {
      return socket.emit('maintenance_blocked', 'اللعبة قيد الصيانة حالياً، حاول لاحقاً');
    }
    const room = rooms[code];
    const available = !!room && room.status !== 'waiting' && !room.endTimer && !!room.players[socket.user.id];
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
    socket.leave(code); socket.roomCode = null;
    removePlayerFromRoom(io, socket, code);
  });

  // Play again: reset the SAME room back to a fresh lobby and keep it alive
  socket.on('play_again', () => {
    if (MAINTENANCE_MODE && !socket.isAdmin) {
      return socket.emit('maintenance_blocked', 'اللعبة قيد الصيانة حالياً، حاول لاحقاً');
    }
    const code = socket.roomCode; const room = rooms[code];
    if (!room) return socket.emit('error_msg', 'انتهت الغرفة، أنشئ غرفة جديدة');
    if (room.endTimer) { clearTimeout(room.endTimer); room.endTimer = null; }
    if (room.timer) { clearInterval(room.timer); room.timer = null; }
    room.status = 'waiting'; room.phase = 0; room.qIndex = 0;
    room.answered = {}; room.currentQuestion = null;
    room.allQuestions = null; room.questions = null;
    room.hostEditing = false; room.advancing = false;
    Object.values(room.players).forEach(p => { p.sessionScore = 0; p.excludedThisQuestion = false; });
    io.to(code).emit('room_reset', { code, categories: room.categories, host: room.host });
    io.to(code).emit('players_update', getPlayers(code));
    resetRoomIdleTimer(code);
  });

  socket.on('start_game', async () => {
    const code = socket.roomCode; const room = rooms[code];
    if (!room || room.host !== socket.user.id) return;
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
    const pts = { easy:100, medium:200, hard:300 }[room.phaseNames[room.phase]];
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
  const player = { ...socket.user, sessionScore:0, socketId: socket.id, connected: true };
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
  const phaseName = { easy:'سهل', medium:'متوسط', hard:'صعب' }[room.phaseNames[room.phase]] || '';
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
    removePlayerFromRoom(io, s, s.roomCode);
    s.emit('error_msg', 'تم حظرك من قبل الإدارة');
    s.disconnect(true);
  }
}

function startPhase(code) {
  const room = rooms[code];
  const phaseName = room.phaseNames[room.phase];
  room.questions = room.allQuestions[phaseName];
  room.qIndex = 0; room.answered = {};
  const phaseAr = { easy:'سهل', medium:'متوسط', hard:'صعب' }[phaseName];
  io.to(code).emit('phase_start', { phase:room.phase+1, name:phaseAr, total:3 });
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
  const pts = { easy:100, medium:200, hard:300 }[room.phaseNames[room.phase]];
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
      await pool.query('INSERT INTO game_history (user_id,room_code,score) VALUES ($1,$2,$3)', [p.id, code, p.sessionScore]);
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
  if (room.endTimer) clearTimeout(room.endTimer);
  room.endTimer = setTimeout(() => { delete rooms[code]; }, 120000);
}

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
