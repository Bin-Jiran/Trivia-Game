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

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL,
      dob TEXT NOT NULL, gender TEXT NOT NULL, password TEXT NOT NULL,
      total_score INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS game_history (
      id SERIAL PRIMARY KEY, user_id INTEGER, room_code TEXT, score INTEGER,
      played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ Database ready');
}
initDB().catch(console.error);

function getLevel(score) {
  if (score <= 500)  return { name:'البطريق', emoji:'🐧', img:'/levels/penguin.png', level:1, min:0,    max:500   };
  if (score <= 1250) return { name:'الذئب',   emoji:'🐺', img:'/levels/wolf.png',    level:2, min:501,  max:1250  };
  if (score <= 2400) return { name:'الدب',    emoji:'🐻', img:'/levels/bear.png',    level:3, min:1251, max:2400  };
  if (score <= 4100) return { name:'الأسد',   emoji:'🦁', img:'/levels/lion.png',    level:4, min:2401, max:4100  };
  if (score <= 6650) return { name:'التنين',  emoji:'🐉', img:'/levels/dragon.png',  level:5, min:4101, max:6650  };
  return { name:'الفلتة!', emoji:'💥', img:'/levels/falta.png', level:6, min:6651, max:99999 };
}
function displayName(u) { return `${u.first_name} ${u.last_name.substring(0,3)}`; }
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
function safeUser(u) {
  const level = getLevel(u.total_score || 0);
  return { id:u.id, first_name:u.first_name, last_name:u.last_name,
    email:u.email, phone:u.phone, dob:u.dob, gender:u.gender,
    total_score:u.total_score||0, display_name:displayName(u), level };
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
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

app.get('/api/me', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'غير مصرح' });
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [payload.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'غير موجود' });
  res.json(safeUser(r.rows[0]));
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

const rooms = {};
function generateCode() { return String(Math.floor(1000+Math.random()*9000)); }

io.use((socket, next) => {
  const payload = verifyToken(socket.handshake.auth.token);
  if (!payload) return next(new Error('غير مصرح'));
  pool.query('SELECT * FROM users WHERE id=$1', [payload.id]).then(r => {
    if (!r.rows[0]) return next(new Error('غير موجود'));
    socket.user = safeUser(r.rows[0]); next();
  }).catch(() => next(new Error('خطأ')));
});

io.on('connection', socket => {
  socket.on('create_room', ({ categories }) => {
    const code = generateCode();
    const cats = Array.isArray(categories) && categories.length > 0 ? categories : ['معلومات عامة'];
    rooms[code] = { code, host:socket.id, categories:cats, players:{}, phase:0,
      phaseNames:['easy','medium','hard'], qIndex:0, timer:null, status:'waiting', answered:{} };
    rooms[code].players[socket.id] = { ...socket.user, sessionScore:0, ready:false };
    socket.join(code); socket.roomCode = code;
    socket.emit('room_created', { code, categories:cats });
    io.to(code).emit('players_update', getPlayers(code));
  });

  socket.on('join_room', ({ code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error_msg', 'الغرفة غير موجودة');
    if (room.status !== 'waiting') return socket.emit('error_msg', 'اللعبة بدأت');
    room.players[socket.id] = { ...socket.user, sessionScore:0, ready:false };
    socket.join(code); socket.roomCode = code;
    socket.emit('room_joined', { code, categories:room.categories, host:room.host });
    io.to(code).emit('players_update', getPlayers(code));
  });

  socket.on('player_ready', () => {
    const room = rooms[socket.roomCode]; if (!room) return;
    room.players[socket.id].ready = true;
    io.to(socket.roomCode).emit('players_update', getPlayers(socket.roomCode));
    const nonHost = Object.entries(room.players).filter(([id]) => id !== room.host);
    if (nonHost.length > 0 && nonHost.every(([,p]) => p.ready)) io.to(socket.roomCode).emit('all_ready');
  });

  socket.on('start_game', async () => {
    const code = socket.roomCode; const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.status = 'loading';
    io.to(code).emit('game_loading', { message:'جاري تحضير الأسئلة...' });
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
    is_logo:q.logo_question||false
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
  setTimeout(() => delete rooms[code], 30000);
}

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
