const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

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

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(uploadsDir));

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // 保持原文件名，支持中文
    // cb(null, Date.now() + '-' + originalName);
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null,originalName);
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

// 保存聊天历史
function saveChatHistory() {
  try {
    fs.writeFileSync(chatLogFile, JSON.stringify(chatHistory, null, 2), 'utf8');
  } catch (error) {
    console.error('保存聊天历史失败:', error);
  }
}

// 初始化加载聊天历史
loadChatHistory();

// Socket.IO 连接处理
io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);
  
  // 发送历史聊天记录
  socket.emit('chat history', chatHistory);
  
  // 处理新消息
  socket.on('chat message', (data) => {
    const message = {
      id: Date.now(),
      username: data.username,
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
    chatHistory = [];
    saveChatHistory();
    io.emit('history cleared');
  });
  
  socket.on('disconnect', () => {
    console.log('用户断开连接:', socket.id);
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
      res.download(filePath);
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`启动成功！浏览器访问: http://你的IP:${PORT}`);
});