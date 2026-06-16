require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'trivia_secret_key_2024';
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const db = new sqlite3.Database('./trivia.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL,
    dob TEXT NOT NULL, gender TEXT NOT NULL, password TEXT NOT NULL,
    total_score INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS game_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
    room_code TEXT, score INTEGER, played_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

function getLevel(score) {
  if (score <= 500)  return { name: 'البطريق', emoji: '🐧', level: 1, min: 0,    max: 500  };
  if (score <= 1250) return { name: 'الذئب',   emoji: '🐺', level: 2, min: 501,  max: 1250 };
  if (score <= 2400) return { name: 'الدب',    emoji: '🐻', level: 3, min: 1251, max: 2400 };
  if (score <= 4100) return { name: 'الأسد',   emoji: '🦁', level: 4, min: 2401, max: 4100 };
  if (score <= 6650) return { name: 'التنين',  emoji: '🐉', level: 5, min: 4101, max: 6650 };
  return { name: 'الفلتة!', emoji: '💥', level: 6, min: 6651, max: 9999 };
}

function displayName(u) { return `${u.first_name} ${u.last_name.substring(0,3)}`; }
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }

function safeUser(u) {
  const level = getLevel(u.total_score || 0);
  return { id: u.id, first_name: u.first_name, last_name: u.last_name,
    email: u.email, phone: u.phone, dob: u.dob, gender: u.gender,
    total_score: u.total_score || 0, display_name: displayName(u), level };
}

function dbGet(sql, params) {
  return new Promise((res, rej) => db.get(sql, params, (e, r) => e ? rej(e) : res(r)));
}
function dbRun(sql, params) {
  return new Promise((res, rej) => db.run(sql, params, function(e) { e ? rej(e) : res(this); }));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', async (req, res) => {
  const { first_name, last_name, phone, email, dob, gender, password } = req.body;
  if (!first_name||!last_name||!phone||!email||!dob||!gender||!password)
    return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await dbRun('INSERT INTO users (first_name,last_name,phone,email,dob,gender,password) VALUES (?,?,?,?,?,?,?)',
      [first_name,last_name,phone,email,dob,gender,hash]);
    const user = await dbGet('SELECT * FROM users WHERE id=?', [r.lastID]);
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: safeUser(user) });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'البريد أو الهاتف مسجل مسبقاً' });
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await dbGet('SELECT * FROM users WHERE email=?', [email]);
  if (!user) return res.status(400).json({ error: 'البريد أو كلمة المرور غير صحيحة' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'البريد أو كلمة المرور غير صحيحة' });
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

app.get('/api/me', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'غير مصرح' });
  const user = await dbGet('SELECT * FROM users WHERE id=?', [payload.id]);
  if (!user) return res.status(404).json({ error: 'غير موجود' });
  res.json(safeUser(user));
});

