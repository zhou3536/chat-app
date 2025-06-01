const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// 配置常量
const MAX_MESSAGES = 100;
const MAX_STORAGE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB
const MAX_FILE_SIZE = 150 * 1024 * 1024; // 150MB

// 中间件
app.use(express.json());
app.use(express.static('public'));

// 确保目录存在
async function ensureDirectories() {
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
    
    // 初始化消息文件
    try {
        await fs.access(MESSAGES_FILE);
    } catch {
        await fs.writeFile(MESSAGES_FILE, JSON.stringify([]));
    }
}

// 读取消息
async function readMessages() {
    try {
        const data = await fs.readFile(MESSAGES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('读取消息失败:', error);
        return [];
    }
}

// 写入消息
async function writeMessages(messages) {
    try {
        await fs.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2));
    } catch (error) {
        console.error('写入消息失败:', error);
    }
}

// 清理旧消息
async function cleanupMessages() {
    const messages = await readMessages();
    if (messages.length > MAX_MESSAGES) {
        const newMessages = messages.slice(-MAX_MESSAGES);
        await writeMessages(newMessages);
        console.log(`清理了 ${messages.length - newMessages.length} 条旧消息`);
    }
}

// 获取目录大小
async function getDirectorySize(dirPath) {
    let totalSize = 0;
    
    try {
        const files = await fs.readdir(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = await fs.stat(filePath);
            if (stats.isFile()) {
                totalSize += stats.size;
            }
        }
    } catch (error) {
        console.error('计算目录大小失败:', error);
    }
    
    return totalSize;
}

// 清理旧文件
async function cleanupFiles() {
    const currentSize = await getDirectorySize(FILES_DIR);
    
    if (currentSize > MAX_STORAGE_SIZE) {
        try {
            const files = await fs.readdir(FILES_DIR);
            const fileStats = [];
            
            for (const file of files) {
                const filePath = path.join(FILES_DIR, file);
                const stats = await fs.stat(filePath);
                fileStats.push({
                    name: file,
                    path: filePath,
                    size: stats.size,
                    mtime: stats.mtime
                });
            }
            
            // 按修改时间排序，删除最旧的文件
            fileStats.sort((a, b) => a.mtime - b.mtime);
            
            let deletedSize = 0;
            let deletedCount = 0;
            
            for (const file of fileStats) {
                if (currentSize - deletedSize <= MAX_STORAGE_SIZE * 0.8) break;
                
                await fs.unlink(file.path);
                deletedSize += file.size;
                deletedCount++;
                console.log(`删除旧文件: ${file.name}`);
            }
            
            console.log(`清理了 ${deletedCount} 个文件，释放了 ${(deletedSize / 1024 / 1024).toFixed(2)} MB 空间`);
        } catch (error) {
            console.error('清理文件失败:', error);
        }
    }
}

// 配置文件上传
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, FILES_DIR);
    },
    filename: function (req, file, cb) {
        // 处理中文文件名编码问题
        const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(originalname);
        const basename = path.basename(originalname, ext);
        cb(null, `${basename}-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: MAX_FILE_SIZE
    },
    fileFilter: function (req, file, cb) {
        // 修复中文文件名编码
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        
        // 允许所有文件类型，但排除一些危险的扩展名
        const dangerousExts = ['.c0215om'];
        const ext = path.extname(file.originalname).toLowerCase();
        
        if (dangerousExts.includes(ext)) {
            return cb(new Error('不允许上传可执行文件'));
        }
        
        cb(null, true);
    }
});

// WebSocket连接管理
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('新用户连接，当前在线用户数:', clients.size);
    
    ws.on('close', () => {
        clients.delete(ws);
        console.log('用户断开连接，当前在线用户数:', clients.size);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket错误:', error);
        clients.delete(ws);
    })
});

// 广播消息给所有客户端
function broadcast(message) {
    const messageString = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageString);
        }
    });
}

// API路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 获取消息历史
app.get('/api/messages', async (req, res) => {
    try {
        const messages = await readMessages();
        res.json(messages);
    } catch (error) {
        console.error('获取消息失败:', error);
        res.status(500).json({ error: '获取消息失败' });
    }
});

// 发送消息
app.post('/api/messages', async (req, res) => {
    try {
        const { type, username, content, timestamp } = req.body;
        
        if (!username || !content) {
            return res.status(400).json({ error: '缺少必要参数' });
        }
        
        const message = {
            type: type || 'text',
            username,
            content,
            timestamp: timestamp || Date.now()
        };
        
        const messages = await readMessages();
        messages.push(message);
        await writeMessages(messages);
        
        // 广播消息
        broadcast(message);
        
        // 清理旧消息
        await cleanupMessages();
        
        res.json({ success: true });
    } catch (error) {
        console.error('发送消息失败:', error);
        res.status(500).json({ error: '发送消息失败' });
    }
});

// 文件上传
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '没有上传文件' });
        }
        
        const { username } = req.body;
        if (!username) {
            return res.status(400).json({ error: '缺少用户名' });
        }
        
        // 确保文件名正确编码
        const originalname = req.file.originalname;
        
        const message = {
            type: 'file',
            username,
            filename: originalname,
            savedFilename: req.file.filename,
            filesize: req.file.size,
            timestamp: Date.now()
        };
        
        const messages = await readMessages();
        messages.push(message);
        await writeMessages(messages);
        
        // 广播文件消息
        broadcast(message);
        
        // 清理旧消息和文件
        await cleanupMessages();
        await cleanupFiles();
        
        res.json({ 
            success: true, 
            filename: originalname,
            size: req.file.size 
        });
    } catch (error) {
        console.error('文件上传失败:', error);
        res.status(500).json({ error: '文件上传失败: ' + error.message });
    }
});

// 文件下载
app.get('/files/:filename(*)', async (req, res) => {
    try {
        // 获取文件名并解码
        let filename = req.params.filename;
        
        // 处理URL编码
        try {
            filename = decodeURIComponent(filename);
        } catch (e) {
            console.log('URL解码失败，使用原始文件名');
        }
        
        console.log('请求下载文件:', filename);
        
        // 从消息中查找文件记录
        const messages = await readMessages();
        const fileMessage = messages.find(msg => 
            msg.type === 'file' && msg.filename === filename
        );
        
        if (!fileMessage) {
            console.log('未找到文件记录');
            return res.status(404).json({ error: '文件不存在' });
        }
        
        const filePath = path.join(FILES_DIR, fileMessage.savedFilename);
        
        // 检查物理文件是否存在
        if (!fsSync.existsSync(filePath)) {
            console.log('物理文件不存在:', filePath);
            return res.status(404).json({ error: '文件不存在' });
        }
        
        // 设置响应头
        res.setHeader('Content-Disposition', 
            `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        // 发送文件
        res.sendFile(path.resolve(filePath));
        
    } catch (error) {
        console.error('文件下载失败:', error);
        res.status(500).json({ error: '文件下载失败' });
    }
});

// 错误处理中间件
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: '文件太大，最大允许150MB' });
        }
    }
    
    console.error('服务器错误:', error);
    res.status(500).json({ error: '服务器内部错误' });
});

// 定期清理任务
setInterval(async () => {
    await cleanupMessages();
    await cleanupFiles();
}, 5 * 60 * 1000); // 每5分钟清理一次

// 启动服务器
ensureDirectories().then(() => {
    server.listen(PORT, () => {
        console.log(`聊天应用已启动在端口 ${PORT}`);
        console.log(`访问 http://localhost:${PORT}`);
    });
}).catch(error => {
    console.error('启动失败:', error);
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n正在关闭服务器...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});