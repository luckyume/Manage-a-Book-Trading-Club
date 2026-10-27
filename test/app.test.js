// End-to-end tests for the four user stories.
// They run against a real HTTP server bound to an ephemeral port, with an
// isolated data file so they never touch the seeded demo data on disk.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marginalia-test-'));
process.env.DATA_FILE = path.join(tmpDir, 'db.json');

const { createApp } = await import('../src/app.js');
const store = await import('../src/store.js');

const app = createApp();
const server = app.listen(0);
await once(server, 'listening');
after(() => server.close());

const BASE = `http://127.0.0.1:${server.address().port}`;
const isRedirect = (status) => [301, 302, 303, 307, 308].includes(status);

// A tiny browser: keeps a cookie jar and follows redirects, recording them.
function makeClient() {
  const jar = new Map();
  const client = { redirects: [] };

  function applySetCookies(res) {
    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
  }

  async function send(pathname, { method = 'GET', body, redirect = 'manual' } = {}) {
    const headers = {};
    if (jar.size) {
      headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    }
    const res = await fetch(new URL(pathname, BASE), {
      method,
      headers,
      body: payload,
      redirect
    });
    applySetCookies(res);
    return res;
  }

  client.send = async (pathname, options = {}) => {
    client.redirects = [];
    let current = pathname;
    let opts = { ...options };
    for (let hop = 0; hop < 6; hop++) {
      const res = await send(current, opts);
      if (!isRedirect(res.status)) return res;
      const location = res.headers.get('location');
      res.body?.cancel?.();
      client.redirects.push({ status: res.status, location });
      if (!location) return res;
      current = location.startsWith('http') ? new URL(location).pathname + new URL(location).search : location;
      opts = { method: 'GET' }; // 303 semantics: follow with GET
    }
    throw new Error(`too many redirects for ${pathname}`);
  };

  client.get = (pathname, options) => client.send(pathname, { ...options, method: 'GET' });
  client.post = (pathname, body, options) =>
    client.send(pathname, { ...options, method: 'POST', body });
  return client;
}

async function text(res) {
  return res.text();
}

function signIn(username, password = 'password') {
  const client = makeClient();
  return client.post('/login', { username, password }).then((res) => ({ client, res }));
}

// ---------------------------------------------------------------------------
// User Story 1: I can view all books posted by every user.
// ---------------------------------------------------------------------------
test('story 1: every book posted by every user is on the shelf', async () => {
  const anon = makeClient();
  const res = await anon.get('/books');
  assert.equal(res.status, 200, 'the shelf is public — no sign-in required');

  const html = await text(res);
  const books = store.allBooks();
  assert.ok(books.length >= 3, 'seed data has books from several members');
  for (const book of books) {
    assert.ok(html.includes(book.title), `listed: ${book.title}`);
  }

  // Each book is attributed to the member who posted it, with their location.
  const owners = new Set(books.map((b) => store.getUser(b.ownerId).username));
  assert.ok(owners.size >= 3, 'books come from more than one user');
  for (const username of owners) {
    assert.ok(html.includes(username), `owner shown: ${username}`);
  }

  // A single book's detail page also names its owner.
  const book = books[0];
  const detail = await anon.get(`/books/${book.id}`);
  assert.equal(detail.status, 200);
  assert.ok((await text(detail)).includes(store.getUser(book.ownerId).username));
});

