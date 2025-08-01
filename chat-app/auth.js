// auth.js
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

// __dirname 在 ES Module 中不可用，需要手动创建
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 从环境变量获取配置
let users = [];
let COOKIE_SECRET;
const AUTH_COOKIE_NAME = 'access_granted';
const SESSION_DURATION_MS = 240 * 60 * 60 * 1000;
const USER_ID_COOKIE_NAME = 'user_id';

// --- 速率限制相关配置和存储 ---
const loginAttemptTimestamps = new Map();
const LOGIN_RATE_LIMIT_WINDOW_MS = 180 * 1000;
const LOGIN_RATE_LIMIT_COUNT = 5;

// 清理旧记录的周期和过期时间
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
// 保留比窗口稍长的记录，以确保在窗口边缘的请求也能被正确计算
const MAX_AGE_FOR_ATTEMPTS_MS = LOGIN_RATE_LIMIT_WINDOW_MS * 1.5;

// 辅助函数：获取客户端IP地址，考虑代理
const getClientIp = (req) => {
    // 优先检查 X-Forwarded-For
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
        return forwardedFor.split(',')[0].trim();
    }
    // 检查 X-Real-IP
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
        return realIp.trim();
    }
    // Fallback to req.ip (Express's default, might be proxy IP without trust proxy)
    return req.ip;
};

// 速率限制中间件，专门用于登录路由
const loginRateLimitMiddleware = (req, res, next) => {
    const clientIp = getClientIp(req);
    let attempts = loginAttemptTimestamps.get(clientIp) || [];
    const currentTime = Date.now();

    // 1. 过滤掉时间窗口（180秒）之外的旧尝试记录
    attempts = attempts.filter(timestamp => (currentTime - timestamp) < LOGIN_RATE_LIMIT_WINDOW_MS);

    // 2. 检查当前尝试是否会超出限制
    if (attempts.length >= LOGIN_RATE_LIMIT_COUNT) {
        // 如果已经达到或超过限制，计算还需要等待的时间
        const oldestAttemptTime = attempts[0];
        const timeToWaitMs = LOGIN_RATE_LIMIT_WINDOW_MS - (currentTime - oldestAttemptTime);
        const remainingTimeSeconds = Math.ceil(timeToWaitMs / 1000);

        console.warn(`[RATE LIMIT] IP: ${clientIp} - 登录尝试过于频繁。剩余等待时间: ${remainingTimeSeconds}s`);
        return res.status(429).json({
            message: `请${remainingTimeSeconds}秒后重试`,
            retryAfter: remainingTimeSeconds
        });
    }

    // 3. 如果未超出限制，记录本次尝试的时间
    attempts.push(currentTime);
    loginAttemptTimestamps.set(clientIp, attempts); // 更新Map中的记录

    next();
};

// 定期清理 loginAttemptTimestamps Map 中的旧条目
const cleanupLoginAttempts = () => {
    const currentTime = Date.now();
    let cleanedIpCount = 0;
    for (const [ip, timestamps] of loginAttemptTimestamps.entries()) {
        // 过滤掉超出 MAX_AGE_FOR_ATTEMPTS_MS 的记录
        const filteredTimestamps = timestamps.filter(t => (currentTime - t) < MAX_AGE_FOR_ATTEMPTS_MS);

        if (filteredTimestamps.length === 0) {
            // 如果该IP的所有尝试记录都已过期，则从Map中完全移除
            loginAttemptTimestamps.delete(ip);
            cleanedIpCount++;
        } else if (filteredTimestamps.length < timestamps.length) {
            // 如果有部分记录被清理，更新Map
            loginAttemptTimestamps.set(ip, filteredTimestamps);
            // 这里不增加 cleanedIpCount，因为IP条目本身还在，只是其数组变小了
        }
    }
    if (cleanedIpCount > 0) {
        console.log(`[CLEANUP] 清理了 ${cleanedIpCount} 个已过期的登录尝试IP条目。当前Map大小: ${loginAttemptTimestamps.size}`);
    }
};

