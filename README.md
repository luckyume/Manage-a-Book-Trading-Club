# Marginalia — Manage a Book Trading Club

A small book-trading club: every member posts the books they’d pass on, and trades
them with each other, one handshake at a time.

## User stories

1. **I can view all books posted by every user** — `/books` is public and lists every
   book with its owner and location.
2. **I can add a new book** — signed-in members post a title, author and description
   at `/books/new`.
3. **I can update my settings to store my full name, city, and state** — `/settings`
   saves them to the account; they appear on the profile and beside the member’s books.
4. **I can propose a trade and wait for the other user to accept the trade** — propose
   one of your books for someone else’s; the proposal stays *pending* until the owner
   accepts (or declines) it at `/trades`. Accepting swaps ownership of both books.

## Run it

```sh
npm install
npm start          # http://localhost:3000  (or PORT=xxxx npm start)
npm run dev        # restarts on file changes
```

Demo members — `ada`, `grace`, `alan`, password `password`.

## Tests

```sh
npm test
```

`test/app.test.js` boots the real server on an ephemeral port with an isolated data
file and walks through all four user stories over HTTP, including a full two-member
trade (propose → wait → accept → ownership swapped) and a declined proposal.

## Shape of it

- `src/store.js` — JSON-file data store (`data/db.json`) with scrypt-hashed passwords
- `src/app.js` — Express app, cookie sessions, helpers
- `src/routes.js` — books, trades, settings, members, auth
- `views/` — EJS server-rendered pages, `public/styles.css` for the paper-and-ink look
