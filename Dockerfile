FROM node:18-alpine

# Устанавливаем ffmpeg для конвертации видео
RUN apk add --no-cache ffmpeg

# Создаем рабочую директорию
WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm ci --only=production

# Копируем остальные файлы приложения
COPY . .

# Создаем директорию для записей
RUN mkdir -p /app/recordings

# Открываем порт
EXPOSE 3000

# Запускаем приложение
CMD ["node", "share_server.js"]
