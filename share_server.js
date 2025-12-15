require('dotenv').config();

const password = process.env.PASSWORD;

const express = require('express');
const http = require('http');
const {Server: Share_server} = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Share_server(server);

// Middleware для парсинга JSON
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Настройки для записи
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings');
const ENABLE_RECORDING = process.env.ENABLE_RECORDING === 'true' || true;

// Настройки качества и частоты для клиентов
const CAPTURE_INTERVAL = parseInt(process.env.CAPTURE_INTERVAL) || 5000; // миллисекунды
const IMAGE_QUALITY = parseFloat(process.env.IMAGE_QUALITY) || 0.8; // 0.0 - 1.0
const IMAGE_WIDTH = parseInt(process.env.IMAGE_WIDTH) || 1080; // пиксели
const INACTIVITY_TIMEOUT = parseInt(process.env.INACTIVITY_TIMEOUT) || 15000; // миллисекунды

// Создаем директорию для записей, если её нет
if (ENABLE_RECORDING && !fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Используем EJS как шаблонизатор
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Хранилище экранов
let screens = {};

// Хранилище для текущей сессии записи
let currentSessionId = null;

// Функция для создания новой сессии записи
function createRecordingSession() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    currentSessionId = `session_${timestamp}`;
    const sessionDir = path.join(RECORDINGS_DIR, currentSessionId);

    if (ENABLE_RECORDING && !fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
        console.log(`Создана новая сессия записи: ${currentSessionId}`);
    }

    return currentSessionId;
}

// Функция для сохранения скриншота
function saveScreenshot(studentId, studentName, imageData) {
    if (!ENABLE_RECORDING || !currentSessionId) return;

    try {
        // Очищаем имя от небезопасных символов
        const safeName = studentName.replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '_');
        const studentDir = path.join(RECORDINGS_DIR, currentSessionId, `${safeName}_${studentId.slice(-6)}`);

        // Создаем директорию для студента, если её нет
        if (!fs.existsSync(studentDir)) {
            fs.mkdirSync(studentDir, { recursive: true });
        }

        // Удаляем префикс data:image/webp;base64,
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        // Сохраняем с временной меткой
        const timestamp = Date.now();
        const filename = `screenshot_${timestamp}.webp`;
        const filepath = path.join(studentDir, filename);

        fs.writeFileSync(filepath, buffer);
    } catch (err) {
        console.error('Ошибка сохранения скриншота:', err);
    }
}

// Отдаем статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// Главная страница для учеников
app.get('/', (req, res) => {
    res.render('index', {
        captureInterval: CAPTURE_INTERVAL,
        imageQuality: IMAGE_QUALITY,
        imageWidth: IMAGE_WIDTH
    });
});

// Страница преподавателя
app.get('/screens', (req, res) => {
    // Простая проверка пароля
    if (password === req.query.password) {
        res.render('screens', {screens});
    } else {
        res.status(403).send('Доступ запрещен!');
    }
});

