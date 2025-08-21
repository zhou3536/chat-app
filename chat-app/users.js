
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
// import bcrypt from 'bcryptjs';
// import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataFilePath = path.join(__dirname, 'users.json');
let users = [];
const SESSION_COOKIE_NAME = 'session_id';
const SESSION_DURATION_MS = 48 * 3600000;

const mailhost = process.env.MAIL_HOST;
const mailuser = process.env.MAIL_USER;
const mailpwd = process.env.MAIL_PWD;
const InvitationCode = process.env.Invitationcode;
if (!mailhost || !mailuser || !mailpwd) { console.error('请在.env文件设置邮箱信息'), process.exit(1) }

const COOKIE_SECRET = process.env.cookieSecret;
if (!COOKIE_SECRET) { console.error('请在.env文件设置cookieSecret'), process.exit(1) }

async function writeDataFile(data) {
    try {
        fs.writeFileSync(dataFilePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
        console.error('Error writing ', error);
    }
}

// 存验证码信息
const codes = {};
const lockIP = {};
const lockUser = {};

// 定时清理任务（每分钟）
setInterval(() => {
    const now = Date.now();
    for (const email in codes) {
        if (now - codes[email].createdAt > 10 * 60 * 1000) {
            delete codes[email];
        }
    }
}, 60 * 1000);

// 生成 6 位数字
function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// 发送验证码
async function sendcode(email, code) {
    try {
        // const transporter = nodemailer.createTransport({
        //     host: mailhost,
        //     port: 465,
        //     secure: true,
        //     auth: { user: mailuser, pass: mailpwd }
        // });
        // const mailOptions = {
        //     from: `"验证码" <${mailuser}>`,
        //     to: email,
        //     subject: `<${mailuser}>`,
        //     html: `<p>您的验证码是：<b>${code}</b>（10分钟内有效）</p>`
        // };
        // await transporter.sendMail(mailOptions);
        console.log(`已发送给 ${email} 的验证码: ${code}`);
        return { success: true };
    } catch (err) {
        console.error("发送邮件失败:", err);
        return { error: "邮件发送失败，请稍后再试" };
    }
};

// 公共方法：获取验证码
async function handleGetCode(email, shouldExist,) {
    const now = Date.now();
    const exists = users.some(item => item.email === email);

    if (shouldExist && !exists) {
        return { error: '该邮箱不存在' };
    }
    if (!shouldExist && exists) {
        return { error: '该邮箱已经注册过了' };
    }

    // 限流
    if (codes[email] && (now - codes[email].createdAt) < 60 * 1000) {
        return { error: '请求过于频繁，请稍后再试' };
    }

    // 生成验证码
    codes[email] = {
        code: generateCode(),
        createdAt: now,
        attempts: 0
    };

    const result = await sendcode(email, codes[email].code);
    if (result.error) return { error: '系统发送失败，请联系管理员' };
    return { success: true };
}

// 公共方法：验证验证码
function handlePostCode(email, code, onSuccess) {
    const record = codes[email];
    if (!record) {
        return { error: '验证码不存在，请重新获取' };
    }

    // 验证码过期
    if (Date.now() - record.createdAt > 10 * 60 * 1000) {
        delete codes[email];
        return { error: '验证码已过期' };
    }

    // 验证码错误
    if (record.code !== code) {
        record.attempts++;
        if (record.attempts >= 5) {
            delete codes[email];
            return { error: '验证码错误次数过多，请重新获取' };
        }
        return { error: '验证码错误' };
    }

    // 验证成功
    delete codes[email];
    return { success: true };
}
//验证邀请码
function handleInvitationcode(Invitationcode, IP) {
    const now = Date.now();
    let record = lockIP[IP];
    // 如果有记录且时间已过期，则重置
    if (!record || now - record.firstTime > 3600 * 1000) {
        record = { count: 0, firstTime: now };
        lockIP[IP] = record;
    }
    // 如果错误次数已达上限
    if (record.count >= 10) {
        return { error: `请求过于频繁，你的IP:${IP}已被限制操作` };
    }
    // 检查邀请码
    if (Invitationcode !== InvitationCode) {
        record.count++;
        if (record.count === 5) console.log('IP:', IP, '已锁定，没有邀请码频繁请求');
        return { error: '邀请码错误' };
    }
    // 验证成功，重置记录
    delete lockIP[IP];
    return { success: true };
}

// ===== 注册账号 =====
const getcode = async (req, res) => {
    const email = req.body.email.toLowerCase();
    if (!email) return;
    const userIP = getClientIp(req);
    const Invitationcode = req.body.Invitationcode;
    const result1 = handleInvitationcode(Invitationcode, userIP);
    if (result1.error) return res.status(400).json({ message: result1.error });

    const result = await handleGetCode(email, false);
    if (result.error) return res.status(400).json({ message: result.error });
    res.json({ message: '发送成功，请查看邮箱' });
};

const postcode = async (req, res) => {
    const { username, email, pwd, code } = req.body;
    if (!username || !email || !pwd || !code) return;
    if (getStringWidth(username) > 12) return res.status(400).json({ message: '昵称过长' });
    try {
        // const hash = await bcrypt.hash(pwd, 10);
        const result = handlePostCode(email, code);
        if (result.error) return res.status(400).json({ message: result.error });
        users.push({ username: username, email: email, password: pwd, userId: crypto.randomUUID(), sessionToken: crypto.randomUUID() });
        await writeDataFile(users);
        res.json({ message: '创建账号成功' });
        console.log('创建账号', email)
    } catch (error) {
        console.error('注册过程中发生错误:', error);
        res.status(500).json({ message: '服务器错误，请稍后再试' });
    }
};
function getStringWidth(str) {
    let width = 0;
    for (let i = 0; i < str.length; i++) {
        const charCode = str.charCodeAt(i);
        if (charCode >= 0 && charCode <= 127) {
            width += 1;
        } else {
            width += 2;
        }
    }
    return width;
}
// ===== 修改密码 =====
const getcode2 = async (req, res) => {
    const email = req.body.email.toLowerCase();
    if (!email) return;
    const result = await handleGetCode(email, true);
    if (result.error) return res.status(400).json({ message: result.error });
    res.json({ message: '发送成功，请查看邮箱' });
};

const postcode2 = async (req, res) => {
    const { email, pwd, code } = req.body;
    const userIP = getClientIp(req);
    if (!email || !pwd || !code) return;
    const user = users.find(user => user.email === email);
    if (!user) return res.status(401).json({ message: '输入的用户名不存在' });

    try {
        // const hash = await bcrypt.hash(pwd, 10);
        const result = handlePostCode(email, code);
        if (result.error) return res.status(400).json({ message: result.error });
        user.password = pwd;
        user.sessionToken = crypto.randomUUID();
        await writeDataFile(users);
        res.json({ message: '密码修改成功' });
        console.log('修改密码', email)
        // disconnectChat(user.userId);
        delete lockUser[user.email];
    } catch (error) {
        console.error(email, '修改密码发生错误:', error);
        res.status(500).json({ message: '服务器错误，请稍后再试' });
    }
};
// 获取客户端IP地址，考虑代理
const getClientIp = (req) => {
    // 检查 X-Forwarded-For
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
        return forwardedFor.split(',')[0].trim();
    }
    // 检查 X-Real-IP
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
        return realIp.trim();
    }
    return req.ip;
};


