import dotenv from 'dotenv';
import { initializeUsers } from './users.js';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { readFile, writeFile } from 'fs/promises';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import cookieParser from 'cookie-parser';
// 模拟 CommonJS 中的 __dirname 和 __filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);

dotenv.config();
const PORT = process.env.PORT || '3000';
const HOST = process.env.HOST || '127.0.0.1';
const COOKIE_SECRET = process.env.cookieSecret;
const loadJson = async () => {
  const filePath = './users.json';
  try {
    if (!fs.existsSync(filePath)) await writeFile(filePath, '[]', 'utf-8');
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`读取或创建 ${filePath} 失败:`, err);
    process.exit(1);
  }
};
let users = await loadJson();

// 确保数据目录存在
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const chatLogFile = path.join(dataDir, 'chat.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use(express.json());
initializeUsers(app, users);
// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(uploadsDir));


const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  allowRequest: (req, callback) => {
    cookieParser(COOKIE_SECRET)(req, {}, () => {
      callback(null, true);
    });
  }
});
// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // 保持原文件名，支持中文，确保文件名编码正确
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, originalName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB限制
});

// 聊天记录存储
let chatHistory = [];

// 加载聊天历史
function loadChatHistory() {
  try {
    if (fs.existsSync(chatLogFile)) {
      const data = fs.readFileSync(chatLogFile, 'utf8');
      chatHistory = JSON.parse(data);
    }
  } catch (error) {
    console.error('加载聊天历史失败:', error);
    chatHistory = [];
  }
}
// 初始化加载聊天历史
loadChatHistory();

// 保存聊天历史
function saveChatHistory() {
  try {
    fs.writeFileSync(chatLogFile, JSON.stringify(chatHistory, null, 2), 'utf8');
  } catch (error) {
    console.error('保存聊天历史失败:', error);
  }
}



// Socket.IO 连接处理
io.on('connection', (socket) => {
  const userId = socket.request.signedCookies?.session_id?.userId;
  const sessionToken = socket.request.signedCookies?.session_id?.sessionToken;
  const user = users.find(user => user.userId === userId && user.sessionToken === sessionToken);
  if (user) {
    socket.user = user;
    socket.userId = userId;
  } else {
    socket.emit('refresh','signup.html');
    socket.disconnect();
    return;
  }
  socket.emit('id', { username: user.username, id: user.userId });
  socket.emit('chat history', chatHistory);

  // 处理新消息
  socket.on('chat message', (data) => {
    const message = {
      id: Date.now(),
      username: socket.user.username,
      message: data.message,
      timestamp: new Date().toLocaleString('zh-CN')
    };
    chatHistory.push(message);
    saveChatHistory();
    // 广播消息给所有客户端
    io.emit('chat message', message);
  });

  // 处理清空记录
  socket.on('clear history', () => {
    if (socket.userId !== 'admin') {
      socket.emit('error', '食不食油饼');
      return
    };
    chatHistory = [];
    saveChatHistory();
    io.emit('history cleared');
  });

  //删除单个历史记录
  socket.on('deletemessage', (id) => {
    if (socket.userId !== 'admin') {
      socket.emit('error', '食不食油饼');
      return
    };
    console.log('删除消息：', id)
    chatHistory = chatHistory.filter(item => item.id !== id);
    saveChatHistory();
    io.emit('chat history', chatHistory);
  });

  socket.on('disconnect', () => {

  });
});

// API路由
// 文件上传
app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '没有文件被上传' });
    }

    res.json({
      message: '文件上传成功',
      filename: req.file.filename,
      originalname: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      size: req.file.size
    });
  } catch (error) {
    console.error('文件上传错误:', error);
    res.status(500).json({ error: '文件上传失败' });
  }
});

// 获取文件列表
app.get('/files', (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir);
    const fileList = files.map(filename => {
      const filePath = path.join(uploadsDir, filename);
      const stats = fs.statSync(filePath);
      return {
        name: filename,
        size: stats.size,
        uploadTime: stats.mtime.toLocaleString('zh-CN'),
        mtime: stats.mtime.getTime() // 添加时间戳用于排序
      };
    });
    fileList.sort((a, b) => b.mtime - a.mtime);
    // 移除临时字段并返回
    const result = fileList.map(({ mtime, ...keep }) => keep);
    res.json(result);
  } catch (error) {
    console.error('获取文件列表错误:', error);
    res.status(500).json({ error: '获取文件列表失败' });
  }
});

// 文件下载
app.get('/download/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(uploadsDir, filename);

    if (fs.existsSync(filePath)) {
      // res.download 会自动设置 Content-Disposition 头，以提供文件下载
      // 确保发送的 originalname 是 UTF-8 编码且正确处理
      const originalName = Buffer.from(filename, 'latin1').toString('utf8'); // 假设文件名是 UTF-8
      res.download(filePath, originalName);
    } else {
      res.status(404).json({ error: '文件不存在' });
    }
  } catch (error) {
    console.error('文件下载错误:', error);
    res.status(500).json({ error: '文件下载失败' });
  }
});

// 删除文件
app.delete('/files/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(uploadsDir, filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ message: '文件删除成功' });
    } else {
      res.status(404).json({ error: '文件不存在' });
    }
  } catch (error) {
    console.error('文件删除错误:', error);
    res.status(500).json({ error: '文件删除失败' });
  }
});

// 启动服务器
server.listen(PORT, HOST, () => {
  console.log(`启动成功 : http://${HOST}:${PORT}`);
});
