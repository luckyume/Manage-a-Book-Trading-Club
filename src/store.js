// Tiny JSON-file backed store for the book trading club.
// No external database needed — data lives in data/db.json (path configurable
// via DATA_FILE so the test suite can run against an isolated file).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DB_FILE =
  process.env.DATA_FILE || path.join(here, '..', 'data', 'db.json');

let db = null;

export function id() {
  return crypto.randomBytes(12).toString('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  return crypto.timingSafeEqual(
    Buffer.from(hashPassword(password, salt)),
    Buffer.from(stored)
  );
}

function seed() {
  const now = Date.now();
  const mkUser = (username, fullName, city, state) => ({
    id: id(),
    username,
    password: hashPassword('password'),
    fullName,
    city,
    state,
    createdAt: now
  });

  const ada = mkUser('ada', 'Ada Lovelace', 'Portland', 'OR');
  const grace = mkUser('grace', 'Grace Hopper', 'Arlington', 'VA');
  const alan = mkUser('alan', 'Alan Turing', 'Wilmslow', 'UK');

  const mkBook = (owner, title, author, description) => ({
    id: id(),
    ownerId: owner.id,
    title,
    author,
    description,
    createdAt: now
  });

  const books = [
    mkBook(ada, 'Elements of Analytical Engines', 'L. F. Menabrea', 'Notes on Babbage’s engine, lightly read.'),
    mkBook(ada, 'The Tick-Tock of Time', 'A. A. Lovelace', 'Poetry meets programming. Dog-eared chapter 3.'),
    mkBook(grace, 'Compiler Construction', 'Grace Hopper', 'First edition. The margins are full of notes.'),
    mkBook(grace, 'Grace Hopper: Admiral of the Cyber Sea', 'K. Walsh', 'Biography, paperback, great condition.'),
    mkBook(alan, 'On Computable Numbers', 'A. M. Turing', 'The 1936 paper, bound as a booklet.'),
    mkBook(alan, 'The Enigma', 'A. Hodges', 'About the code-breaking years. Some tea stains.')
  ];

  return { users: [ada, grace, alan], books, trades: [] };
}

function persist() {
  const tmp = `${DB_FILE}.tmp`;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function load() {
  if (db) return db;
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db.users ||= [];
      db.books ||= [];
      db.trades ||= [];
      return db;
    } catch {
      // fall through to a fresh seed if the file is corrupt
    }
  }
  db = seed();
  persist();
  return db;
}

// ---- users -----------------------------------------------------------------
export function allUsers() {
  return [...load().users];
}

export function getUser(userId) {
  return load().users.find((u) => u.id === userId) || null;
}

export function getUserByUsername(username) {
  const wanted = String(username || '').toLowerCase();
  return load().users.find((u) => u.username.toLowerCase() === wanted) || null;
}

export function createUser({ username, password, fullName, city, state }) {
  const user = {
    id: id(),
    username: String(username).trim(),
    password: hashPassword(password),
    fullName: (fullName || '').trim(),
    city: (city || '').trim(),
    state: (state || '').trim(),
    createdAt: Date.now()
  };
  load().users.push(user);
  persist();
  return user;
}

export function updateUser(userId, fields) {
  const user = getUser(userId);
  if (!user) return null;
  for (const key of ['fullName', 'city', 'state']) {
    if (fields[key] !== undefined && fields[key] !== null) {
      user[key] = String(fields[key]).trim();
    }
  }
  persist();
  return user;
}

// ---- books -----------------------------------------------------------------
export function allBooks() {
  return [...load().books].sort((a, b) => b.createdAt - a.createdAt);
}

export function getBook(bookId) {
  return load().books.find((b) => b.id === bookId) || null;
}

export function booksByOwner(userId) {
  return allBooks().filter((b) => b.ownerId === userId);
}

export function createBook({ ownerId, title, author, description }) {
  const book = {
    id: id(),
    ownerId,
    title: String(title).trim(),
    author: (author || '').trim(),
    description: (description || '').trim(),
    createdAt: Date.now()
  };
  load().books.push(book);
  persist();
  return book;
}

export function setBookOwner(bookId, ownerId) {
  const book = getBook(bookId);
  if (book) {
    book.ownerId = ownerId;
    persist();
  }
  return book;
}

// ---- trades ----------------------------------------------------------------
export function allTrades() {
  return [...load().trades].sort((a, b) => b.createdAt - a.createdAt);
}

export function getTrade(tradeId) {
  return load().trades.find((t) => t.id === tradeId) || null;
}

export function createTrade({ fromUserId, toUserId, offeredBookIds, wantedBookIds }) {
  const trade = {
    id: id(),
    fromUserId,
    toUserId,
    offeredBookIds: [...offeredBookIds],
    wantedBookIds: [...wantedBookIds],
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null
  };
  load().trades.push(trade);
  persist();
  return trade;
}

export function setTradeStatus(tradeId, status) {
  const trade = getTrade(tradeId);
  if (!trade) return null;
  trade.status = status;
  trade.decidedAt = Date.now();
  persist();
  return trade;
}

export function pendingRequestsForBook(bookId) {
  return allTrades().filter(
    (t) => t.status === 'pending' && t.wantedBookIds.includes(bookId)
  );
}

// ---- locations (derived) ----------------------------------------------------
export function locationOf(user) {
  if (!user) return '';
  return [user.city, user.state].filter(Boolean).join(', ');
}