// --- 认证中间件和路由处理函数 ---
const authenticateMiddleware = (req, res, next) => {
    // 白名单
    const publicPaths = [
        '/login.html',
        '/signup.html',
        '/theme.js',
        '/color.css',
        '/favicon.ico'
    ];

    // 如果请求路径在白名单中，直接放行
    if (publicPaths.includes(req.path)) {
        return next();
    };
    if (req.path.startsWith('/user')) {
        return next();
    };
    // 检查是否存在用户 ID Cookie
    const sessionCookie = req.signedCookies[SESSION_COOKIE_NAME];
    if (sessionCookie && sessionCookie.userId && sessionCookie.sessionToken) {
        const { userId, sessionToken } = sessionCookie;
        const foundUser = users.find(user => user.userId === userId);
        if (foundUser && foundUser.sessionToken === sessionToken) {
            // 会话有效，刷新 Cookie 的过期时间
            res.cookie(SESSION_COOKIE_NAME, { userId: foundUser.userId, sessionToken: foundUser.sessionToken }, {
                maxAge: SESSION_DURATION_MS,
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                signed: true,
                sameSite: 'Lax'
            });
            req.user = foundUser;
            return next();
        }
    };
    if (req.path.endsWith('.html') || req.path === '/') {
        return res.status(401).sendFile(path.join(__dirname, 'public', 'signup.html'));
    };
    res.status(401).json({ message: '请登录后重试' });
};

// 登录路由处理函数
const postlogin = async (req, res) => {
    const { email, password } = req.body;
    const IP = getClientIp(req);
    const foundUser = users.find(user => user.email === email);
    if (!foundUser) return res.status(401).json({ message: '输入的用户名不存在' });
    const now = Date.now();
    let userRecord = lockUser[foundUser.email];
    if (!userRecord || now - userRecord.firstTime > 3600 * 1000) {
        userRecord = { count: 0, firstTime: now };
        lockUser[foundUser.email] = userRecord;
    }
    if (userRecord.count >= 10) {
        return res.status(503).json({ message: '密码错误过多，请重置密码，或稍后重试' });
    }
    if (foundUser && password === foundUser.password) {
        res.cookie(SESSION_COOKIE_NAME, { userId: foundUser.userId, sessionToken: foundUser.sessionToken }, {
            maxAge: SESSION_DURATION_MS,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            signed: true,
            sameSite: 'Lax'
        });
        delete lockUser[foundUser.email];
        console.log('用户登录', email, 'IP:', IP);
        return res.status(200).json({ message: '登录成功' });
    } else {
        userRecord.count++;
        if (userRecord.count >= 10) console.log('用户:', foundUser.email, '已锁定，登录失败频繁请求');
        return res.status(401).json({ message: '用户名或密码不正确' });
    }
};

// 登出路由处理函数
const postlogout = (req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, {
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax'
    });
    return res.status(200).json({ message: '退出成功' });
};
// 登录状态
const getUserStatus = (req, res) => {
    const sessionCookie = req.signedCookies[SESSION_COOKIE_NAME];
    if (sessionCookie && sessionCookie.userId && sessionCookie.sessionToken) {
        const foundUser = users.find(user => user.userId === sessionCookie.userId);
        if (foundUser && foundUser.sessionToken === sessionCookie.sessionToken) {
            return res.json({ loggedIn: true, username: foundUser.username });
        }
    }
    // 无效会话或未登录
    res.json({ loggedIn: false });
};
//初始化
const initializeUsers = (app, initialUsers) => {
    users = initialUsers;
    if (!initialUsers) { console.error('ERROR: Not Users'); process.exit(1); }

    app.use(cookieParser(COOKIE_SECRET));
    app.use(authenticateMiddleware);
    app.post('/user/getcode', getcode);
    app.post('/user/postcode', postcode);
    app.post('/user/getcode2', getcode2);
    app.post('/user/postcode2', postcode2);
    app.post('/user/postlogin', postlogin);
    app.post('/user/postlogout', postlogout);
    app.get('/user/status', getUserStatus);
    // 启动定期清理任务
    console.log('用户模块已初始化...');
};

export { initializeUsers };