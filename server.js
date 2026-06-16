require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'trivia_secret_key_2024';
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ─── Database ───────────────────────────────────────────────────────────────
const db = new Database('./data/trivia.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    dob TEXT NOT NULL,
    gender TEXT NOT NULL,
    password TEXT NOT NULL,
    total_score INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS game_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    room_code TEXT,
    score INTEGER,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getLevel(score) {
  if (score <= 500)  return { name: 'البطريق', emoji: '🐧', level: 1 };
  if (score <= 1250) return { name: 'الذئب',   emoji: '🐺', level: 2 };
  if (score <= 2400) return { name: 'الدب',    emoji: '🐻', level: 3 };
  if (score <= 4100) return { name: 'الأسد',   emoji: '🦁', level: 4 };
  if (score <= 6650) return { name: 'التنين',  emoji: '🐉', level: 5 };
  return { name: 'الفلتة!', emoji: '💥', level: 6 };
}

function displayName(user) {
  const last3 = user.last_name.substring(0, 3);
  return `${user.first_name} ${last3}`;
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { first_name, last_name, phone, email, dob, gender, password } = req.body;
  if (!first_name || !last_name || !phone || !email || !dob || !gender || !password)
    return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
  if (!['male','female'].includes(gender))
    return res.status(400).json({ error: 'الجنس غير صحيح' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const stmt = db.prepare('INSERT INTO users (first_name,last_name,phone,email,dob,gender,password) VALUES (?,?,?,?,?,?,?)');
    const result = stmt.run(first_name, last_name, phone, email, dob, gender, hash);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid);
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: safeUser(user) });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'البريد الإلكتروني أو رقم الهاتف مسجل مسبقاً' });
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) return res.status(400).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

app.get('/api/me', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'غير مصرح' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.id);
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json(safeUser(user));
});

function safeUser(u) {
  const level = getLevel(u.total_score);
  return {
    id: u.id, first_name: u.first_name, last_name: u.last_name,
    email: u.email, phone: u.phone, dob: u.dob, gender: u.gender,
    total_score: u.total_score, display_name: displayName(u), level
  };
}

