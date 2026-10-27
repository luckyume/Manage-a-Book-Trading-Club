import express from 'express';
import * as store from './store.js';
import { safeNext } from './app.js';

const router = express.Router();

function decorate(trade) {
  return {
    ...trade,
    fromUser: store.getUser(trade.fromUserId),
    toUser: store.getUser(trade.toUserId),
    offeredBooks: trade.offeredBookIds.map(store.getBook).filter(Boolean),
    wantedBooks: trade.wantedBookIds.map(store.getBook).filter(Boolean)
  };
}

function notFound(res) {
  return res
    .status(404)
    .render('error', { title: 'Not found', message: 'That one does not exist.' });
}

function forbidden(res, message) {
  return res.status(403).render('error', { title: 'Not allowed', message });
}

router.get('/', (req, res) => res.redirect(303, '/books'));

// ---- books ------------------------------------------------------------------
router.get('/books', (req, res) => {
  const books = store.allBooks().map((book) => ({
    ...book,
    owner: store.getUser(book.ownerId),
    requestCount: store.pendingRequestsForBook(book.id).length
  }));
  res.render('books', { title: 'Books', books });
});

router.get('/books/new', (req, res) => {
  if (!res.requireAuth()) return;
  res.render('book-form', { title: 'Add a book', book: null, error: null });
});

router.post('/books', (req, res) => {
  if (!res.requireAuth()) return;
  const { title = '', author = '', description = '' } = req.body;
  if (!title.trim()) {
    return res.status(400).render('book-form', {
      title: 'Add a book',
      book: { title, author, description },
      error: 'Every book needs a title.'
    });
  }
  const book = store.createBook({ ownerId: req.user.id, title, author, description });
  res.redirect(
    303,
    `/books?notice=${encodeURIComponent(`“${book.title}” is on the shelf.`)}`
  );
});

router.get('/books/:id', (req, res) => {
  const book = store.getBook(req.params.id);
  if (!book) return notFound(res);
  res.render('book', {
    title: book.title,
    book,
    owner: store.getUser(book.ownerId),
    requests: store.pendingRequestsForBook(book.id).map(decorate)
  });
});

// ---- propose a trade --------------------------------------------------------
router.get('/books/:id/trade', (req, res) => {
  if (!res.requireAuth()) return;
  const book = store.getBook(req.params.id);
  if (!book) return notFound(res);
  if (book.ownerId === req.user.id) {
    return res.redirect(303, `/books?notice=${encodeURIComponent('That book is already yours.')}`);
  }
  res.render('propose', {
    title: 'Propose a trade',
    book,
    owner: store.getUser(book.ownerId),
    myBooks: store.booksByOwner(req.user.id),
    error: null
  });
});

router.post('/books/:id/trades', (req, res) => {
  if (!res.requireAuth()) return;
  const book = store.getBook(req.params.id);
  if (!book) return notFound(res);
  if (book.ownerId === req.user.id) {
    return res.redirect(303, `/books?notice=${encodeURIComponent('That book is already yours.')}`);
  }

  const picked = req.body.offered;
  const offeredIds = Array.isArray(picked) ? picked : picked ? [picked] : [];
  const mine = offeredIds
    .map(store.getBook)
    .filter((b) => b && b.ownerId === req.user.id);

  if (mine.length === 0) {
    return res.status(400).render('propose', {
      title: 'Propose a trade',
      book,
      owner: store.getUser(book.ownerId),
      myBooks: store.booksByOwner(req.user.id),
      error: 'Choose at least one of your books to offer.'
    });
  }

  const owner = store.getUser(book.ownerId);
  store.createTrade({
    fromUserId: req.user.id,
    toUserId: book.ownerId,
    offeredBookIds: mine.map((b) => b.id),
    wantedBookIds: [book.id]
  });
  res.redirect(
    303,
    `/trades?notice=${encodeURIComponent(`Proposed — waiting for ${owner.username} to accept.`)}`
  );
});

// ---- trades -----------------------------------------------------------------
router.get('/trades', (req, res) => {
  if (!res.requireAuth()) return;
  const all = store.allTrades();
  const mine = (t) => t.fromUserId === req.user.id || t.toUserId === req.user.id;
  res.render('trades', {
    title: 'Trades',
    incoming: all
      .filter((t) => t.status === 'pending' && t.toUserId === req.user.id)
      .map(decorate),
    outgoing: all
      .filter((t) => t.status === 'pending' && t.fromUserId === req.user.id)
      .map(decorate),
    history: all.filter((t) => t.status !== 'pending' && mine(t)).map(decorate)
  });
});

