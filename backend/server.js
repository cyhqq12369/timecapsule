const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const { URL } = require('url');

// AWS S3 SDK v3 for R2
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const PORT = process.env.PORT || 3000;
const CAPSULES_FILE = path.join(__dirname, 'capsules.json');
const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const STATS_FILE = path.join(__dirname, 'stats.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

// ============ 统计功能 ===========
function loadStats() {
  if (!fs.existsSync(STATS_FILE)) {
    const initial = {
      pageViews: 0, registrations: 0, logins: 0,
      capsulesCreated: 0, ttsGenerated: 0,
      lastUpdated: new Date().toISOString(), history: []
    };
    fs.writeFileSync(STATS_FILE, JSON.stringify(initial));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
  } catch (e) {
    return { pageViews: 0, registrations: 0, logins: 0, capsulesCreated: 0, ttsGenerated: 0, lastUpdated: new Date().toISOString(), history: [] };
  }
}

function saveStats(stats) {
  stats.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function recordStat(type, detail) {
  try {
    const stats = loadStats();
    if (stats[type] !== undefined) stats[type]++;
    const entry = { type, detail: detail || '', ts: new Date().toISOString() };
    stats.history = stats.history || [];
    stats.history.unshift(entry);
    if (stats.history.length > 500) stats.history = stats.history.slice(0, 500);
    saveStats(stats);
  } catch (e) {
    console.error('[stats] recordStat error:', e.message);
  }
}

// 页面访问统计中间件（跳过 API / favicon / voices）
app.use((req, res, next) => {
  if (req.path !== '/favicon.ico' && !req.path.startsWith('/api') && !req.path.startsWith('/voices')) {
    recordStat('pageViews', req.path);
  }
  next();
});

// ============ R2 Cloudflare 配置 ============
const R2_CLIENT = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const R2_BUCKET = process.env.R2_BUCKET || 'timecapsule-voices';

async function uploadToR2(fileName, buffer, contentType) {
  const command = new PutObjectCommand({ Bucket: R2_BUCKET, Key: fileName, Body: buffer, ContentType: contentType || 'audio/mpeg' });
  await R2_CLIENT.send(command);
}

async function getR2PresignedUrl(fileName, expiresIn) {
  const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: fileName });
  return getSignedUrl(R2_CLIENT, command, { expiresIn: expiresIn || 604800 });
}

// ============ Session 持久化存储 ===========
function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) { fs.writeFileSync(SESSIONS_FILE, JSON.stringify({})); return new Map(); }
  try {
    const obj = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    const map = new Map();
    for (const [k, v] of Object.entries(obj)) map.set(k, v);
    return map;
  } catch (e) { return new Map(); }
}
function saveSessions() { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions))); }
const sessions = loadSessions();

function safeFilename(str) {
  return (str || '').trim().replace(/[\/\\:*?"<>|]/g, '_');
}

function loadCapsules() {
  if (!fs.existsSync(CAPSULES_FILE)) { fs.writeFileSync(CAPSULES_FILE, JSON.stringify([])); return []; }
  try { return JSON.parse(fs.readFileSync(CAPSULES_FILE, 'utf-8')); } catch (e) { return []; }
}
function saveCapsules(capsules) { fs.writeFileSync(CAPSULES_FILE, JSON.stringify(capsules, null, 2)); }

function loadFeedback() {
  if (!fs.existsSync(FEEDBACK_FILE)) { fs.writeFileSync(FEEDBACK_FILE, JSON.stringify([])); return []; }
  try { return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8')); } catch (e) { return []; }
}
function saveFeedback(feedback) { fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2)); }

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) { fs.writeFileSync(USERS_FILE, JSON.stringify([])); return []; }
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')); } catch (e) { return []; }
}
function saveUsers(users) { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }

function getUser(phone) { return loadUsers().find(u => u.phone === phone); }
function saveUser(userData) {
  const users = loadUsers();
  const idx = users.findIndex(u => u.phone === userData.phone);
  if (idx >= 0) { users[idx] = { ...users[idx], ...userData, updatedAt: new Date().toISOString() }; }
  else { users.push({ ...userData, createdAt: new Date().toISOString() }); }
  saveUsers(users);
}

// ============ 登录 API ============
app.post('/api/register', (req, res) => {
  recordStat('registrations', req.body.phone || '');
  const { phone, password, wechatContact } = req.body;
  if (!phone || !/^1\d{10}$/.test(phone)) { return res.status(400).json({ error: '请输入正确的11位手机号' }); }
  if (!password || password.length < 4) { return res.status(400).json({ error: '密码至少4位' }); }
  const existing = getUser(phone);
  if (existing) { return res.status(400).json({ error: '该手机号已注册，请直接登录' }); }
  saveUser({ phone, password, wechatContact: wechatContact || '' });
  const token = uuidv4();
  sessions.set(token, { phone, wechatContact: wechatContact || '', createdAt: new Date().toISOString() }); saveSessions();
  res.json({ success: true, token, phone });
});

