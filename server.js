require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

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
  } catch (err) {
    dbStatus = 'error';
    console.error('MongoDB connection failed:', err.message);
  }
}

// Bypassed authentication middleware for testing
function requireAuth(req, res, next) {
  req.user = { id: 'test-user', name: 'Tester', role: 'admin' };
  next();
}

function requireAdmin(req, res, next) {
  next();
}

// 1. Health Check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, database: dbStatus });
});

// 2. Mock Authentication endpoints for testing
app.post('/api/auth/login', (req, res) => {
  res.json({ token: 'mock-token', user: { id: 'test-user', name: 'Tester', role: 'admin' } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: 'test-user', name: 'Tester', role: 'admin' } });
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

// 4. Cloud Backups & Audit Log (Bypassed)
app.get('/api/backups', requireAuth, requireAdmin, async (req, res) => {
  res.json({ backups: [] });
});

app.get('/api/audit', requireAuth, requireAdmin, async (req, res) => {
  res.json({ entries: [] });
});

app.post('/api/audit', requireAuth, async (req, res) => {
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

connectDatabase().finally(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});