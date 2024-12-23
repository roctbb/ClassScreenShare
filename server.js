require('dotenv').config();

const password = process.env.PASSWORD;

const express = require('express');
const http = require('http');
const {Server} = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
io.on('connection', (socket) => {
    console.log('Новое соединение:', socket.id);

    // Когда ученик делится экраном
    socket.on('share_screen', ({name, data}) => {
        screens[socket.id] = {name, data};
        io.emit('update_screens', screens);
    });

    // Когда соединение закрывается
    socket.on('disconnect', () => {
        delete screens[socket.id];
        io.emit('update_screens', screens);
    });
});

// Запускаем сервер
server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});