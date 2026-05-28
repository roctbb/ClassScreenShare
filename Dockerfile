FROM node:20-alpine

# ffmpeg для конвертации, tini для корректного PID 1 и graceful shutdown,
# python3+make+g++ нужны на момент сборки native-зависимостей (bcrypt).
RUN apk add --no-cache ffmpeg tini \
 && apk add --no-cache --virtual .build-deps python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev \
 && apk del .build-deps

COPY . .

RUN mkdir -p /app/recordings

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