// ── AI Question Generation ────────────────────────────────────────────────────
async function generateQuestions(categories, difficulty, count = 12) {
  const diffAr = { easy: 'متوسط', medium: 'صعب', hard: 'صعب جداً' }[difficulty];
  const catStr = Array.isArray(categories) ? categories.join(' و ') : categories;
  const prompt = `أنت مولّد أسئلة تريفيا متخصص. اطرح ${count} سؤال من فئة/فئات "${catStr}" بمستوى صعوبة "${diffAr}" باللغة العربية.

قواعد مهمة جداً:
- الأسئلة يجب أن تكون غير متوقعة وتحتاج معرفة حقيقية
- الإجابات الخاطئة (المموهات) يجب أن تكون منطقية ومقنعة وليست واضحة
- لا تضع اسم الشيء نفسه ضمن إجاباته (مثلاً: سؤال عن عملة الكويت لا تضع "الدينار الكويتي" كإجابة واضحة)
- تنوع في أسلوب الأسئلة: من، ماذا، متى، أين، كم، أي
- المموهات يجب أن تكون من نفس الفئة المنطقية للإجابة الصحيحة

رد فقط بـ JSON array:
[{"question":"نص السؤال","options":["أ. خيار1","ب. خيار2","ج. خيار3","د. خيار4"],"answer":"أ. خيار1"}]
تأكد أن answer هو نفس نص أحد elements في options حرفياً.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await response.json();
  const raw = data.content?.map(b => b.text||'').join('') || '[]';
  return JSON.parse(raw.replace(/```json|```/g,'').trim());
}

// ── Rooms ─────────────────────────────────────────────────────────────────────
const rooms = {};
function generateCode() { return String(Math.floor(1000+Math.random()*9000)); }

io.use((socket, next) => {
  const payload = verifyToken(socket.handshake.auth.token);
  if (!payload) return next(new Error('غير مصرح'));
  dbGet('SELECT * FROM users WHERE id=?', [payload.id]).then(user => {
    if (!user) return next(new Error('غير موجود'));
    socket.user = safeUser(user); next();
  }).catch(() => next(new Error('خطأ')));
});

io.on('connection', socket => {
  socket.on('create_room', ({ categories }) => {
    const code = generateCode();
    const cats = Array.isArray(categories) && categories.length > 0 ? categories : ['معلومات عامة'];
    rooms[code] = {
      code, host: socket.id, categories: cats,
      players: {}, phase: 0, phaseNames: ['easy','medium','hard'],
      qIndex: 0, timer: null, status: 'waiting', answered: {}
    };
    rooms[code].players[socket.id] = { ...socket.user, sessionScore: 0, ready: false };
    socket.join(code); socket.roomCode = code;
    socket.emit('room_created', { code, categories: cats });
    io.to(code).emit('players_update', getPlayers(code));
  });

  socket.on('join_room', ({ code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error_msg', 'الغرفة غير موجودة');
    if (room.status !== 'waiting') return socket.emit('error_msg', 'اللعبة بدأت');
    room.players[socket.id] = { ...socket.user, sessionScore: 0, ready: false };
    socket.join(code); socket.roomCode = code;
    socket.emit('room_joined', { code, categories: room.categories, host: room.host });
    io.to(code).emit('players_update', getPlayers(code));
  });

  socket.on('player_ready', () => {
    const room = rooms[socket.roomCode]; if (!room) return;
    room.players[socket.id].ready = true;
    io.to(socket.roomCode).emit('players_update', getPlayers(socket.roomCode));
    const nonHost = Object.entries(room.players).filter(([id]) => id !== room.host);
    if (nonHost.length > 0 && nonHost.every(([,p]) => p.ready))
      io.to(socket.roomCode).emit('all_ready');
  });

  socket.on('start_game', async () => {
    const code = socket.roomCode; const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.status = 'loading';
    io.to(code).emit('game_loading', { message: 'جاري تحضير الأسئلة...' });
    try {
      const [easy, medium, hard] = await Promise.all([
        generateQuestions(room.categories, 'easy', 12),
        generateQuestions(room.categories, 'medium', 12),
        generateQuestions(room.categories, 'hard', 12)
      ]);
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
    const pts = { easy: 100, medium: 200, hard: 300 }[room.phaseNames[room.phase]];
    if (correct) room.players[socket.id].sessionScore += pts;
    socket.emit('answer_result', { correct, correct_answer: q.answer, points: correct ? pts : 0 });
    io.to(code).emit('players_update', getPlayers(code));

    // FIX #1: Stop timer if all players answered
    const totalPlayers = Object.keys(room.players).length;
    const answeredCount = Object.keys(room.answered).length;
    if (answeredCount >= totalPlayers) {
      clearInterval(room.timer);
      io.to(code).emit('timer', { seconds: 0 });
      room.qIndex++;
      setTimeout(() => askQuestion(code), 2500);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    delete rooms[code].players[socket.id];
    if (Object.keys(rooms[code].players).length === 0) {
      clearInterval(rooms[code].timer); delete rooms[code]; return;
    }
    if (rooms[code].host === socket.id) {
      rooms[code].host = Object.keys(rooms[code].players)[0];
      io.to(code).emit('host_changed', { host: rooms[code].host });
    }
    io.to(code).emit('players_update', getPlayers(code));
  });
});

function getPlayers(code) {
  const room = rooms[code];
  return Object.entries(room.players).map(([id,p]) => ({
    ...p, socketId: id, isHost: id === room.host
  })).sort((a,b) => b.sessionScore - a.sessionScore);
}

function startPhase(code) {
  const room = rooms[code];
  const phaseName = room.phaseNames[room.phase];
  const phaseAr = { easy: 'سهل', medium: 'متوسط', hard: 'صعب' }[phaseName];
  room.questions = room.allQuestions[phaseName];
  room.qIndex = 0; room.answered = {};
  io.to(code).emit('phase_start', { phase: room.phase+1, name: phaseAr, total: 3 });
  setTimeout(() => askQuestion(code), 3000);
}

function askQuestion(code) {
  const room = rooms[code];
  if (!room || room.status !== 'playing') return;
  if (room.qIndex >= room.questions.length) { endPhase(code); return; }
  const q = room.questions[room.qIndex];
  room.currentQuestion = q; room.answered = {};
  const pts = { easy: 100, medium: 200, hard: 300 }[room.phaseNames[room.phase]];
  io.to(code).emit('question', {
    index: room.qIndex+1, total: room.questions.length,
    question: q.question, options: q.options, points: pts, phase: room.phase+1
  });
  let timeLeft = 15;
  io.to(code).emit('timer', { seconds: timeLeft });
  room.timer = setInterval(() => {
    timeLeft--;
    io.to(code).emit('timer', { seconds: timeLeft });
    if (timeLeft <= 0) {
      clearInterval(room.timer);
      io.to(code).emit('time_up', { correct_answer: q.answer });
      room.qIndex++;
      setTimeout(() => askQuestion(code), 2500);
    }
  }, 1000);
}

function endPhase(code) {
  const room = rooms[code];
  io.to(code).emit('phase_end', { leaderboard: getPlayers(code), phase: room.phase+1 });
  room.phase++;
  if (room.phase >= 3) endGame(code);
  else setTimeout(() => startPhase(code), 8000);
}

function endGame(code) {
  const room = rooms[code];
  const leaderboard = getPlayers(code);
  leaderboard.forEach(p => {
    const pts = Math.floor(p.sessionScore / 100);
    dbRun('UPDATE users SET total_score = total_score + ? WHERE id = ?', [pts, p.id]);
    dbRun('INSERT INTO game_history (user_id, room_code, score) VALUES (?,?,?)', [p.id, code, p.sessionScore]);
  });
  io.to(code).emit('game_end', { leaderboard });
  setTimeout(() => delete rooms[code], 30000);
}

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