app.post('/api/login', (req, res) => {
  recordStat('logins', req.body.phone || '');
  const { phone, password, wechatContact } = req.body;
  if (!phone || !password) { return res.status(400).json({ error: '手机号和密码不能为空' }); }
  const user = getUser(phone);
  if (!user) { return res.status(400).json({ error: '该手机号未注册，请先注册' }); }
  if (user.password !== password) { return res.status(400).json({ error: '密码错误' }); }
  const token = uuidv4();
  sessions.set(token, { phone, wechatContact: wechatContact || user.wechatContact || '', createdAt: new Date().toISOString() }); saveSessions();
  saveUser({ phone, password: user.password, wechatContact: wechatContact || user.wechatContact || '', lastLogin: new Date().toISOString() });
  res.json({ success: true, token, phone });
});

app.get('/api/me', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) { return res.status(401).json({ error: '未登录' }); }
  const session = sessions.get(token);
  const user = getUser(session.phone);
  res.json({ phone: session.phone, wechatContact: session.wechatContact, user });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) { sessions.delete(token); saveSessions(); }
  res.json({ success: true });
});

// ============ 意见反馈 ============
app.post('/api/feedback', (req, res) => {
  const { content, contact } = req.body;
  if (!content || !content.trim()) { return res.status(400).json({ error: 'Feedback content cannot be empty' }); }
  const entry = { id: uuidv4(), content: content.trim(), contact: contact ? contact.trim() : '', createdAt: new Date().toISOString() };
  const feedback = loadFeedback();
  feedback.unshift(entry);
  saveFeedback(feedback);
  res.json({ success: true, feedback: entry });
});
app.get('/api/feedback', (req, res) => { res.json({ feedback: loadFeedback() }); });

// ============ 时光胶囊 ============
app.post('/api/capsule', (req, res) => {
  recordStat('capsulesCreated');
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) { return res.status(401).json({ error: '请先登录' }); }
  const session = sessions.get(token);
  const { from, to, message, deliveryDate, voiceText } = req.body;
  if (!from || !to || !message || !deliveryDate) { return res.status(400).json({ error: 'Missing required fields' }); }
  const capsule = {
    id: uuidv4(), phone: session.phone, wechatContact: session.wechatContact,
    from, to, message, voiceText: voiceText || null,
    deliveryDate, createdAt: new Date().toISOString(), delivered: false, audioData: null
  };
  const capsules = loadCapsules();
  capsules.push(capsule);
  saveCapsules(capsules);
  res.json({ success: true, capsule });
});

app.get('/api/capsules', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const { from, to } = req.query;
  let capsules = loadCapsules();
  if (!token || !sessions.has(token)) { return res.json({ capsules: [] }); }
  const session = sessions.get(token);
  capsules = capsules.filter(c => c.phone === session.phone);
  if (from) capsules = capsules.filter(c => c.from.toLowerCase().includes(from.toLowerCase()));
  if (to) capsules = capsules.filter(c => c.to.toLowerCase().includes(to.toLowerCase()));
  res.json({ capsules });
});

app.get('/api/capsule/:id', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) { return res.status(401).json({ error: '请先登录' }); }
  const capsules = loadCapsules();
  const capsule = capsules.find(c => c.id === req.params.id);
  if (!capsule) return res.status(404).json({ error: 'Capsule not found' });
  res.json({ capsule });
});

app.get('/api/check', (req, res) => {
  const now = new Date();
  const capsules = loadCapsules();
  const dueCapsules = [];
  const updated = capsules.map(c => {
    if (!c.delivered && new Date(c.deliveryDate) <= now) { dueCapsules.push({ ...c, delivered: true }); return { ...c, delivered: true }; }
    return c;
  });
  if (dueCapsules.length > 0) saveCapsules(updated);
  res.json({ dueCapsules });
});

app.post('/api/capsule/:id/deliver', (req, res) => {
  const capsules = loadCapsules();
  const idx = capsules.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Capsule not found' });
  capsules[idx].delivered = true;
  saveCapsules(capsules);
  res.json({ success: true, capsule: capsules[idx] });
});

