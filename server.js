require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { rateLimit } = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKEN_ISSUER = 'school-classroom-shuffle';
const DATA_KEY = 'school-default';

const requiredEnv = ['MONGODB_URI', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'JWT_SECRET'];
const missingEnv = requiredEnv.filter(name => !process.env[name]);
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 48) {
  console.error('JWT_SECRET must be at least 48 characters.');
  process.exit(1);
}
if (process.env.ADMIN_PASSWORD.length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters.');
  process.exit(1);
}

const SchoolData = mongoose.model('SchoolData', new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  state: { type: mongoose.Schema.Types.Mixed, required: true, default: () => ({}) }
}, { timestamps: true, versionKey: false }));
const Account = mongoose.model('Account', new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  displayName: { type: String, required: true, maxlength: 100 },
  role: { type: String, enum: ['admin', 'teacher'], default: 'teacher' },
  salt: { type: String, required: true },
  passwordHash: { type: String, required: true },
  active: { type: Boolean, default: true }
}, { timestamps: true, versionKey: false }));
const AuditLog = mongoose.model('AuditLog', new mongoose.Schema({
  actor: { type: String, required: true },
  action: { type: String, required: true },
  detail: { type: String, default: '' }
}, { timestamps: true, versionKey: false }));
const Snapshot = mongoose.model('Snapshot', new mongoose.Schema({
  reason: { type: String, required: true },
  state: { type: mongoose.Schema.Types.Mixed, required: true }
}, { timestamps: true, versionKey: false }));

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '2mb', strict: true }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Wait 15 minutes and try again.' }
});

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // Still perform a constant-time comparison for a fixed-size value.
    crypto.timingSafeEqual(crypto.createHash('sha256').update(left).digest(), crypto.createHash('sha256').update(right).digest());
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Please sign in.' });
  try {
    const claims = jwt.verify(match[1], process.env.JWT_SECRET, { issuer: TOKEN_ISSUER });
    if (!mongoose.isValidObjectId(claims.sub)) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
    const account = await Account.findById(claims.sub).lean();
    if (!account || !account.active) return res.status(401).json({ error: 'This account is no longer active. Please sign in again.' });
    req.auth = { sub: String(account._id), email: account.email, name: account.displayName, role: account.role };
    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
    return next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
  return next();
}

