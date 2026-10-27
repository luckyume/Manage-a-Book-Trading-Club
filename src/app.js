import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import registerRoutes from './routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Session tokens live in memory; the account data lives on disk.
const sessions = new Map();

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function safeNext(target) {
  if (typeof target !== 'string') return '';
  if (!target.startsWith('/') || target.startsWith('//')) return '';
  return target;
}

export function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(here, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(here, '..', 'public')));

  // Cookies
  app.use((req, _res, next) => {
    req.cookiesParsed = parseCookies(req);
    next();
  });

  // Session → current user
  app.use((req, res, next) => {
    const token = req.cookiesParsed.session;
    if (token && sessions.has(token)) {
      req.sessionToken = token;
      req.user = store.getUser(sessions.get(token));
      if (!req.user) {
        sessions.delete(token);
        req.sessionToken = null;
      }
    }
    res.locals.currentUser = req.user || null;
    res.locals.notice = typeof req.query.notice === 'string' ? req.query.notice : null;
    next();
  });

  // Small helpers shared by every route
  app.use((req, res, next) => {
    res.startSession = (userId) => {
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, userId);
      return token;
    };
    res.endSession = () => {
      if (req.sessionToken) sessions.delete(req.sessionToken);
    };
    res.requireAuth = () => {
      if (req.user) return true;
      res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return false;
    };
    res.locals.locationOf = store.locationOf;
    res.locals.statusLabel = (status) =>
      ({
        pending: 'Waiting',
        accepted: 'Accepted',
        declined: 'Declined',
        cancelled: 'Cancelled'
      })[status] || status;
    next();
  });

  registerRoutes(app);

  // 404
  app.use((req, res) => {
    res
      .status(404)
      .render('error', { title: 'Not found', message: 'There is no page at that address.' });
  });

  return app;
}

export { sessions, safeNext };
