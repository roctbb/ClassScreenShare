#!/usr/bin/env node

/**
 * Скрипт для конвертации скриншотов в видео
 * Использование: node convert_to_video.js <путь_к_папке_студента>
 * Пример: node convert_to_video.js recordings/session_2025-01-15T12-30-00/Иванов_abc123
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Настройки по умолчанию
const FPS = process.env.VIDEO_FPS || 2; // Кадров в секунду (для 5 сек интервала = 0.2 fps)
const OUTPUT_FORMAT = process.env.VIDEO_FORMAT || 'mp4';

function convertToVideo(studentDir) {
    if (!fs.existsSync(studentDir)) {
        console.error(`Ошибка: Директория ${studentDir} не существует`);
        process.exit(1);
    }

    // Получаем список всех скриншотов
    const screenshots = fs.readdirSync(studentDir)
        .filter(file => file.endsWith('.webp'))
        .sort((a, b) => {
            const timeA = parseInt(a.match(/screenshot_(\d+)\.webp/)?.[1] || 0);
            const timeB = parseInt(b.match(/screenshot_(\d+)\.webp/)?.[1] || 0);
            return timeA - timeB;
        });

    if (screenshots.length === 0) {
        console.error(`Ошибка: В директории ${studentDir} нет скриншотов`);
        process.exit(1);
    }

    console.log(`Найдено ${screenshots.length} скриншотов`);

    // Создаем текстовый файл со списком изображений для ffmpeg
    const listFile = path.join(studentDir, 'filelist.txt');
    const fileList = screenshots.map(file =>
        `file '${file}'\nduration ${1/FPS}`
    ).join('\n');

    // Добавляем последний кадр без duration
    const lastScreenshot = screenshots[screenshots.length - 1];
    fs.writeFileSync(listFile, fileList + `\nfile '${lastScreenshot}'`);

    // Имя выходного файла
    const outputFile = path.join(studentDir, `recording.${OUTPUT_FORMAT}`);

    console.log(`Создание видео: ${outputFile}`);
    console.log(`FPS: ${FPS}`);

    // Запускаем ffmpeg
    const ffmpeg = spawn('ffmpeg', [
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-vsync', 'vfr',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264',
        '-crf', '23',
        '-y', // Перезаписываем существующий файл
        outputFile
    ], {
        cwd: studentDir
    });

    ffmpeg.stdout.on('data', (data) => {
        console.log(`ffmpeg: ${data}`);
    });

    ffmpeg.stderr.on('data', (data) => {
        // ffmpeg выводит прогресс в stderr
        process.stderr.write(data);
    });

    ffmpeg.on('close', (code) => {
        // Удаляем временный файл
        fs.unlinkSync(listFile);

        if (code === 0) {
            console.log(`\n✅ Видео успешно создано: ${outputFile}`);

            // Показываем размер файла
            const stats = fs.statSync(outputFile);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            console.log(`Размер: ${sizeMB} MB`);
        } else {
            console.error(`\n❌ Ошибка конвертации. Код выхода: ${code}`);
            process.exit(code);
        }
    });
}

// Функция для конвертации всей сессии
function convertSession(sessionDir) {
    if (!fs.existsSync(sessionDir)) {
        console.error(`Ошибка: Директория сессии ${sessionDir} не существует`);
        process.exit(1);
    }

    const students = fs.readdirSync(sessionDir)
        .filter(name => {
            const fullPath = path.join(sessionDir, name);
            return fs.statSync(fullPath).isDirectory();
        });

    console.log(`Найдено студентов: ${students.length}`);

    // Конвертируем по одному
    let index = 0;

    function convertNext() {
        if (index >= students.length) {
            console.log('\n✅ Все видео созданы!');
            return;
        }

        const studentDir = path.join(sessionDir, students[index]);
        console.log(`\n[${index + 1}/${students.length}] Обработка: ${students[index]}`);

        const screenshots = fs.readdirSync(studentDir)
            .filter(file => file.endsWith('.webp'));

        if (screenshots.length === 0) {
            console.log(`Пропуск (нет скриншотов)`);
            index++;
            convertNext();
            return;
        }

        convertToVideoAsync(studentDir, () => {
            index++;
            convertNext();
        });
    }

    convertNext();
}

// Асинхронная версия для последовательной обработки
function convertToVideoAsync(studentDir, callback) {
    const screenshots = fs.readdirSync(studentDir)
        .filter(file => file.endsWith('.webp'))
        .sort((a, b) => {
            const timeA = parseInt(a.match(/screenshot_(\d+)\.webp/)?.[1] || 0);
            const timeB = parseInt(b.match(/screenshot_(\d+)\.webp/)?.[1] || 0);
            return timeA - timeB;
        });

    const listFile = path.join(studentDir, 'filelist.txt');
    const fileList = screenshots.map(file =>
        `file '${file}'\nduration ${1/FPS}`
    ).join('\n');

    const lastScreenshot = screenshots[screenshots.length - 1];
    fs.writeFileSync(listFile, fileList + `\nfile '${lastScreenshot}'`);

    const outputFile = path.join(studentDir, `recording.${OUTPUT_FORMAT}`);

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
    ], {
        cwd: studentDir
    });

    let hasError = false;

    ffmpeg.stderr.on('data', (data) => {
        // Тихий режим - не выводим прогресс
    });

    ffmpeg.on('close', (code) => {
        fs.unlinkSync(listFile);

        if (code === 0) {
            const stats = fs.statSync(outputFile);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            console.log(`✅ Создано (${sizeMB} MB)`);
        } else {
            console.error(`❌ Ошибка (код: ${code})`);
        }

        if (callback) callback();
    });
}

// Главная функция
function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Использование:');
        console.log('  node convert_to_video.js <путь_к_папке_студента>');
        console.log('  node convert_to_video.js --session <путь_к_сессии>');
        console.log('\nПримеры:');
        console.log('  node convert_to_video.js recordings/session_2025-01-15T12-30-00/Иванов_abc123');
        console.log('  node convert_to_video.js --session recordings/session_2025-01-15T12-30-00');
        console.log('\nПеременные окружения:');
        console.log('  VIDEO_FPS - кадров в секунду (по умолчанию: 2)');
        console.log('  VIDEO_FORMAT - формат видео (по умолчанию: mp4)');
        process.exit(1);
    }

    if (args[0] === '--session') {
        if (args.length < 2) {
            console.error('Ошибка: Укажите путь к сессии');
            process.exit(1);
        }
        convertSession(args[1]);
    } else {
        convertToVideo(args[0]);
    }
}

main();
