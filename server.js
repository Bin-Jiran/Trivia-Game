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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// Maintenance mode: when 'true', only admins may create/join/restart games. Unset or
// anything other than 'true' = game fully open (default). Flip via the Render env var.
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true';

// Questions come from the Supabase `questions` table. AI generation is now only a
// gap-filler for short rounds. Defaults ON; set the AI_FALLBACK_ENABLED env var to the
// literal string 'false' (in Render's Environment tab) to disable it.
const AI_FALLBACK_ENABLED = process.env.AI_FALLBACK_ENABLED !== 'false';
const QUESTIONS_PER_ROUND = { easy: 12, medium: 12, hard: 12 };

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
  `);
  // Backward-compatible: add new columns to pre-existing tables without touching data.
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE question_flags ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE question_flags ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP');
  await pool.query('ALTER TABLE question_flags ADD COLUMN IF NOT EXISTS resolution TEXT');
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_url TEXT');
  console.log('✅ Database ready');

  // The ADMIN_EMAIL account is the OWNER: it is both admin and super-admin. Idempotent —
  // safe to run every boot. Only this account may promote/demote other admins.
  if (process.env.ADMIN_EMAIL) {
    const r = await pool.query(
      'UPDATE users SET is_admin = TRUE, is_super_admin = TRUE WHERE email = $1',
      [process.env.ADMIN_EMAIL]
    );
    if (r.rowCount > 0) console.log(`👑 Owner (super-admin) privileges ensured for ${process.env.ADMIN_EMAIL}`);
    else console.log(`👑 ADMIN_EMAIL set to ${process.env.ADMIN_EMAIL} — no matching account yet (will apply once they register)`);
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
    const r = await pool.query('SELECT id, is_admin, is_super_admin FROM users WHERE id=$1', [payload.id]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: 'غير موجود' });
    if (!user.is_admin) return res.status(403).json({ error: 'ممنوع' });
    req.adminId = user.id;
    // Super-admin (owner) status, read fresh from the DB. Endpoints that manage
    // admins gate on this; never trust a token claim for it.
    req.isSuperAdmin = !!user.is_super_admin;
    next();
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
}

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

app.post('/api/register', async (req, res) => {
  const { first_name, last_name, phone, email, dob, gender, password } = req.body;
  if (!first_name||!last_name||!phone||!email||!dob||!gender||!password)
    return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
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
  const { email, password } = req.body;
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  const user = r.rows[0];
  if (!user) return res.status(400).json({ error: 'البريد أو كلمة المرور غير صحيحة' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'البريد أو كلمة المرور غير صحيحة' });
  // Banned accounts cannot obtain a fresh session.
  if (user.is_banned) return res.status(403).json({ error: 'تم حظر حسابك. للاستفسار تواصل مع الإدارة.' });
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

app.get('/api/me', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'غير مصرح' });
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [payload.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'غير موجود' });
  res.json({ ...safeUser(r.rows[0]),
    is_admin: r.rows[0].is_admin || false,
    is_super_admin: r.rows[0].is_super_admin || false });
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
  const flaggedCount = await count('SELECT COUNT(DISTINCT question_key)::int AS c FROM question_flags WHERE resolved = FALSE');

  res.json({ activeGames, playersOnline, totalUsers, gamesToday, flaggedCount });
});

// Flagged questions for review. Questions are AI-generated (no master bank), so we
// review the snapshots saved in question_flags. Rows are grouped by question_key:
// one entry per distinct question, with a report count and the earliest report date.
// Pending only (resolved = FALSE), oldest first.
app.get('/api/admin/flags', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT question_key,
             COUNT(*)::int AS report_count,
             MIN(created_at) AS first_reported,
             (ARRAY_AGG(question_text   ORDER BY created_at DESC))[1] AS question_text,
             (ARRAY_AGG(options         ORDER BY (options IS NULL),        created_at DESC))[1] AS options,
             (ARRAY_AGG(correct_answer  ORDER BY (correct_answer IS NULL), created_at DESC))[1] AS correct_answer
      FROM question_flags
      WHERE resolved = FALSE
      GROUP BY question_key
      ORDER BY first_reported ASC
    `);
    const flags = r.rows.map(row => {
      let options = [];
      try { const p = JSON.parse(row.options || '[]'); if (Array.isArray(p)) options = p; } catch (e) { options = []; }
      return {
        id: row.question_key,
        question: row.question_text || '',
        options,
        correct_answer: row.correct_answer || null,
        report_count: row.report_count,
        first_reported: row.first_reported
      };
    });
    res.json({ flags });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Save a corrected version of a flagged question and mark it resolved (leaves the
// pending list). :id is the question_key (the group). Operates on all rows of the group.
app.put('/api/admin/flags/:id', requireAdmin, async (req, res) => {
  const questionKey = req.params.id;
  const { question, options, correct_answer } = req.body || {};
  if (!question || typeof question !== 'string') return res.status(400).json({ error: 'سؤال غير صالح' });
  const optionsJson = Array.isArray(options) ? JSON.stringify(options) : null;
  const correct = (typeof correct_answer === 'string' && correct_answer.length) ? correct_answer : null;
  try {
    const r = await pool.query(
      `UPDATE question_flags
         SET question_text = $1,
             options = $2,
             correct_answer = COALESCE($3, correct_answer),
             resolved = TRUE,
             resolved_at = now(),
             resolution = 'edited'
       WHERE question_key = $4 AND resolved = FALSE`,
      [question, optionsJson, correct, questionKey]
    );
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Dismiss a flagged question (the report was bad). We mark resolved (keep history)
// rather than deleting; the question snapshot is left intact.
app.delete('/api/admin/flags/:id', requireAdmin, async (req, res) => {
  const questionKey = req.params.id;
  try {
    const r = await pool.query(
      `UPDATE question_flags SET resolved = TRUE, resolved_at = now(), resolution = 'dismissed'
       WHERE question_key = $1 AND resolved = FALSE`,
      [questionKey]
    );
    res.json({ ok: true, resolved: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// "لا مشكلة" — the reported question is actually fine. Mark the group resolved and
// leave the question snapshot completely unchanged (no edit, no delete).
app.post('/api/admin/flags/:id/keep', requireAdmin, async (req, res) => {
  const questionKey = req.params.id;
  try {
    const r = await pool.query(
      `UPDATE question_flags SET resolved = TRUE, resolved_at = now(), resolution = 'ok'
       WHERE question_key = $1 AND resolved = FALSE`,
      [questionKey]
    );
    res.json({ ok: true, resolved: r.rowCount });
  } catch (e) {
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
// and returns the recomputed level.
app.post('/api/admin/users/:id/points', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const amount = parseInt(req.body?.amount, 10);
  if (!Number.isInteger(targetId) || !Number.isInteger(amount))
    return res.status(400).json({ error: 'بيانات غير صالحة' });
  try {
    const target = await getUserRow(targetId);
    if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
    // Regular (non-owner) admins may only act on non-admin players. Only the owner
    // may touch any admin/owner account (including their own).
    if ((target.is_admin || target.is_super_admin) && !req.isSuperAdmin)
      return res.status(403).json({ error: 'لا يمكنك تعديل حساب مشرف' });
    const newPoints = Math.max(0, (target.total_score || 0) + amount);
    await pool.query('UPDATE users SET total_score=$1 WHERE id=$2', [newPoints, targetId]);
    const lvl = getLevel(newPoints);
    res.json({ ok: true, points: newPoints, level_name: lvl.name, level: lvl.level });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Ban: block future logins/sockets and kick any live session immediately.
app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  try {
    const target = await getUserRow(targetId);
    if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (target.is_super_admin) return res.status(403).json({ error: 'لا يمكن حظر المالك' });
    // Regular (non-owner) admins may only ban non-admin players.
    if (target.is_admin && !req.isSuperAdmin) return res.status(403).json({ error: 'لا يمكنك حظر مشرف' });
    if (req.adminId === targetId) return res.status(403).json({ error: 'لا يمكنك حظر نفسك' });
    await pool.query('UPDATE users SET is_banned=TRUE WHERE id=$1', [targetId]);
    kickUser(targetId);
    res.json({ ok: true, is_banned: true });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Unban: restore login/socket access.
app.post('/api/admin/users/:id/unban', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  try {
    const target = await getUserRow(targetId);
    if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
    // Regular (non-owner) admins may only act on non-admin players.
    if ((target.is_admin || target.is_super_admin) && !req.isSuperAdmin)
      return res.status(403).json({ error: 'لا يمكنك تعديل حساب مشرف' });
    await pool.query('UPDATE users SET is_banned=FALSE WHERE id=$1', [targetId]);
    res.json({ ok: true, is_banned: false });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Promote to admin — OWNER ONLY. Never grants super-admin (owner stays the sole one).
app.post('/api/admin/users/:id/promote', requireAdmin, async (req, res) => {
  if (!req.isSuperAdmin) return res.status(403).json({ error: 'صلاحية المالك مطلوبة' });
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  try {
    const target = await getUserRow(targetId);
    if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
    await pool.query('UPDATE users SET is_admin=TRUE WHERE id=$1', [targetId]);
    res.json({ ok: true, is_admin: true });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Demote an admin — OWNER ONLY. The owner can't be demoted; admins can't demote
// themselves. The owner is never demotable, so there's always ≥1 super-admin.
app.post('/api/admin/users/:id/demote', requireAdmin, async (req, res) => {
  if (!req.isSuperAdmin) return res.status(403).json({ error: 'صلاحية المالك مطلوبة' });
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'بيانات غير صالحة' });
  try {
    const target = await getUserRow(targetId);
    if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (target.is_super_admin) return res.status(403).json({ error: 'لا يمكن إزالة صلاحية المالك' });
    if (req.adminId === targetId) return res.status(403).json({ error: 'لا يمكنك إزالة صلاحياتك' });
    await pool.query('UPDATE users SET is_admin=FALSE WHERE id=$1', [targetId]);
    res.json({ ok: true, is_admin: false });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Player flags a problematic AI-generated question. Identified by a hash of the
// question text; the text/options are stored so it can be reviewed later, and the
// correct answer is enriched from authoritative live room state (never from the
// client). Idempotent: one flag per (question, user) thanks to ON CONFLICT.
app.post('/api/flag-question', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'غير مصرح' });

  const { question, options, code } = req.body || {};
  if (!question || typeof question !== 'string') return res.status(400).json({ error: 'سؤال غير صالح' });

  const question_key = crypto.createHash('sha256').update(question.trim()).digest('hex');
  const optionsJson = Array.isArray(options) ? JSON.stringify(options) : null;

  // Pull the correct answer from the live room if it still matches this question.
  let correct_answer = null;
  const room = code && rooms[code];
  if (room && room.currentQuestion && room.currentQuestion.question === question) {
    correct_answer = room.currentQuestion.answer || null;
  }

  try {
    await pool.query(
      `INSERT INTO question_flags (question_key, user_id, question_text, options, correct_answer)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (question_key, user_id) DO NOTHING`,
      [question_key, payload.id, question, optionsJson, correct_answer]
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
  if (AI_FALLBACK_ENABLED && questions.length < need) {
    const gap = need - questions.length;
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
    const code = generateCode();
    const cats = categories;
    rooms[code] = { code, host:socket.id, categories:cats, players:{}, phase:0,
      phaseNames:['easy','medium','hard'], qIndex:0, timer:null, status:'waiting', answered:{} };
    rooms[code].players[socket.id] = { ...socket.user, sessionScore:0, ready:false };
    socket.join(code); socket.roomCode = code;
    socket.emit('room_created', { code, categories:cats });
    io.to(code).emit('players_update', getPlayers(code));
  });

  socket.on('join_room', ({ code }) => {
    if (MAINTENANCE_MODE && !socket.isAdmin) {
      return socket.emit('maintenance_blocked', 'اللعبة قيد الصيانة حالياً، حاول لاحقاً');
    }
    const room = rooms[code];
    if (!room) return socket.emit('error_msg', 'الغرفة غير موجودة');
    if (room.status !== 'waiting') return socket.emit('error_msg', 'اللعبة بدأت');
    room.players[socket.id] = { ...socket.user, sessionScore:0, ready:false };
    socket.join(code); socket.roomCode = code;
    socket.emit('room_joined', { code, categories:room.categories, host:room.host });
    io.to(code).emit('players_update', getPlayers(code));
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
    Object.values(room.players).forEach(p => { p.sessionScore = 0; p.ready = false; });
    io.to(code).emit('room_reset', { code, categories: room.categories, host: room.host });
    io.to(code).emit('players_update', getPlayers(code));
  });

  socket.on('player_ready', () => {
    const room = rooms[socket.roomCode]; if (!room) return;
    const p = room.players[socket.id]; if (!p) return;
    p.ready = !p.ready;
    io.to(socket.roomCode).emit('players_update', getPlayers(socket.roomCode));
    const nonHost = Object.entries(room.players).filter(([id]) => id !== room.host);
    if (nonHost.length > 0 && nonHost.every(([,pl]) => pl.ready)) io.to(socket.roomCode).emit('all_ready');
  });

  socket.on('start_game', async () => {
    const code = socket.roomCode; const room = rooms[code];
    if (!room || room.host !== socket.id) return;
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
      room.allQuestions = { easy, medium, hard };
      room.status = 'playing'; room.phase = 0;
      startPhase(code);
    } catch(e) {
      console.error(e); room.status = 'waiting';
      io.to(code).emit('error_msg', 'خطأ في تحميل الأسئلة');
    }
  });

  socket.on('submit_answer', ({ answer }) => {
    const code = socket.roomCode; const room = rooms[code];
    if (!room || room.status !== 'playing') return;
    const q = room.currentQuestion;
    if (!q || room.answered[socket.id]) return;
    room.answered[socket.id] = true;
    const correct = answer === q.answer;
    const pts = { easy:100, medium:200, hard:300 }[room.phaseNames[room.phase]];
    if (correct) room.players[socket.id].sessionScore += pts;
    // FIX #1: Only send correct_answer AFTER player has answered
    socket.emit('answer_result', { correct, correct_answer:q.answer, points:correct?pts:0 });
    io.to(code).emit('players_update', getPlayers(code));
    const total = Object.keys(room.players).length;
    if (Object.keys(room.answered).length >= total) {
      clearInterval(room.timer);
      // Reveal correct answer to everyone now that all answered
      io.to(code).emit('reveal_answer', { correct_answer:q.answer });
      io.to(code).emit('timer', { seconds:0 });
      room.qIndex++;
      setTimeout(() => askQuestion(code), 2500);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    delete rooms[code].players[socket.id];
    if (Object.keys(rooms[code].players).length === 0) { clearInterval(rooms[code].timer); delete rooms[code]; return; }
    if (rooms[code].host === socket.id) {
      rooms[code].host = Object.keys(rooms[code].players)[0];
      io.to(code).emit('host_changed', { host:rooms[code].host });
    }
    io.to(code).emit('players_update', getPlayers(code));
  });
});

function getPlayers(code) {
  return Object.entries(rooms[code].players).map(([id,p]) => ({
    ...p, socketId:id, isHost:id===rooms[code].host
  })).sort((a,b) => b.sessionScore-a.sessionScore);
}

// Force every live socket of a banned user out of the game. Mirrors the disconnect
// handler's room cleanup (drop the player, reassign host or delete an empty room),
// then disconnects the socket so they can't keep playing the current session.
function kickUser(userId) {
  for (const s of io.sockets.sockets.values()) {
    if (!s.user || s.user.id !== userId) continue;
    const code = s.roomCode;
    if (code && rooms[code]) {
      delete rooms[code].players[s.id];
      if (Object.keys(rooms[code].players).length === 0) {
        clearInterval(rooms[code].timer); delete rooms[code];
      } else {
        if (rooms[code].host === s.id) {
          rooms[code].host = Object.keys(rooms[code].players)[0];
          io.to(code).emit('host_changed', { host: rooms[code].host });
        }
        io.to(code).emit('players_update', getPlayers(code));
      }
    }
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
  room.currentQuestion = q; room.answered = {};
  const pts = { easy:100, medium:200, hard:300 }[room.phaseNames[room.phase]];
  io.to(code).emit('question', {
    index:room.qIndex+1, total:room.questions.length,
    question:q.question, options:q.options, points:pts, phase:room.phase+1,
    is_logo:q.logo_question||false,
    is_image:q.is_image||false,
    images:q.images||null,
    image_url:q.image_url||null
  });
  let timeLeft = 15;
  io.to(code).emit('timer', { seconds:timeLeft });
  room.timer = setInterval(() => {
    timeLeft--;
    io.to(code).emit('timer', { seconds:timeLeft });
    if (timeLeft <= 0) {
      clearInterval(room.timer);
      io.to(code).emit('time_up', { correct_answer:q.answer });
      room.qIndex++;
      setTimeout(() => askQuestion(code), 2500);
    }
  }, 1000);
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
    await pool.query('UPDATE users SET total_score=total_score+$1 WHERE id=$2', [pts, p.id]);
    await pool.query('INSERT INTO game_history (user_id,room_code,score) VALUES ($1,$2,$3)', [p.id, code, p.sessionScore]);
  }
  io.to(code).emit('game_end', { leaderboard });
  if (room.endTimer) clearTimeout(room.endTimer);
  room.endTimer = setTimeout(() => { delete rooms[code]; }, 120000);
}

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
