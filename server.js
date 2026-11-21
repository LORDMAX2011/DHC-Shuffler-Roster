require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123456!';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db = null;
let dbStatus = 'disconnected';

async function connectDatabase() {
  if (!MONGODB_URI) {
    console.error('Missing MONGODB_URI environment variable.');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db();
    dbStatus = 'connected';
    console.log('Connected to MongoDB');
    await ensureDefaultAdmin();
  } catch (err) {
    dbStatus = 'error';
    console.error('MongoDB connection failed:', err.message);
  }
}

async function ensureDefaultAdmin() {
  const users = db.collection('users');
  const existing = await users.findOne({ role: 'admin' });
  if (!existing) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await users.insertOne({
      name: ADMIN_USERNAME,
      role: 'admin',
      passwordHash,
      createdAt: new Date().toISOString()
    });
    console.log(`Initial admin user created: "${ADMIN_USERNAME}"`);
  }
}

async function logAudit(actor, action, detail = '') {
  if (!db) return;
  await db.collection('audit').insertOne({
    actor,
    action,
    detail,
    createdAt: new Date().toISOString()
  });
}

function requireAuth(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Database is still connecting.' });
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Sign in required.' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// 1. Health Check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, database: dbStatus });
});

// 2. Authentication
app.post('/api/auth/login', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable.' });
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  const user = await db.collection('users').findOne({
    name: { $regex: new RegExp(`^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
  });

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid admin name or password.' });
  }

  const safeUser = { id: user._id.toString(), name: user.name, role: user.role };
  const token = jwt.sign(safeUser, JWT_SECRET, { expiresIn: '7d' });
  await logAudit(user.name, 'auth.login', 'Signed in');
  res.json({ token, user: safeUser });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
  if (!user) return res.status(401).json({ error: 'User no longer exists.' });
  res.json({ user: { id: user._id.toString(), name: user.name, role: user.role } });
});

app.post('/api/auth/change-username', requireAuth, requireAdmin, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newUsername = String(req.body?.newUsername || '').trim();
  if (!newUsername || newUsername.length > 100) {
    return res.status(400).json({ error: 'Enter a valid new username (1–100 characters).' });
  }

  const users = db.collection('users');
  const user = await users.findOne({ _id: new ObjectId(req.user.id) });
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const oldName = user.name;
  await users.updateOne({ _id: user._id }, { $set: { name: newUsername } });
  await logAudit(newUsername, 'auth.username_changed', `Changed from ${oldName}`);
  res.json({ user: { id: user._id.toString(), name: newUsername, role: user.role } });
});

app.post('/api/auth/change-password', requireAuth, requireAdmin, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 12) {
    return res.status(400).json({ error: 'New password must be at least 12 characters.' });
  }

  const users = db.collection('users');
  const user = await users.findOne({ _id: new ObjectId(req.user.id) });
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await users.updateOne({ _id: user._id }, { $set: { passwordHash } });
  await logAudit(user.name, 'auth.password_changed', 'Password updated');
  res.json({ ok: true });
});

// 3. School State Sync
app.get('/api/data', requireAuth, async (req, res) => {
  const doc = await db.collection('school_state').findOne({ _id: 'primary' });
  res.json({ state: doc?.state || null });
});

app.put('/api/data', requireAuth, async (req, res) => {
  const state = req.body?.state;
  if (!state || typeof state !== 'object') {
    return res.status(400).json({ error: 'Invalid state payload.' });
  }
  await db.collection('school_state').updateOne(
    { _id: 'primary' },
    { $set: { state, updatedAt: new Date().toISOString(), updatedBy: req.user.name } },
    { upsert: true }
  );
  res.json({ ok: true });
});

// 4. Cloud Backups & Audit Log
app.get('/api/backups', requireAuth, requireAdmin, async (req, res) => {
  const list = await db
    .collection('backups')
    .find({}, { projection: { state: 0 } })
    .sort({ createdAt: -1 })
    .limit(25)
    .toArray();
  res.json({
    backups: list.map(b => ({
      _id: b._id.toString(),
      reason: b.reason,
      createdAt: b.createdAt
    }))
  });
});

app.post('/api/backups', requireAuth, requireAdmin, async (req, res) => {
  const doc = await db.collection('school_state').findOne({ _id: 'primary' });
  if (!doc?.state) return res.status(400).json({ error: 'No school data saved yet to back up.' });

  await db.collection('backups').insertOne({
    reason: req.body?.reason || 'Manual cloud backup',
    state: doc.state,
    createdAt: new Date().toISOString(),
    createdBy: req.user.name
  });
  await logAudit(req.user.name, 'backup.created', 'Created cloud backup');
  res.json({ ok: true });
});

app.post('/api/backups/:id/restore', requireAuth, requireAdmin, async (req, res) => {
  let backupId;
  try {
    backupId = new ObjectId(req.params.id);
  } catch {
    return res.status(400).json({ error: 'Invalid backup ID.' });
  }

  const backup = await db.collection('backups').findOne({ _id: backupId });
  if (!backup) return res.status(404).json({ error: 'Backup not found.' });

  await db.collection('school_state').updateOne(
    { _id: 'primary' },
    { $set: { state: backup.state, updatedAt: new Date().toISOString(), updatedBy: req.user.name } },
    { upsert: true }
  );
  await logAudit(req.user.name, 'backup.restored', `Restored backup from ${backup.createdAt}`);
  res.json({ state: backup.state });
});

app.get('/api/audit', requireAuth, requireAdmin, async (req, res) => {
  const entries = await db.collection('audit').find({}).sort({ createdAt: -1 }).limit(40).toArray();
  res.json({ entries });
});

app.post('/api/audit', requireAuth, async (req, res) => {
  const action = String(req.body?.action || '').slice(0, 80);
  const detail = String(req.body?.detail || '').slice(0, 160);
  if (action) await logAudit(req.user.name, action, detail);
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

connectDatabase().finally(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});