function passwordDigest(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function recordAudit(actor, action, detail = '') {
  return AuditLog.create({ actor, action, detail: String(detail).slice(0, 240) }).catch(error => {
    console.error('Audit record failed:', error.message);
  });
}

async function createSnapshot(reason) {
  const doc = await SchoolData.findOne({ key: DATA_KEY }).lean();
  if (!doc?.state) return;
  await Snapshot.create({ reason, state: doc.state });
  const old = await Snapshot.find().sort({ createdAt: -1 }).skip(30).select('_id').lean();
  if (old.length) await Snapshot.deleteMany({ _id: { $in: old.map(item => item._id) } });
}

async function ensureAdminAccount() {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const existing = await Account.findOne({ email }).select('_id').lean();
  if (existing) return;
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = passwordDigest(process.env.ADMIN_PASSWORD, salt);
  await Account.create({ email, displayName: email.split('@')[0], role: 'admin', salt, passwordHash, active: true });
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'Request must contain a state object.';
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > 1_500_000) return 'Roster data is too large to save (maximum 1.5 MB).';

  const profile = state.schoolProfile || {};
  for (const [field, max] of [['name', 100], ['motto', 120], ['address', 160], ['contact', 120]]) {
    if (profile[field] !== undefined && (typeof profile[field] !== 'string' || profile[field].length > max)) return `School profile field "${field}" is invalid.`;
  }
  if (profile.logo !== undefined && (typeof profile.logo !== 'string' || profile.logo.length > 500_000 || (profile.logo && !/^data:image\/(png|jpeg|webp);base64,/.test(profile.logo)))) {
    return 'School logo must be a PNG, JPEG, or WebP image smaller than 500 KB.';
  }
  if (!Array.isArray(state.classNames) || state.classNames.length > 100 || state.classNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 60)) return 'Class list is invalid.';
  if (!state.classTargets || typeof state.classTargets !== 'object' || Array.isArray(state.classTargets)) return 'Class sizes are invalid.';
  for (const value of Object.values(state.classTargets)) if (!Number.isInteger(value) || value < 0 || value > 500) return 'Class sizes must be whole numbers from 1 to 500, or unset.';
  if (typeof state.rosterDraft !== 'string' || state.rosterDraft.length > 300_000) return 'Student list is too large.';
  if (typeof state.teacherName !== 'string' || state.teacherName.length > 100) return 'Teacher name is invalid.';
  if (typeof state.rosterDate !== 'string' || (state.rosterDate && !/^\d{4}-\d{2}-\d{2}$/.test(state.rosterDate))) return 'Roster date is invalid.';
  if (state.schoolYear !== undefined && (typeof state.schoolYear !== 'string' || !/^\d{4}\/\d{4}$/.test(state.schoolYear))) return 'School year is invalid.';
  if (state.retentionDays !== undefined && ![0, 90, 180, 365].includes(state.retentionDays)) return 'Roster retention period is invalid.';
  if (state.dateLocale !== undefined && !['en-NG', 'en-GB', 'en-US'].includes(state.dateLocale)) return 'Date format is invalid.';
  if (state.togetherRules !== undefined && (typeof state.togetherRules !== 'string' || state.togetherRules.length > 10000)) return 'Keep-together rules are invalid.';
  if (state.apartRules !== undefined && (typeof state.apartRules !== 'string' || state.apartRules.length > 10000)) return 'Keep-apart rules are invalid.';
  if (state.balanceByAttribute !== undefined && typeof state.balanceByAttribute !== 'boolean') return 'Balance setting is invalid.';
  if (state.studentAttributes !== undefined && (!state.studentAttributes || typeof state.studentAttributes !== 'object' || Array.isArray(state.studentAttributes) || Object.entries(state.studentAttributes).some(([key, value]) => key.length > 120 || typeof value !== 'string' || value.length > 80))) return 'Student group attributes are invalid.';
  if (state.appearance !== undefined && (!state.appearance || typeof state.appearance !== 'object' || !/^#[0-9a-f]{6}$/i.test(state.appearance.accent || '') || !/^#[0-9a-f]{6}$/i.test(state.appearance.background || '') || !['light', 'dark'].includes(state.appearance.mode))) return 'Appearance settings are invalid.';
  if (!Array.isArray(state.groups) || state.groups.length > 100) return 'Class results are invalid.';
  let studentCount = 0;
  for (const group of state.groups) {
    if (!group || typeof group.className !== 'string' || group.className.length > 60 || !Array.isArray(group.students)) return 'A class group is invalid.';
    if (group.students.some(name => typeof name !== 'string' || name.length > 120)) return 'A student name is invalid.';
    studentCount += group.students.length;
  }
  if (studentCount > 5000) return 'A roster can contain at most 5,000 students.';
  if (!Array.isArray(state.savedRosters) || state.savedRosters.length > 100) return 'Saved roster list is invalid.';
  for (const record of state.savedRosters) {
    if (!record || typeof record.id !== 'string' || record.id.length > 100 || typeof record.name !== 'string' || record.name.length > 120) return 'A saved roster is invalid.';
    if (!Array.isArray(record.classes) || record.classes.length > 100 || !Array.isArray(record.groups) || record.groups.length > 100) return 'A saved roster contains invalid classes.';
  }
  return null;
}

app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'connecting' });
});

app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  try {
    const account = await Account.findOne({ email, active: true }).lean();
    const salt = account?.salt || 'invalid-account-salt';
    const validPassword = constantTimeEqual(passwordDigest(password, salt), account?.passwordHash || '0'.repeat(128));
    if (!account || !validPassword) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const token = jwt.sign({ sub: String(account._id), email: account.email, name: account.displayName, role: account.role }, process.env.JWT_SECRET, { expiresIn: '12h', issuer: TOKEN_ISSUER });
    await recordAudit(account.email, 'login');
    return res.json({ token, expiresIn: 43200, user: { email: account.email, name: account.displayName, role: account.role } });
  } catch (error) { return next(error); }
});

app.get('/api/auth/me', requireAuth, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ authenticated: true, user: { email: _req.auth.email, name: _req.auth.name, role: _req.auth.role } });
});
app.post('/api/auth/change-password', requireAuth, async (req, res, next) => {
  try {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (currentPassword.length > 256 || newPassword.length < 12 || newPassword.length > 256) return res.status(400).json({ error: 'New password must be 12 to 256 characters.' });
    const account = await Account.findById(req.auth.sub);
    if (!account || !constantTimeEqual(passwordDigest(currentPassword, account.salt), account.passwordHash)) return res.status(401).json({ error: 'Current password is incorrect.' });
    account.salt = crypto.randomBytes(16).toString('hex');
    account.passwordHash = passwordDigest(newPassword, account.salt);
    await account.save();
    await recordAudit(req.auth.email, 'password.changed');
    return res.json({ changed: true });
  } catch (error) { return next(error); }
});