// ─── AI Question Generation ───────────────────────────────────────────────────
async function generateQuestions(category, difficulty, count = 12) {
  const diffAr = { easy: 'سهل', medium: 'متوسط', hard: 'صعب' }[difficulty];
  const prompt = `أنت مولّد أسئلة تريفيا. اطرح ${count} سؤال من فئة "${category}" بمستوى صعوبة "${diffAr}" باللغة العربية.
رد فقط بـ JSON array بدون أي نص إضافي:
[{"question":"نص السؤال","options":["أ. خيار1","ب. خيار2","ج. خيار3","د. خيار4"],"answer":"أ. خيار1"}]
تأكد أن answer هو نفس نص أحد elements في options حرفياً. الأسئلة متنوعة ومختلفة.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await response.json();
  const raw = data.content?.map(b => b.text || '').join('') || '[]';
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── Room Management ──────────────────────────────────────────────────────────
const rooms = {};

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

const CATEGORIES = ['الكويت', 'التكنولوجيا', 'معلومات عامة', 'شعارات الشركات', 'عواصم الدول', 'خرائط وجغرافيا'];

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  const payload = verifyToken(token);
  if (!payload) return next(new Error('غير مصرح'));
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.id);
  if (!user) return next(new Error('المستخدم غير موجود'));
  socket.user = safeUser(user);
  next();
});

io.on('connection', (socket) => {
  // CREATE ROOM
  socket.on('create_room', ({ category }) => {
    const code = generateCode();
    rooms[code] = {
      code, host: socket.id, category: category || 'معلومات عامة',
      players: {}, phase: 0, phaseNames: ['easy','medium','hard'],
      questions: [], qIndex: 0, timer: null, status: 'waiting',
      phaseScores: {}
    };
    rooms[code].players[socket.id] = { ...socket.user, sessionScore: 0, ready: false };
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_created', { code, category: rooms[code].category });
    io.to(code).emit('players_update', getPlayers(code));
  });

  // JOIN ROOM
  socket.on('join_room', ({ code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error_msg', 'الغرفة غير موجودة');
    if (room.status !== 'waiting') return socket.emit('error_msg', 'اللعبة بدأت بالفعل');
    room.players[socket.id] = { ...socket.user, sessionScore: 0, ready: false };
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_joined', { code, category: room.category, host: room.host });
    io.to(code).emit('players_update', getPlayers(code));
  });

  // PLAYER READY
  socket.on('player_ready', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    room.players[socket.id].ready = true;
    io.to(code).emit('players_update', getPlayers(code));
    // Check if all non-host players are ready
    const nonHost = Object.entries(room.players).filter(([id]) => id !== room.host);
    if (nonHost.length > 0 && nonHost.every(([,p]) => p.ready)) {
      io.to(code).emit('all_ready');
    }
  });

  // HOST STARTS GAME
  socket.on('start_game', async () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.status = 'loading';
    io.to(code).emit('game_loading', { message: 'جاري تحضير الأسئلة...' });
    try {
      const [easy, medium, hard] = await Promise.all([
        generateQuestions(room.category, 'easy', 12),
        generateQuestions(room.category, 'medium', 12),
        generateQuestions(room.category, 'hard', 12)
      ]);
      room.allQuestions = { easy, medium, hard };
      room.status = 'playing';
      room.phase = 0;
      startPhase(code);
    } catch(e) {
      console.error(e);
      room.status = 'waiting';
      io.to(code).emit('error_msg', 'خطأ في تحميل الأسئلة، حاول مجدداً');
    }
  });

  // ANSWER
  socket.on('submit_answer', ({ answer }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.status !== 'playing') return;
    const q = room.currentQuestion;
    if (!q || room.answered?.[socket.id]) return;
    if (!room.answered) room.answered = {};
    room.answered[socket.id] = true;
    const correct = answer === q.answer;
    const pts = { easy: 100, medium: 200, hard: 300 }[room.phaseNames[room.phase]];
    if (correct) {
      room.players[socket.id].sessionScore += pts;
    }
    socket.emit('answer_result', { correct, correct_answer: q.answer, points: correct ? pts : 0 });
    io.to(code).emit('players_update', getPlayers(code));
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    delete rooms[code].players[socket.id];
    if (Object.keys(rooms[code].players).length === 0) {
      clearTimeout(rooms[code].timer);
      delete rooms[code];
      return;
    }
    // If host left, assign new host
    if (rooms[code].host === socket.id) {
      rooms[code].host = Object.keys(rooms[code].players)[0];
      io.to(code).emit('host_changed', { host: rooms[code].host });
    }
    io.to(code).emit('players_update', getPlayers(code));
  });
});

function getPlayers(code) {
  const room = rooms[code];
  return Object.entries(room.players).map(([id, p]) => ({
    ...p, socketId: id, isHost: id === room.host
  })).sort((a,b) => b.sessionScore - a.sessionScore);
}

function startPhase(code) {
  const room = rooms[code];
  const phaseName = room.phaseNames[room.phase];
  const phaseAr = { easy: 'سهل', medium: 'متوسط', hard: 'صعب' }[phaseName];
  room.questions = room.allQuestions[phaseName];
  room.qIndex = 0;
  room.answered = {};
  io.to(code).emit('phase_start', { phase: room.phase + 1, name: phaseAr, total: 3 });
  setTimeout(() => askQuestion(code), 3000);
}

function askQuestion(code) {
  const room = rooms[code];
  if (!room || room.status !== 'playing') return;
  if (room.qIndex >= room.questions.length) {
    endPhase(code);
    return;
  }
  const q = room.questions[room.qIndex];
  room.currentQuestion = q;
  room.answered = {};
  const phaseName = room.phaseNames[room.phase];
  const pts = { easy: 100, medium: 200, hard: 300 }[phaseName];
  io.to(code).emit('question', {
    index: room.qIndex + 1, total: room.questions.length,
    question: q.question, options: q.options,
    points: pts, phase: room.phase + 1
  });
  let timeLeft = 15;
  io.to(code).emit('timer', { seconds: timeLeft });
  room.timer = setInterval(() => {
    timeLeft--;
    io.to(code).emit('timer', { seconds: timeLeft });
    if (timeLeft <= 0) {
      clearInterval(room.timer);
      // Reveal answer to those who didn't answer
      io.to(code).emit('time_up', { correct_answer: q.answer });
      room.qIndex++;
      setTimeout(() => askQuestion(code), 3000);
    }
  }, 1000);
}

function endPhase(code) {
  const room = rooms[code];
  const leaderboard = getPlayers(code);
  io.to(code).emit('phase_end', { leaderboard, phase: room.phase + 1 });
  room.phase++;
  if (room.phase >= 3) {
    endGame(code);
  } else {
    setTimeout(() => startPhase(code), 8000);
  }
}

function endGame(code) {
  const room = rooms[code];
  const leaderboard = getPlayers(code);
  // Save scores to DB
  Object.values(room.players).forEach(p => {
    const levelPts = Math.floor(p.sessionScore / 100);
    db.prepare('UPDATE users SET total_score = total_score + ? WHERE id = ?').run(levelPts, p.id);
    db.prepare('INSERT INTO game_history (user_id, room_code, score) VALUES (?,?,?)').run(p.id, code, p.sessionScore);
  });
  io.to(code).emit('game_end', { leaderboard });
  setTimeout(() => delete rooms[code], 30000);
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