// ---------------------------------------------------------------------------
// User Story 2: I can add a new book.
// ---------------------------------------------------------------------------
test('story 2: a signed-in member can add a new book', async () => {
  // Signed-out visitors are sent to sign in instead of posting.
  const anon = makeClient();
  const blocked = await anon.post('/books', { title: 'Ghost Book' });
  assert.equal(anon.redirects.length, 1, 'unauthenticated post is redirected');
  assert.match(anon.redirects[0].location, /^\/login/);
  assert.ok(!store.allBooks().some((b) => b.title === 'Ghost Book'));

  const { client: ada } = await signIn('ada');
  const form = await ada.get('/books/new');
  assert.equal(form.status, 200, 'the add-book form is reachable when signed in');
  assert.match(await text(form), /<form[^>]+action="\/books"/);

  const title = `The Difference Engine ${Date.now()}`;
  const posted = await ada.post('/books', {
    title,
    author: 'William Gibson',
    description: 'A Victorian what-if, hardcover.'
  });
  assert.equal(posted.status, 200, 'lands on the shelf after posting');

  const created = store.allBooks().find((b) => b.title === title);
  assert.ok(created, 'the book was stored');
  assert.equal(store.getUser(created.ownerId).username, 'ada', 'it belongs to the poster');

  // It shows up for everyone, attributed to ada.
  const shelf = await makeClient().get('/books');
  const shelfHtml = await text(shelf);
  assert.ok(shelfHtml.includes(title), 'the new book is listed publicly');
  assert.ok(shelfHtml.includes('ada'));

  // A title is required.
  const rejected = await ada.post('/books', { title: '   ' });
  assert.equal(rejected.status, 400, 'an empty title is refused');
});

// ---------------------------------------------------------------------------
// User Story 3: I can update my settings to store full name, city, and state.
// ---------------------------------------------------------------------------
test('story 3: settings store full name, city and state', async () => {
  // Signed-out visitors are sent to sign in.
  const anon = makeClient();
  await anon.get('/settings');
  assert.match(anon.redirects[0].location, /^\/login/, 'settings require an account');

  const { client: ada } = await signIn('ada');
  const freshName = `Ada L. Byron ${Date.now()}`;
  const saved = await ada.post('/settings', {
    fullName: freshName,
    city: 'London',
    state: 'UK'
  });
  assert.equal(saved.status, 200);

  // Stored on the account…
  const adaUser = store.getUser(store.getUserByUsername('ada').id);
  assert.equal(adaUser.fullName, freshName);
  assert.equal(adaUser.city, 'London');
  assert.equal(adaUser.state, 'UK');

  // …reflected back in the form…
  const form = await ada.get('/settings');
  const formHtml = await text(form);
  assert.ok(formHtml.includes(freshName), 'full name is persisted in the form');
  assert.ok(formHtml.includes('London'));
  assert.ok(formHtml.includes('UK'));

  // …visible to other members on the profile…
  const profile = await makeClient().get(`/users/${adaUser.id}`);
  const profileHtml = await text(profile);
  assert.ok(profileHtml.includes(freshName), 'profile shows the full name');
  assert.ok(profileHtml.includes('London, UK'), 'profile shows city and state');

  // …and beside their books on the public shelf.
  const shelf = await makeClient().get('/books');
  assert.ok((await text(shelf)).includes('London, UK'), 'shelf shows where the books are');
});

