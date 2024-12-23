require('dotenv').config();

const password = process.env.PASSWORD;

const express = require('express');
const http = require('http');
const {Server: Share_server} = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Share_server(server);

const PORT = process.env.PORT || 3000;

// Используем EJS как шаблонизатор
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Хранилище экранов
let screens = {};

// Отдаем статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// Главная страница для учеников
app.get('/', (req, res) => {
    res.render('index');
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

// Запускаем сервер
server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});