// ============ TTS ============
app.post('/api/tts', async (req, res) => {
  recordStat('ttsGenerated');
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) { return res.status(401).json({ error: '请先登录' }); }
  const session = sessions.get(token);
  const { text, capsuleId } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const phoneStr = safeFilename(session.phone);
  const wechatStr = safeFilename(session.wechatContact || '未知微信');
  let fileName = capsuleId
    ? (() => {
        const capsules = loadCapsules();
        const capsule = capsules.find(c => c.id === capsuleId);
        return capsule
          ? `${phoneStr}_${wechatStr}_${dateStr}_${safeFilename(capsule.from)}to${safeFilename(capsule.to)}.mp3`
          : `${phoneStr}_${wechatStr}_${dateStr}.mp3`;
      })()
    : `${phoneStr}_${wechatStr}_${dateStr}.mp3`;

  const voicesDir = '/app/voices';
  const localFilePath = path.join(voicesDir, fileName);
  const jobId = uuidv4();
  if (!fs.existsSync(voicesDir)) { fs.mkdirSync(voicesDir, { recursive: true }); }

  const isLinux = process.env.RAILWAY || process.env.NODE_ENV === 'production';
  let cmd;
  if (!isLinux) {
    cmd = `say -o "${localFilePath}" --audio-quality=High "${text.replace(/"/g, '\"')}"`;
  } else {
    const scriptPath = path.join(__dirname, 'tts_worker.py');
    cmd = `python3 "${scriptPath}" "${text.replace(/"/g, '\"')}" "${localFilePath}"`;
  }
  console.log('[TTS job', jobId, '] cmd:', cmd);

  try {
    const { stdout, stderr } = await execPromise(cmd, { timeout: 60000 });
    console.log('[TTS job', jobId, '] done, stdout:', stdout);
    if (!fs.existsSync(localFilePath)) {
      console.error('[TTS job', jobId, '] file not created:', localFilePath);
      return res.status(500).json({ error: 'TTS file not created' });
    }
    const mp3Buffer = fs.readFileSync(localFilePath);
    const base64Audio = mp3Buffer.toString('base64');
    const dataUrl = `data:audio/mpeg;base64,${base64Audio}`;
    res.json({ success: true, audioUrl: dataUrl, message: '语音生成成功' });

    if (capsuleId) {
      const capsules = loadCapsules();
      const cap = capsules.find(c => c.id === capsuleId);
      if (cap) { cap.audioData = base64Audio; saveCapsules(capsules); }
    }
  } catch (err) {
    console.error('[TTS job', jobId, '] error:', err.message);
    return res.status(500).json({ error: 'TTS failed: ' + err.message });
  }
});

// ============ 管理员 API ============
app.get('/api/admin/capsule/:id/audio', (req, res) => {
  const adminPassword = req.headers['x-admin-password'] || req.query.password;
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) { return res.status(403).json({ error: '无权限' }); }
  try {
    const capsules = loadCapsules();
    const capsule = capsules.find(c => c.id === req.params.id);
    if (!capsule) return res.status(404).json({ error: '胶囊不存在' });
    if (!capsule.audioData) return res.status(404).json({ error: '该胶囊暂无语音' });
    const buffer = Buffer.from(capsule.audioData, 'base64');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="voice.mp3"`);
    res.send(buffer);
  } catch (err) { res.status(500).json({ error: '服务器错误: ' + err.message }); }
});

app.get('/api/admin/capsules', (req, res) => {
  const adminPassword = req.headers['x-admin-password'] || req.query.password;
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) { return res.status(403).json({ error: '无权限' }); }
  const capsules = loadCapsules();
  const list = capsules
    .filter(c => c.audioData)
    .map(c => ({ id: c.id, phone: c.phone, wechatContact: c.wechatContact, from: c.from, to: c.to, message: c.message, deliveryDate: c.deliveryDate, createdAt: c.createdAt, hasAudio: true }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ capsules: list, total: list.length });
});

app.get('/api/voices/:fileName', async (req, res) => {
  try { const url = await getR2PresignedUrl(req.params.fileName); res.json({ url }); }
  catch (e) { res.status(500).json({ error: 'Cannot generate URL: ' + e.message }); }
});

app.get('/api/users', (req, res) => { res.json({ users: loadUsers() }); });

// ============ 统计 API (管理员) ============
app.get('/api/stats', (req, res) => {
  const adminPassword = req.headers['x-admin-password'] || req.query.password;
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'admin123')) { return res.status(403).json({ error: '无权限' }); }
  const stats = loadStats();
  const summary = {
    pageViews: stats.pageViews,
    registrations: stats.registrations,
    logins: stats.logins,
    capsulesCreated: stats.capsulesCreated,
    ttsGenerated: stats.ttsGenerated,
    lastUpdated: stats.lastUpdated,
    recentHistory: (stats.history || []).slice(0, 50)
  };
  res.json(summary);
});

// ============ DEBUG TTS ============
app.post('/api/tts-test', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) { return res.status(401).json({ error: '请先登录' }); }
  const { exec: execSync } = require('child_process');
  const testFile = '/tmp/tts_test_debug.mp3';
  const scriptPath = path.join(__dirname, 'tts_worker.py');
  console.log('=== TTS DEBUG START ===');
  console.log('script exists:', fs.existsSync(scriptPath));
  execSync('python3 --version', { timeout: 5000 }, (err, stdout, stderr) => { console.log('python stdout:', stdout, 'stderr:', stderr); });
  const cmd = `python3 "${scriptPath}" "测试" "${testFile}"`;
  console.log('cmd:', cmd);
  execSync(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
    console.log('exec err:', err, 'stdout:', stdout, 'stderr:', stderr);
    console.log('file exists:', fs.existsSync(testFile));
    if (fs.existsSync(testFile)) { console.log('file size:', fs.statSync(testFile).size); }
    console.log('=== TTS DEBUG END ===');
    if (err) res.json({ error: 'TTS failed', stderr }); else res.json({ success: true, stdout, fileExists: fs.existsSync(testFile) });
  });
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => { console.log('时光宝盒 server running on http://' + HOST + ':' + PORT + ' (env PORT=' + process.env.PORT + ')'); });