// --- 认证中间件和路由处理函数 ---
const authenticateMiddleware = (req, res, next) => {
    // 白名单路径，不需要认证
    const publicPaths = [
        '/login.html',
        '/api/login',
        '/api/logout',
        '/theme.js',
        '/color.css',
        '/favicon.ico'
    ];

    // 如果请求路径在白名单中，直接放行
    if (publicPaths.includes(req.path)) {
        return next();
    }

    // 检查是否存在认证 Cookie 和用户 ID Cookie
    if (req.signedCookies[AUTH_COOKIE_NAME] === 'true' && req.signedCookies[USER_ID_COOKIE_NAME]) {
        // 如果认证 Cookie 和用户 ID Cookie 都存在且有效，检查是否需要续期
        res.cookie(AUTH_COOKIE_NAME, 'true', {
            maxAge: SESSION_DURATION_MS,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            signed: true,
            sameSite: 'Lax'
        });
        res.cookie(USER_ID_COOKIE_NAME, req.signedCookies[USER_ID_COOKIE_NAME], { // 续期用户ID Cookie
            maxAge: SESSION_DURATION_MS,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            signed: true,
            sameSite: 'Lax'
        });
        return next();
    }

    if (req.path.startsWith('/api')) {
        return res.status(401).json({ message: 'Unauthorized. Please log in to access this resource.' });
    }

    res.status(401).sendFile(path.join(__dirname, 'public', 'login.html'));
};

// 登录路由处理函数
const loginRoute = (req, res) => {
    const { username, password } = req.body;
    const clientIp = getClientIp(req);

    if (!COOKIE_SECRET) {
        console.error('Authentication configuration missing: COOKIE_SECRET not set.');
        console.error(`[LOGIN ERROR] IP: ${clientIp} - Server authentication not configured.`);
        return res.status(500).json({ message: 'Server authentication not configured.' });
    }

    const foundUser = users.find(user => user.username === username);

    // 比较密码
    if (foundUser && foundUser.password === password) {
        res.cookie(AUTH_COOKIE_NAME, 'true', {
            maxAge: SESSION_DURATION_MS,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            signed: true,
            sameSite: 'Lax'
        });
        // 设置用户 ID Cookie
        res.cookie(USER_ID_COOKIE_NAME, foundUser.userId, {
            maxAge: SESSION_DURATION_MS,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            signed: true,
            sameSite: 'Lax'
        });

        console.log(`IP: ${clientIp} - User ${username} login successful. UserID: ${foundUser.userId}`);
        return res.status(200).json({ message: '登录成功' });
    } else {
        console.warn(`IP: ${clientIp} - Login failed for username: ${username}`);
        return res.status(401).json({ message: '登录失败' });
    }
};

// 登出路由处理函数
const logoutRoute = (req, res) => {
    res.clearCookie(AUTH_COOKIE_NAME, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        signed: true,
        sameSite: 'Lax'
    });
    res.clearCookie(USER_ID_COOKIE_NAME, { // 清除用户 ID Cookie
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        signed: true,
        sameSite: 'Lax'
    });

    const clientIp = getClientIp(req);
    // 获取当前请求中的用户 ID，用于日志记录
    const loggedOutUserId = req.signedCookies[USER_ID_COOKIE_NAME] || 'unknown';
    const foundUser = users.find(user => user.userId === loggedOutUserId);
    const username = foundUser ? foundUser.username : null;
    console.log(`IP: ${clientIp} - User ${username} logout successfully. UserID: ${loggedOutUserId}`);
    return res.status(200).json({ message: '退出成功' });
};


//初始化认证模块并将其应用于Express应用。
const initializeAuth = (app, initialUsers, initialCookieSecret) => {
    COOKIE_SECRET = initialCookieSecret;
    users = initialUsers;
    if (!COOKIE_SECRET) {
        console.error('ERROR: COOKIE_SECRET environment variable is not set!');
        console.error('Please set it in your .env file.');
        process.exit(1);
    }
    app.use(cookieParser(COOKIE_SECRET));
    app.use(authenticateMiddleware);
    // 对 /api/login 路由应用新的速率限制中间件
    app.post('/api/login', loginRateLimitMiddleware, loginRoute);
    app.post('/api/logout', logoutRoute);

    // 启动定期清理任务
    setInterval(cleanupLoginAttempts, CLEANUP_INTERVAL_MS);
    console.log('Authentication module initialized.');
};

export { initializeAuth };
