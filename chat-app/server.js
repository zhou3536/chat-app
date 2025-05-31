const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    maxHttpBufferSize: 100 * 1024 * 1024 // 100MB
});

// 存储聊天消息和文件（内存中）
let messages = [];
let files = new Map(); // 存储文件数据

// 配置multer用于文件上传（存储在内存中）
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB限制
    }
});

// 提供静态文件
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 文件上传接口
app.post('/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '没有文件' });
        }
        
        const fileId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const fileData = {
            id: fileId,
            originalName: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            buffer: req.file.buffer,
            uploadTime: new Date().toLocaleString('zh-CN')
        };
        
        // 存储文件到内存
        files.set(fileId, fileData);
        
        res.json({
            success: true,
            fileId: fileId,
            fileName: req.file.originalname,
            fileSize: req.file.size
        });
    } catch (error) {
        console.error('文件上传错误:', error);
        res.status(500).json({ error: '上传失败' });
    }
});

// 文件下载接口
app.get('/download/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const fileData = files.get(fileId);
    
    if (!fileData) {
        return res.status(404).json({ error: '文件不存在' });
    }
    
    res.set({
        'Content-Type': fileData.mimetype,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileData.originalName)}"`,
        'Content-Length': fileData.size
    });
    
    res.send(fileData.buffer);
});

// 管理员清空接口
app.post('/clear-all', (req, res) => {
    messages = [];
    files.clear();
    
    // 通知所有客户端清空
    io.emit('clear all');
    
    res.json({ success: true, message: '已清空所有消息和文件' });
});

// 主页路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io连接处理
io.on('connection', (socket) => {
    console.log('用户连接:', socket.id);
    
    // 发送历史消息给新连接的用户
    socket.emit('load messages', messages);
    
    // 处理新消息
    socket.on('chat message', (data) => {
        const message = {
            id: Date.now(),
            username: data.username || '匿名用户',
            type: 'text',
            text: data.text,
            timestamp: new Date().toLocaleString('zh-CN')
        };
        
        // 保存消息
        messages.push(message);
        
        // 限制消息数量（保留最新100条）
        if (messages.length > 100) {
            const removedMessages = messages.splice(0, messages.length - 100);
            // 清理相关的文件
            removedMessages.forEach(msg => {
                if (msg.type === 'file' && msg.fileId) {
                    files.delete(msg.fileId);
                }
            });
        }
        
        // 广播消息给所有用户
        io.emit('chat message', message);
    });
    
    // 处理文件消息
    socket.on('file message', (data) => {
        const message = {
            id: Date.now(),
            username: data.username || '匿名用户',
            type: 'file',
            fileId: data.fileId,
            fileName: data.fileName,
            fileSize: data.fileSize,
            timestamp: new Date().toLocaleString('zh-CN')
        };
        
        // 保存消息
        messages.push(message);
        
        // 限制消息数量（保留最新100条）
        if (messages.length > 100) {
            const removedMessages = messages.splice(0, messages.length - 100);
            // 清理相关的文件
            removedMessages.forEach(msg => {
                if (msg.type === 'file' && msg.fileId) {
                    files.delete(msg.fileId);
                }
            });
        }
        
        // 广播消息给所有用户
        io.emit('file message', message);
    });
    
    // 用户断开连接
    socket.on('disconnect', () => {
        console.log('用户断开连接:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`聊天服务器运行在端口 ${PORT}`);
    console.log(`本地访问: http://localhost:${PORT}`);
    console.log(`局域网访问: http://你的服务器IP:${PORT}`);
});