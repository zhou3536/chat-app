const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs').promises;

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    maxHttpBufferSize: 500 * 1024 * 1024 // 500MB
});

// 数据存储路径
const DATA_DIR = path.join(__dirname, 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const FILES_DIR = path.join(DATA_DIR, 'files');

// 存储聊天消息和文件信息（内存中，启动时从文件加载）
let messages = [];
let filesInfo = new Map(); // 存储文件元信息

// 确保数据目录存在
async function ensureDataDir() {
    try {
        await fs.access(DATA_DIR);
    } catch {
        await fs.mkdir(DATA_DIR, { recursive: true });
    }
    
    try {
        await fs.access(FILES_DIR);
    } catch {
        await fs.mkdir(FILES_DIR, { recursive: true });
    }
}

// 加载历史消息
async function loadMessages() {
    try {
        const data = await fs.readFile(MESSAGES_FILE, 'utf8');
        messages = JSON.parse(data);
        console.log(`加载了 ${messages.length} 条历史消息`);
    } catch (error) {
        console.log('没有找到历史消息文件，从空开始');
        messages = [];
    }
}

// 保存消息到文件
async function saveMessages() {
    try {
        await fs.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2));
    } catch (error) {
        console.error('保存消息失败:', error);
    }
}

// 加载文件信息
async function loadFilesInfo() {
    try {
        const files = await fs.readdir(FILES_DIR);
        let count = 0;
        
        for (const file of files) {
            if (file.endsWith('.json')) {
                const infoPath = path.join(FILES_DIR, file);
                const infoData = await fs.readFile(infoPath, 'utf8');
                const fileInfo = JSON.parse(infoData);
                filesInfo.set(fileInfo.id, fileInfo);
                count++;
            }
        }
        console.log(`加载了 ${count} 个文件信息`);
    } catch (error) {
        console.log('加载文件信息失败:', error);
    }
}

// 配置multer用于文件上传（存储到磁盘）
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, FILES_DIR);
    },
    filename: function (req, file, cb) {
        const fileId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const ext = path.extname(file.originalname);
        cb(null, fileId + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB限制
    }
});

// 提供静态文件
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 主页路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 文件上传接口
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '没有文件' });
        }
        
        const fileId = path.parse(req.file.filename).name;
        const fileInfo = {
            id: fileId,
            originalName: req.file.originalname,
            filename: req.file.filename,
            mimetype: req.file.mimetype,
            size: req.file.size,
            uploadTime: new Date().toLocaleString('zh-CN'),
            path: req.file.path
        };
        
        // 保存文件信息到磁盘
        const infoPath = path.join(FILES_DIR, fileId + '.json');
        await fs.writeFile(infoPath, JSON.stringify(fileInfo, null, 2));
        
        // 存储文件信息到内存
        filesInfo.set(fileId, fileInfo);
        
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
app.get('/download/:fileId', async (req, res) => {
    try {
        const fileId = req.params.fileId;
        const fileInfo = filesInfo.get(fileId);
        
        if (!fileInfo) {
            return res.status(404).json({ error: '文件不存在' });
        }
        
        // 检查文件是否存在
        try {
            await fs.access(fileInfo.path);
        } catch {
            return res.status(404).json({ error: '文件已被删除' });
        }
        
        res.set({
            'Content-Type': fileInfo.mimetype,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(fileInfo.originalName)}"`,
            'Content-Length': fileInfo.size
        });
        
        res.sendFile(path.resolve(fileInfo.path));
    } catch (error) {
        console.error('文件下载错误:', error);
        res.status(500).json({ error: '下载失败' });
    }
});

// 管理员清空接口
app.post('/clear-all', async (req, res) => {
    try {
        // 清空消息
        messages = [];
        await saveMessages();
        
        // 删除所有文件
        const files = await fs.readdir(FILES_DIR);
        for (const file of files) {
            await fs.unlink(path.join(FILES_DIR, file));
        }
        
        // 清空文件信息
        filesInfo.clear();
        
        // 通知所有客户端清空
        io.emit('clear all');
        
        console.log('已清空所有数据');
        res.json({ success: true, message: '已清空所有消息和文件' });
    } catch (error) {
        console.error('清空数据失败:', error);
        res.status(500).json({ error: '清空失败' });
    }
});

// Socket.io连接处理
io.on('connection', (socket) => {
    console.log('用户连接:', socket.id);
    
    // 发送历史消息给新连接的用户
    socket.emit('load messages', messages);
    
    // 处理新消息
    socket.on('chat message', async (data) => {
        const message = {
            id: Date.now(),
            username: data.username || '匿名用户',
            type: 'text',
            text: data.text,
            timestamp: new Date().toLocaleString('zh-CN')
        };
        
        // 保存消息
        messages.push(message);
        
        // 限制消息数量（保留最新1000条）
        if (messages.length > 1000) {
            const removedMessages = messages.splice(0, messages.length - 1000);
            // 清理相关的文件
            for (const msg of removedMessages) {
                if (msg.type === 'file' && msg.fileId) {
                    try {
                        const fileInfo = filesInfo.get(msg.fileId);
                        if (fileInfo) {
                            await fs.unlink(fileInfo.path);
                            await fs.unlink(path.join(FILES_DIR, msg.fileId + '.json'));
                            filesInfo.delete(msg.fileId);
                        }
                    } catch (error) {
                        console.error('删除旧文件失败:', error);
                    }
                }
            }
        }
        
        // 保存到文件
        await saveMessages();
        
        // 广播消息给所有用户
        io.emit('chat message', message);
    });
    
    // 处理文件消息
    socket.on('file message', async (data) => {
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
        
        // 限制消息数量（保留最新1000条）
        if (messages.length > 1000) {
            const removedMessages = messages.splice(0, messages.length - 1000);
            // 清理相关的文件
            for (const msg of removedMessages) {
                if (msg.type === 'file' && msg.fileId) {
                    try {
                        const fileInfo = filesInfo.get(msg.fileId);
                        if (fileInfo) {
                            await fs.unlink(fileInfo.path);
                            await fs.unlink(path.join(FILES_DIR, msg.fileId + '.json'));
                            filesInfo.delete(msg.fileId);
                        }
                    } catch (error) {
                        console.error('删除旧文件失败:', error);
                    }
                }
            }
        }
        
        // 保存到文件
        await saveMessages();
        
        // 广播消息给所有用户
        io.emit('file message', message);
    });
    
    // 用户断开连接
    socket.on('disconnect', () => {
        console.log('用户断开连接:', socket.id);
    });
});

// 启动服务器前初始化数据
async function initServer() {
    await ensureDataDir();
    await loadMessages();
    await loadFilesInfo();
    
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`聊天服务器运行在端口 ${PORT}`);
        console.log(`本地访问: http://localhost:${PORT}`);
        console.log(`局域网访问: http://你的服务器IP:${PORT}`);
        console.log(`数据存储目录: ${DATA_DIR}`);
    });
}

// 优雅关闭
process.on('SIGINT', async () => {
    console.log('\n正在保存数据并关闭服务器...');
    await saveMessages();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n正在保存数据并关闭服务器...');
    await saveMessages();
    process.exit(0);
});

// 启动服务器
initServer().catch(console.error);