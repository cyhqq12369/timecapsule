const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
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
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

// R2 Cloudflare 配置（环境变量注入，代码库不存 secrets）
const R2_CLIENT = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const R2_BUCKET = process.env.R2_BUCKET || 'timecapsule-voices';

async function uploadToR2(fileName, buffer, contentType = 'audio/mpeg') {
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: fileName,
    Body: buffer,
    ContentType: contentType,
  });
  await R2_CLIENT.send(command);
}

async function getR2PresignedUrl(fileName, expiresIn = 604800) {
  const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: fileName });
  return getSignedUrl(R2_CLIENT, command, { expiresIn });
}

// ============ Session 持久化存储（文件）==========
function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) { fs.writeFileSync(SESSIONS_FILE, JSON.stringify({})); return new Map(); }
  try { const obj = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')); const map = new Map(); for (const [k, v] of Object.entries(obj)) map.set(k, v); return map; } catch (e) { return new Map(); }
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

function getUser(phone) {
  return loadUsers().find(u => u.phone === phone);
}
function saveUser(userData) {
  const users = loadUsers();
  const idx = users.findIndex(u => u.phone === userData.phone);
  if (idx >= 0) { users[idx] = { ...users[idx], ...userData, updatedAt: new Date().toISOString() }; }
  else { users.push({ ...userData, createdAt: new Date().toISOString() }); }
  saveUsers(users);
}

// ============ 登录 API ============
app.post('/api/register', (req, res) => {
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
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) { return res.status(401).json({ error: '请先登录' }); }
  const session = sessions.get(token);
  const { from, to, message, deliveryDate, voiceText } = req.body;
  if (!from || !to || !message || !deliveryDate) { return res.status(400).json({ error: 'Missing required fields' }); }
  const capsule = {
    id: uuidv4(), phone: session.phone, wechatContact: session.wechatContact,
    from, to, message, voiceText: voiceText || null,
    deliveryDate, createdAt: new Date().toISOString(), delivered: false
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

// ============ TTS → R2 ============
app.post('/api/tts', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) { return res.status(401).json({ error: '请先登录' }); }
  const session = sessions.get(token);
  const { text, capsuleId } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const phoneStr = safeFilename(session.phone);
  const wechatStr = safeFilename(session.wechatContact || '未知微信');

  let fileName;
  if (capsuleId) {
    const capsules = loadCapsules();
    const capsule = capsules.find(c => c.id === capsuleId);
    if (capsule) {
      fileName = `${phoneStr}_${wechatStr}_${dateStr}_${safeFilename(capsule.from)}to${safeFilename(capsule.to)}.mp3`;
    } else {
      fileName = `${phoneStr}_${wechatStr}_${dateStr}.mp3`;
    }
  } else {
    fileName = `${phoneStr}_${wechatStr}_${dateStr}.mp3`;
  }

  // ============ Edge TTS（免费，无需API Key）===========
  const { exec } = require('child_process');
  const voicesDir = '/app/voices';
  const localFilePath = path.join(voicesDir, fileName);

  // 确保目录存在（Railway挂载的Volume）
  if (!fs.existsSync(voicesDir)) { fs.mkdirSync(voicesDir, { recursive: true }); }

  // 调用 edge-tts 生成音频
  await new Promise((resolve, reject) => {
    exec(`edge-tts --voice zh-CN-XiaoxiaoNeural --rate='+0%' --volume='+0%' --pitch='+0Hz' --text=${JSON.stringify(text)} --audio-output=${localFilePath}`,
      (err, stdout, stderr) => {
        if (err) { console.error('edge-tts error:', stderr); reject(new Error('edge-tts failed: ' + stderr)); return; }
        resolve();
      }
    );
  });

  // 读取生成的MP3文件并上传R2
  const mp3Buffer = fs.readFileSync(localFilePath);
  await uploadToR2(fileName, mp3Buffer, 'audio/mpeg');

  // 返回 presigned URL（7天有效），前端可直接播放
  const presignedUrl = await getR2PresignedUrl(fileName);
  res.json({ success: true, fileName, voiceUrl: presignedUrl });
});

// 获取语音文件 presigned URL（R2）
app.get('/api/voices/:fileName', async (req, res) => {
  try {
    const url = await getR2PresignedUrl(req.params.fileName);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: 'Cannot generate URL: ' + e.message });
  }
});

app.get('/api/users', (req, res) => { res.json({ users: loadUsers() }); });

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => { console.log('时光宝盒 server running on http://' + HOST + ':' + PORT + ' (env PORT=' + process.env.PORT + ')'); });