app.get('/api/users', requireAuth, requireAdmin, async (_req, res, next) => {
  try { res.json({ users: await Account.find().select('email displayName role active createdAt').sort({ email: 1 }).lean() }); }
  catch (error) { next(error); }
});
app.post('/api/users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role = req.body?.role === 'admin' ? 'admin' : 'teacher';
    if (!/^\S+@\S+\.\S+$/.test(email) || !displayName || displayName.length > 100 || password.length < 12) return res.status(400).json({ error: 'Provide a valid email, name, and password of at least 12 characters.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await Account.create({ email, displayName, role, salt, passwordHash: passwordDigest(password, salt) });
    await recordAudit(req.auth.email, 'user.created', `${role}:${email}`);
    return res.status(201).json({ user: { email: user.email, displayName: user.displayName, role: user.role, active: user.active } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'That account already exists.' });
    return next(error);
  }
});
app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const user = await Account.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (user.email === req.auth.email || user.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot be removed here.' });
    user.active = false;
    await user.save();
    await recordAudit(req.auth.email, 'user.deactivated', user.email);
    return res.json({ deactivated: true });
  } catch (error) { return next(error); }
});
app.get('/api/audit', requireAuth, requireAdmin, async (_req, res, next) => {
  try { res.json({ entries: await AuditLog.find().sort({ createdAt: -1 }).limit(100).lean() }); }
  catch (error) { next(error); }
});
app.post('/api/audit', requireAuth, async (req, res, next) => {
  const action = typeof req.body?.action === 'string' ? req.body.action : '';
  if (!['roster.exported', 'data.exported'].includes(action)) return res.status(400).json({ error: 'Unsupported audit event.' });
  try { await recordAudit(req.auth.email, action, req.body?.detail || ''); return res.status(201).json({ recorded: true }); }
  catch (error) { return next(error); }
});
app.post('/api/backups', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await createSnapshot('manual');
    await recordAudit(req.auth.email, 'backup.created');
    return res.status(201).json({ created: true });
  } catch (error) { return next(error); }
});
app.get('/api/backups', requireAuth, requireAdmin, async (_req, res, next) => {
  try { res.json({ backups: await Snapshot.find().select('reason createdAt').sort({ createdAt: -1 }).limit(30).lean() }); }
  catch (error) { next(error); }
});
app.post('/api/backups/:id/restore', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const snapshot = await Snapshot.findById(req.params.id).lean();
    if (!snapshot) return res.status(404).json({ error: 'Backup not found.' });
    await createSnapshot('before-restore');
    await SchoolData.findOneAndUpdate({ key: DATA_KEY }, { $set: { state: snapshot.state } }, { upsert: true, new: true });
    await recordAudit(req.auth.email, 'backup.restored', String(snapshot._id));
    return res.json({ restored: true, state: snapshot.state });
  } catch (error) { return next(error); }
});

app.get('/api/data', requireAuth, async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const doc = await SchoolData.findOne({ key: DATA_KEY }).lean();
    res.json({ state: doc?.state || null });
  } catch (error) { next(error); }
});

app.put('/api/data', requireAuth, async (req, res, next) => {
  try {
    const message = validateState(req.body?.state);
    if (message) return res.status(400).json({ error: message });
    await createSnapshot('before-save');
    await SchoolData.findOneAndUpdate(
      { key: DATA_KEY },
      { $set: { state: req.body.state } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    await recordAudit(req.auth.email || 'unknown', 'roster.updated');
    res.set('Cache-Control', 'no-store');
    return res.json({ saved: true });
  } catch (error) { return next(error); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((error, _req, res, _next) => {
  console.error('Request failed:', error.message);
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  return res.status(500).json({ error: 'The server could not complete that request.' });
});

async function start() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await ensureAdminAccount();
  createSnapshot('scheduled').catch(error => console.error('Backup failed:', error.message));
  setInterval(() => createSnapshot('scheduled').catch(error => console.error('Backup failed:', error.message)), 24 * 60 * 60 * 1000).unref();
  console.log('Connected to MongoDB.');
  app.listen(PORT, '0.0.0.0', () => console.log(`School roster app listening on port ${PORT}.`));
}

start().catch(error => {
  console.error('Startup failed:', error.message);
  process.exit(1);
});
