const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');


const MONGO_URI = '';
const JWT_SECRET = '';
const PORT = 3000;

const app = express();
app.use(express.json());
app.use(cors());


const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const onlineSessionSchema = new mongoose.Schema({
  username: { type: String, required: true },
  token: { type: String, required: true },
  lastHeartbeat: { type: Date, default: Date.now }
});
const OnlineSession = mongoose.model('OnlineSession', onlineSessionSchema);


const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'تعداد درخواست‌های مجاز تمام شده. کمی صبر کنید.' }
});


function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'توکن یافت نشد' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'توکن نامعتبر' });
    req.user = user;
    next();
  });
}


app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'نام کاربری و رمز عبور الزامی است' });

  const existingUser = await User.findOne({ username });
  if (existingUser) return res.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = new User({ username, passwordHash });
  await user.save();

  res.status(201).json({ message: 'کاربر با موفقیت ایجاد شد' });
});


app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'نام کاربری و رمز عبور را وارد کنید' });

  const user = await User.findOne({ username });
  if (!user) return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '7d' });

  await OnlineSession.findOneAndUpdate(
    { username: user.username },
    { token, lastHeartbeat: new Date() },
    { upsert: true, new: true }
  );

  res.json({ success: true, token, username: user.username });
});

app.get('/api/auth-check', authenticateToken, (req, res) => {
  res.json({ isAuthenticated: true, username: req.user.username });
});

app.post('/api/logout', authenticateToken, async (req, res) => {
  await OnlineSession.deleteOne({ username: req.user.username });
  res.json({ success: true });
});

app.post('/api/heartbeat', authenticateToken, async (req, res) => {
  await OnlineSession.findOneAndUpdate(
    { username: req.user.username },
    { lastHeartbeat: new Date() }
  );
  res.json({ success: true });
});

app.get('/api/online-count', async (req, res) => {
  const onlineThreshold = new Date(Date.now() - 5 * 60 * 1000); // ۵ دقیقه
  const count = await OnlineSession.countDocuments({ lastHeartbeat: { $gte: onlineThreshold } });
  res.json({ online: count });
});


async function connectDB(retries = 5, delay = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000
      });
      console.log('✅ MongoDB connected');
      return true;
    } catch (err) {
      console.error(`❌ Attempt ${attempt}/${retries} - MongoDB connection error: ${err.message}`);
      if (attempt < retries) {
        console.log(`🔄 Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  return false;
}


mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected');
});
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB runtime error:', err.message);
});


async function startServer() {
  const dbConnected = await connectDB();
  if (!dbConnected) {
    console.error('🚨 SERVER START FAILED: No database connection');
    return { success: false, error: 'Database connection failed' };
  }

  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      resolve({ success: true, server });
    }).on('error', (err) => {
      console.error('❌ Express server error:', err.message);
      resolve({ success: false, error: err.message });
    });
  });
}

module.exports = { startServer, app };
