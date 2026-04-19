/**
 * auth.js — Authentication module
 *
 * Routes:
 *   POST /api/auth/register   { username, email, password, avatar }
 *   POST /api/auth/login      { email, password }
 *   GET  /api/auth/me         → current user (requires JWT)
 *   PUT  /api/auth/avatar     { avatar } → update avatar (requires JWT)
 *
 * JWT stored in httpOnly cookie + returned in body for flexibility.
 * Passwords hashed with bcrypt (12 rounds).
 *
 * Roles: 'user' | 'developer' | 'admin'
 * Developer role gives access to /api/admin/* endpoints without ADMIN_SECRET.
 */

let bcrypt, jwt;
try {
  bcrypt = require('bcrypt');
  jwt    = require('jsonwebtoken');
} catch(e) {
  console.error('Auth dependencies missing — run: npm install');
  console.error('Auth will be disabled until dependencies are installed.');
}
const pool = require('./db');

const JWT_SECRET  = process.env.JWT_SECRET || 'toyt-dev-secret-change-in-production';
const JWT_EXPIRES = '30d';
const SALT_ROUNDS = 12;

// ─── Available avatars ────────────────────────────────────────────────────────
const AVATARS = [
  { id: 'vinyl',    emoji: '🎵', label: 'Vinyl'      },
  { id: 'guitar',   emoji: '🎸', label: 'Guitar'     },
  { id: 'mic',      emoji: '🎤', label: 'Microphone' },
  { id: 'drums',    emoji: '🥁', label: 'Drums'      },
  { id: 'trumpet',  emoji: '🎺', label: 'Trumpet'    },
  { id: 'violin',   emoji: '🎻', label: 'Violin'     },
  { id: 'piano',    emoji: '🎹', label: 'Piano'      },
  { id: 'notes',    emoji: '🎼', label: 'Sheet Music' },
  { id: 'headphone',emoji: '🎧', label: 'Headphones' },
  { id: 'radio',    emoji: '📻', label: 'Radio'      },
  { id: 'star',     emoji: '⭐', label: 'Star'       },
  { id: 'fire',     emoji: '🔥', label: 'Fire'       },
];

// ─── Schema ───────────────────────────────────────────────────────────────────
async function ensureUserSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT        NOT NULL UNIQUE,
      email         TEXT        NOT NULL UNIQUE,
      password_hash TEXT        NOT NULL,
      avatar        TEXT        NOT NULL DEFAULT 'vinyl',
      role          TEXT        NOT NULL DEFAULT 'user',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login    TIMESTAMPTZ
    )
  `);

  // Index for fast email lookup on login
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_email ON users (lower(email))
  `);
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────
function signToken(user) {
  if (!jwt) throw new Error('jsonwebtoken not installed');
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function setTokenCookie(res, token) {
  res.cookie('toyt_token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

// ─── Middleware: authenticate ─────────────────────────────────────────────────
// Reads JWT from cookie OR Authorization: Bearer <token> header.
// Sets req.user = { id, username, role } or null.
function authenticate(req, res, next) {
  const token = req.cookies?.toyt_token
    || (req.headers.authorization || '').replace('Bearer ', '');

  if (!token) {
    req.user = null;
    return next();
  }
  try {
    req.user = jwt ? jwt.verify(token, JWT_SECRET) : null;
  } catch {
    req.user = null;
  }
  next();
}

// Middleware: require authentication
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// Middleware: require developer or admin role
function requireDev(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'developer' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Developer access required' });
  }
  next();
}

// Middleware: require admin role
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ─── Route handlers ───────────────────────────────────────────────────────────
async function register(req, res) {
  const { username, email, password, avatar } = req.body || {};

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }
  if (username.length < 2 || username.length > 24) {
    return res.status(400).json({ error: 'Username must be 2–24 characters' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const avatarId = AVATARS.find(a => a.id === avatar) ? avatar : 'vinyl';

  try {
    if (!bcrypt) return res.status(503).json({ error: 'Auth service not configured — run npm install on server' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash, avatar)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, avatar, role, created_at`,
      [username.trim(), email.toLowerCase().trim(), hash, avatarId]
    );
    const user  = rows[0];
    const token = signToken(user);
    setTokenCookie(res, token);
    res.status(201).json({ token, user: safeUser(user) });
  } catch (err) {
    if (err.code === '23505') {
      const field = err.constraint?.includes('email') ? 'email' : 'username';
      return res.status(409).json({ error: `That ${field} is already taken` });
    }
    console.error('[register]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
}

async function login(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE lower(email) = $1',
      [email.toLowerCase().trim()]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user  = rows[0];
    if (!bcrypt) return res.status(503).json({ error: 'Auth service not configured' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]).catch(() => {});

    const token = signToken(user);
    setTokenCookie(res, token);
    res.json({ token, user: safeUser(user) });
  } catch (err) {
    console.error('[login]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
}

async function getMe(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, email, avatar, role, created_at, last_login FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: safeUser(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

async function updateAvatar(req, res) {
  const { avatar } = req.body || {};
  if (!AVATARS.find(a => a.id === avatar)) {
    return res.status(400).json({ error: 'Invalid avatar' });
  }
  try {
    await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, req.user.id]);
    res.json({ avatar });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

function logout(req, res) {
  res.clearCookie('toyt_token');
  res.json({ message: 'Logged out' });
}

function getAvatars(req, res) {
  res.json({ avatars: AVATARS });
}

// Strip sensitive fields from user object
function safeUser(u) {
  return {
    id:         u.id,
    username:   u.username,
    email:      u.email,
    avatar:     u.avatar,
    role:       u.role,
    created_at: u.created_at,
    last_login: u.last_login,
  };
}

// ─── Register routes on Express app ──────────────────────────────────────────
function registerAuthRoutes(app) {
  // Parse cookies — we do this here so cookie-parser isn't needed as a dep
  app.use((req, res, next) => {
    const cookieHeader = req.headers.cookie || '';
    req.cookies = Object.fromEntries(
      cookieHeader.split(';')
        .map(s => s.trim().split('='))
        .filter(([k]) => k)
        .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join('=').trim())])
    );
    next();
  });

  app.use(authenticate);

  app.post('/api/auth/register',  register);
  app.post('/api/auth/login',     login);
  app.post('/api/auth/logout',    logout);
  app.get('/api/auth/me',         requireAuth, getMe);
  app.put('/api/auth/avatar',     requireAuth, updateAvatar);
  app.get('/api/auth/avatars',    getAvatars);
}

module.exports = {
  registerAuthRoutes,
  ensureUserSchema,
  authenticate,
  requireAuth,
  requireDev,
  requireAdmin,
  AVATARS,
};
