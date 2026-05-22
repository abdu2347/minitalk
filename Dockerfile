FROM node:20-alpine
RUN apk add --no-cache tini

WORKDIR /app

# 复制依赖文件并安装
COPY package*.json ./
RUN npm install --production

# 复制源码
COPY . .

# 确保上传目录存在
RUN mkdir -p uploads/images uploads/voice

# 运行用户
USER node

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
