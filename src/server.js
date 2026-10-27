import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, () => {
  console.log(`Marginalia book trading club → http://localhost:${server.address().port}`);
});