// Страница управления записями
app.get('/manage', (req, res) => {
    if (password !== req.query.password) {
        return res.status(403).send('Доступ запрещен!');
    }

    try {
        const sessions = [];

        if (fs.existsSync(RECORDINGS_DIR)) {
            const sessionDirs = fs.readdirSync(RECORDINGS_DIR)
                .filter(name => {
                    const fullPath = path.join(RECORDINGS_DIR, name);
                    return fs.statSync(fullPath).isDirectory();
                })
                .sort()
                .reverse();

            sessionDirs.forEach(sessionName => {
                const sessionPath = path.join(RECORDINGS_DIR, sessionName);
                const students = [];
                let totalScreenshots = 0;
                let totalBytes = 0;

                const studentDirs = fs.readdirSync(sessionPath)
                    .filter(name => {
                        const fullPath = path.join(sessionPath, name);
                        return fs.statSync(fullPath).isDirectory();
                    });

                studentDirs.forEach(studentFolder => {
                    const studentPath = path.join(sessionPath, studentFolder);
                    const files = fs.readdirSync(studentPath);

                    const screenshots = files.filter(f => f.endsWith('.webp'));
                    const hasVideo = files.some(f => f.endsWith(`.${process.env.VIDEO_FORMAT || 'mp4'}`));

                    let folderSize = 0;
                    files.forEach(file => {
                        const filePath = path.join(studentPath, file);
                        folderSize += fs.statSync(filePath).size;
                    });

                    totalScreenshots += screenshots.length;
                    totalBytes += folderSize;

                    students.push({
                        name: studentFolder,
                        folder: studentFolder,
                        screenshotCount: screenshots.length,
                        hasVideo: hasVideo,
                        size: formatBytes(folderSize)
                    });
                });

                sessions.push({
                    name: sessionName,
                    students: students,
                    totalScreenshots: totalScreenshots,
                    totalSize: formatBytes(totalBytes)
                });
            });
        }

        res.render('manage', {
            sessions: sessions,
            currentSession: currentSessionId,
            recordingsDir: RECORDINGS_DIR,
            settings: {
                CAPTURE_INTERVAL: CAPTURE_INTERVAL,
                IMAGE_QUALITY: IMAGE_QUALITY,
                IMAGE_WIDTH: IMAGE_WIDTH,
                INACTIVITY_TIMEOUT: INACTIVITY_TIMEOUT,
                VIDEO_FPS: process.env.VIDEO_FPS || 2,
                VIDEO_FORMAT: process.env.VIDEO_FORMAT || 'mp4'
            }
        });
    } catch (err) {
        console.error('Ошибка при чтении записей:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// API для конвертации в видео
app.post('/api/convert', (req, res) => {
    const { session, student } = req.body;
    const studentPath = path.join(RECORDINGS_DIR, session, student);

    if (!fs.existsSync(studentPath)) {
        return res.json({ success: false, error: 'Директория не найдена' });
    }

    convertToVideo(studentPath, (error) => {
        if (error) {
            res.json({ success: false, error: error });
        } else {
            res.json({ success: true });
        }
    });
});

// API для конвертации всей сессии
app.post('/api/convert-session', (req, res) => {
    const { session } = req.body;
    const sessionPath = path.join(RECORDINGS_DIR, session);

    if (!fs.existsSync(sessionPath)) {
        return res.json({ success: false, error: 'Сессия не найдена' });
    }

    const studentDirs = fs.readdirSync(sessionPath)
        .filter(name => {
            const fullPath = path.join(sessionPath, name);
            return fs.statSync(fullPath).isDirectory();
        });

    let completed = 0;
    let hasError = false;

    studentDirs.forEach((studentFolder, index) => {
        const studentPath = path.join(sessionPath, studentFolder);

        setTimeout(() => {
            convertToVideo(studentPath, (error) => {
                completed++;
                if (error) hasError = true;

                if (completed === studentDirs.length) {
                    res.json({
                        success: !hasError,
                        count: completed,
                        error: hasError ? 'Некоторые записи не удалось конвертировать' : null
                    });
                }
            });
        }, index * 1000); // Задержка между конвертациями
    });

    if (studentDirs.length === 0) {
        res.json({ success: false, error: 'Нет записей для конвертации' });
    }
});

// API для удаления студента
app.post('/api/delete', (req, res) => {
    const { session, student } = req.body;
    const studentPath = path.join(RECORDINGS_DIR, session, student);

    try {
        if (fs.existsSync(studentPath)) {
            fs.rmSync(studentPath, { recursive: true, force: true });
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'Директория не найдена' });
        }
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// API для удаления сессии
app.post('/api/delete-session', (req, res) => {
    const { session } = req.body;
    const sessionPath = path.join(RECORDINGS_DIR, session);

    try {
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'Сессия не найдена' });
        }
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// API для скачивания видео
app.get('/api/download/:session/:student/:file', (req, res) => {
    const filePath = path.join(RECORDINGS_DIR, req.params.session, req.params.student, req.params.file);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Файл не найден');
    }

    res.download(filePath);
});

// Функция для форматирования размера файлов
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Функция для конвертации в видео
function convertToVideo(studentDir, callback) {
    const screenshots = fs.readdirSync(studentDir)
        .filter(file => file.endsWith('.webp'))
        .sort((a, b) => {
            const timeA = parseInt(a.match(/screenshot_(\d+)\.webp/)?.[1] || 0);
            const timeB = parseInt(b.match(/screenshot_(\d+)\.webp/)?.[1] || 0);
            return timeA - timeB;
        });

    if (screenshots.length === 0) {
        return callback('Нет скриншотов для конвертации');
    }

    const FPS = parseFloat(process.env.VIDEO_FPS) || 2;
    const FORMAT = process.env.VIDEO_FORMAT || 'mp4';
    const listFile = path.join(studentDir, 'filelist.txt');
    const fileList = screenshots.map(file => `file '${file}'\nduration ${1/FPS}`).join('\n');
    const lastScreenshot = screenshots[screenshots.length - 1];

    fs.writeFileSync(listFile, fileList + `\nfile '${lastScreenshot}'`);

    const outputFile = path.join(studentDir, `recording.${FORMAT}`);

    const ffmpeg = spawn('ffmpeg', [
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-vsync', 'vfr',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264',
        '-crf', '23',
        '-y',
        outputFile
    ], { cwd: studentDir });

    ffmpeg.on('close', (code) => {
        fs.unlinkSync(listFile);
        if (code === 0) {
            callback(null);
        } else {
            callback(`Ошибка конвертации (код ${code})`);
        }
    });
}

// WebSocket для взаимодействия
io.on("connection", (socket) => {
    console.log("Участник подключился:", socket.id);

    // Получение имени участника
    socket.on("join", (data) => {
        const { name } = data;

        // Сохраняем участника
        screens[socket.id] = {
            name: name || "Неизвестный участник",
            data: null, // Еще нет данных экрана
            lastUpdate: Date.now(),
        };

        console.log(`${socket.id}: ${name} подключился.`);

        // Отправка обновленного списка экранов всем
        io.emit("update_screens", screens);
    });

    // Получение данных экрана ученика
    socket.on("share_screen", (data) => {
        if (screens[socket.id]) {
            screens[socket.id].data = data; // Здесь данные экрана (например, base64)
            screens[socket.id].lastUpdate = Date.now(); // Время последнего обновления

            // Сохраняем скриншот на диск
            saveScreenshot(socket.id, screens[socket.id].name, data);
        }

        // Рассылка обновленного экрана всем учителям
        io.emit("update_screens", screens);
    });

    // Обработка отключения ученика
    socket.on("disconnect", () => {
        console.log("Участник отключился:", socket.id);
        if (screens[socket.id]) {
            // Получаем имя отключившегося участника для лога
            const disconnectedStudent = screens[socket.id].name || "Неизвестный участник";

            // Удаляем участника из списка
            delete screens[socket.id];

            // Логируем отключение
            io.emit("remove_student", {id: socket.id, name: disconnectedStudent});

            // Отправка обновленного списка экранов
            io.emit("update_screens", screens);
        }
    });
});

// Мониторинг неактивных участников
setInterval(() => {
    const now = Date.now();
    for (const [id, screen] of Object.entries(screens)) {
        const inactiveTime = now - screen.lastUpdate;
        if (inactiveTime > INACTIVITY_TIMEOUT) {
            const minutes = Math.floor(inactiveTime / 60000);
            const seconds = Math.floor((inactiveTime % 60000) / 1000);
            console.log(`⚠️  ${screen.name} неактивен ${minutes}м ${seconds}с`);
        }
    }
}, 30000); // Проверяем каждые 30 секунд

// Создаем новую сессию при старте сервера
if (ENABLE_RECORDING) {
    createRecordingSession();
}

// Запускаем сервер
server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    if (ENABLE_RECORDING) {
        console.log(`Запись включена. Директория: ${RECORDINGS_DIR}`);
        console.log(`Текущая сессия: ${currentSessionId}`);
    }
    console.log(`Таймаут неактивности: ${INACTIVITY_TIMEOUT}мс`);
});