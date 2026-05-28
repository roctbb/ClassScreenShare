'use strict';

const ejs = require('ejs');
const path = require('path');
const config = require('../config');

const VIEWS_DIR = path.join(__dirname, '..', 'views');
const LAYOUT_PATH = path.join(VIEWS_DIR, 'layouts', 'main.ejs');

/**
 * Express-middleware: добавляет res.renderPage(view, data),
 * который рендерит view внутри основного layout.
 */
function attachRenderer(app) {
    app.use((req, res, next) => {
        res.renderPage = async (view, data = {}) => {
            try {
                const fullView = path.join(VIEWS_DIR, `${view}.ejs`);
                // res.locals (csrfToken, user, ...) делаем доступными во view.
                const ctx = { ...res.locals, assetVersion: config.assetVersion, ...data };
                const body = await ejs.renderFile(fullView, ctx, { async: false });
                const html = await ejs.renderFile(
                    LAYOUT_PATH,
                    {
                        title: ctx.title || 'ClassScreenShare',
                        user: ctx.user || res.locals.user || null,
                        hideNav: Boolean(ctx.hideNav),
                        assetVersion: config.assetVersion,
                        scripts: ctx.scripts || '',
                        headExtra: ctx.headExtra || '',
                        body,
                    },
                    { async: false }
                );
                res.type('html').send(html);
            } catch (err) {
                next(err);
            }
        };
        next();
    });
}

module.exports = { attachRenderer, VIEWS_DIR };