// ---------------------------------------------------------------------------
// User Story 4: I can propose a trade and wait for the other user to accept.
// ---------------------------------------------------------------------------
test('story 4: a proposed trade waits until the other member accepts', async () => {
  const adaUser = store.getUserByUsername('ada');
  const graceUser = store.getUserByUsername('grace');
  const bookForAda = store.allBooks().find((b) => b.ownerId === adaUser.id);
  const bookFromGrace = store.allBooks().find((b) => b.ownerId === graceUser.id);
  assert.ok(bookForAda && bookFromGrace, 'both members have books listed');

  const { client: grace } = await signIn('grace');
  const { client: ada } = await signIn('ada');

  // Grace picks one of her books to offer for ada's book.
  const form = await grace.get(`/books/${bookForAda.id}/trade`);
  assert.equal(form.status, 200);
  assert.ok((await text(form)).includes(bookFromGrace.title), 'her own books are offered as choices');

  const beforeAda = bookForAda.ownerId;
  const beforeGrace = bookFromGrace.ownerId;

  const proposed = await grace.post(`/books/${bookForAda.id}/trades`, {
    offered: [bookFromGrace.id]
  });
  assert.equal(proposed.status, 200);

  const trade = store.allTrades().find((t) => t.fromUserId === graceUser.id);
  assert.ok(trade, 'the proposal exists');
  assert.equal(trade.status, 'pending', 'it starts out pending');
  assert.equal(trade.toUserId, adaUser.id, 'it is addressed to the book’s owner');

  // While it is pending, ownership does not change and both sides see the wait.
  assert.equal(store.getBook(bookForAda.id).ownerId, beforeAda, 'nothing has moved yet');
  assert.equal(store.getBook(bookFromGrace.id).ownerId, beforeGrace);
  const graceTrades = await text(await grace.get('/trades'));
  assert.ok(graceTrades.includes('Waiting'), 'grace sees the proposal as waiting');
  assert.ok(graceTrades.includes('Waiting for ada to accept'), '…and on whom');

  const adaTrades = await text(await ada.get('/trades'));
  assert.ok(adaTrades.includes('Accept trade'), 'ada can accept the incoming proposal');
  assert.ok(adaTrades.includes('grace'));
  assert.ok(adaTrades.includes(bookFromGrace.title));
  assert.ok(adaTrades.includes(bookForAda.title));

  // Only ada may decide it.
  const hijack = await grace.post(`/trades/${trade.id}/accept`, {});
  assert.equal(hijack.status, 403, 'the proposer cannot accept their own trade');
  assert.equal(store.getBook(bookForAda.id).ownerId, beforeAda, 'ownership is untouched');

  // Ada accepts: the books change hands.
  const accepted = await ada.post(`/trades/${trade.id}/accept`, {});
  assert.equal(accepted.status, 200);
  assert.equal(store.getBook(bookForAda.id).ownerId, graceUser.id, 'ada’s book went to grace');
  assert.equal(store.getBook(bookFromGrace.id).ownerId, adaUser.id, 'grace’s book went to ada');
  assert.equal(store.getTrade(trade.id).status, 'accepted');

  // Both members see the completed trade, and the shelf reflects the swap.
  for (const client of [grace, ada]) {
    const html = await text(await client.get('/trades'));
    assert.ok(html.includes('Accepted'), 'history records the accepted trade');
  }
  const shelf = await text(await makeClient().get('/books'));
  assert.ok(shelf.includes(bookForAda.title), 'the traded book is still on the shelf');
});

// ---------------------------------------------------------------------------
// Related behaviour: declining leaves everything in place.
// ---------------------------------------------------------------------------
test('a declined proposal leaves ownership unchanged', async () => {
  const adaUser = store.getUserByUsername('ada');
  const alanUser = store.getUserByUsername('alan');
  const bookForAda = store
    .allBooks()
    .find((b) => b.ownerId === adaUser.id && store.allTrades().every((t) => !t.wantedBookIds.includes(b.id)));
  const bookFromAlan = store
    .allBooks()
    .find((b) => b.ownerId === alanUser.id && store.allTrades().every((t) => !t.offeredBookIds.includes(b.id)));
  assert.ok(bookForAda && bookFromAlan, 'an untouched pair of books exists');

  const { client: alan } = await signIn('alan');
  const { client: ada } = await signIn('ada');
  await alan.post(`/books/${bookForAda.id}/trades`, { offered: [bookFromAlan.id] });
  const trade = store.allTrades().find((t) => t.fromUserId === alanUser.id);
  assert.equal(trade.status, 'pending');

  const declined = await ada.post(`/trades/${trade.id}/decline`, {});
  assert.equal(declined.status, 200);
  assert.equal(store.getTrade(trade.id).status, 'declined');
  assert.equal(store.getBook(bookForAda.id).ownerId, adaUser.id, 'nothing moved');
  assert.equal(store.getBook(bookFromAlan.id).ownerId, alanUser.id);

  const html = await text(await alan.get('/trades'));
  assert.ok(html.includes('Declined'), 'the proposer sees the outcome');
});
