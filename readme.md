# chat-app
## 致谢<https://claude.ai/>的代码
## 一个非常简单的临时聊天传文件的网页，无需安装客户端，有浏览器就行
## 可以部署在局域网或远程服务器
### 本人测试环境 Ubuntu 22
### 同理其他系统也可以，只需要懂node.js
### ！！！需要懂一点点命令行就行
#### ！！！纪录存在运行内存的，重启会清空，也可手动在网页端清空，文件限制在100mb，可以在js代码里修改

### 1. 安装Node.js和npm
win的电脑也可以安装，命令不一样
```
sudo apt update  
sudo apt install nodejs npm
```

### 2. 创建项目目录
#### 这一步可以不用执行命令，把chat-app文件夹包括里面的文件下载好，拖到你系统的根目录下就行了，作用和下面命令一样
```
mkdir chat-app  
cd chat-app
```

#### 创建public目录
```
mkdir public
```

####  创建package.json
```
nano package.json
```

####  创建服务器文件
```
nano server.js
```

####  创建前端页面
```
nano public/index.html
```

### 3. 安装依赖
win在你的chat-app目录打开cmd
```
cd /chat-app
sudo npm install  
sudo npm install multer
```

### 4. 启动服务器
```
node server.js
```

### 5. 访问应用
```
http://你的服务器IP:3000
```
#### 到这里就可以食用了

### 6. 开机启动
创建服务文件
```
nano /etc/systemd/system/chat-app.service
```
添加以下内容：
将 WorkingDirectory=/chat-app替换为你的实际路径
```
[Unit]
Description=Simple Chat App
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/chat-app
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```
#### 启用开机启动
```
sudo systemctl enable chat-app.service
```