router.post('/trades/:id/accept', (req, res) => {
  if (!res.requireAuth()) return;
  const trade = store.getTrade(req.params.id);
  if (!trade) return notFound(res);
  if (trade.toUserId !== req.user.id) {
    return forbidden(res, 'Only the owner of the requested book can accept a trade.');
  }
  if (trade.status !== 'pending') {
    return res.redirect(303, `/trades?notice=${encodeURIComponent('That proposal is no longer open.')}`);
  }
  trade.offeredBookIds.forEach((bookId) => store.setBookOwner(bookId, trade.toUserId));
  trade.wantedBookIds.forEach((bookId) => store.setBookOwner(bookId, trade.fromUserId));
  store.setTradeStatus(trade.id, 'accepted');
  res.redirect(303, `/trades?notice=${encodeURIComponent('Trade accepted — go swap the books!')}`);
});

router.post('/trades/:id/decline', (req, res) => {
  if (!res.requireAuth()) return;
  const trade = store.getTrade(req.params.id);
  if (!trade) return notFound(res);
  if (trade.toUserId !== req.user.id) {
    return forbidden(res, 'Only the owner of the requested book can decline a trade.');
  }
  if (trade.status !== 'pending') {
    return res.redirect(303, `/trades?notice=${encodeURIComponent('That proposal is no longer open.')}`);
  }
  store.setTradeStatus(trade.id, 'declined');
  res.redirect(303, `/trades?notice=${encodeURIComponent('Proposal declined.')}`);
});

router.post('/trades/:id/cancel', (req, res) => {
  if (!res.requireAuth()) return;
  const trade = store.getTrade(req.params.id);
  if (!trade) return notFound(res);
  if (trade.fromUserId !== req.user.id) {
    return forbidden(res, 'Only the person who proposed a trade can cancel it.');
  }
  if (trade.status !== 'pending') {
    return res.redirect(303, `/trades?notice=${encodeURIComponent('That proposal is no longer open.')}`);
  }
  store.setTradeStatus(trade.id, 'cancelled');
  res.redirect(303, `/trades?notice=${encodeURIComponent('Proposal withdrawn.')}`);
});

// ---- settings ---------------------------------------------------------------
router.get('/settings', (req, res) => {
  if (!res.requireAuth()) return;
  res.render('settings', { title: 'Settings', error: null });
});

router.post('/settings', (req, res) => {
  if (!res.requireAuth()) return;
  const { fullName = '', city = '', state = '' } = req.body;
  store.updateUser(req.user.id, { fullName, city, state });
  res.redirect(303, `/settings?notice=${encodeURIComponent('Settings saved.')}`);
});

// ---- users ------------------------------------------------------------------
router.get('/users', (req, res) => {
  const users = store.allUsers().map((user) => ({
    ...user,
    bookCount: store.booksByOwner(user.id).length
  }));
  res.render('users', { title: 'Members', users });
});

router.get('/users/:id', (req, res) => {
  const user = store.getUser(req.params.id);
  if (!user) return notFound(res);
  res.render('user', {
    title: user.username,
    profile: user,
    books: store.booksByOwner(user.id),
    trades: store
      .allTrades()
      .filter(
        (t) =>
          t.status === 'accepted' &&
          (t.fromUserId === user.id || t.toUserId === user.id)
      )
      .map(decorate)
  });
});

// ---- auth -------------------------------------------------------------------
router.get('/login', (req, res) => {
  res.render('login', {
    title: 'Sign in',
    error: null,
    next: safeNext(req.query.next) || '/books'
  });
});

router.post('/login', (req, res) => {
  const { username = '', password = '', next = '' } = req.body;
  const user = store.getUserByUsername(username);
  if (!user || !store.verifyPassword(password, user.password)) {
    return res.status(401).render('login', {
      title: 'Sign in',
      error: 'That username and password do not match.',
      next: safeNext(next) || '/books'
    });
  }
  const token = res.startSession(user.id);
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.redirect(303, safeNext(next) || '/books');
});

router.post('/signup', (req, res) => {
  const { username = '', password = '', fullName = '', city = '', state = '' } = req.body;
  const fail = (message) =>
    res.status(400).render('login', {
      title: 'Sign in',
      error: message,
      next: '/books'
    });

  const clean = username.trim();
  if (!clean) return fail('Pick a username.');
  if (store.getUserByUsername(clean)) return fail('That username is taken.');
  if (String(password).length < 4) return fail('Use a password of at least 4 characters.');

  const user = store.createUser({ username: clean, password, fullName, city, state });
  const token = res.startSession(user.id);
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.redirect(303, `/settings?notice=${encodeURIComponent('Welcome! Fill in your details below.')}`);
});

router.post('/logout', (req, res) => {
  res.endSession();
  res.clearCookie('session', { path: '/' });
  res.redirect(303, '/books');
});

export default function registerRoutes(app) {
  app.use(router);
}
