import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Serve only deployed assets, under the same repository prefix as GitHub Pages.
const root = new URL('../../', import.meta.url);
const assets = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['index.html', ['index.html', 'text/html; charset=utf-8']],
  ['css/styles.css', ['css/styles.css', 'text/css; charset=utf-8']],
  ['js/app.js', ['js/app.js', 'text/javascript; charset=utf-8']],
  ['js/api.js', ['js/api.js', 'text/javascript; charset=utf-8']],
  ['js/permute.js', ['js/permute.js', 'text/javascript; charset=utf-8']],
]);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1:4173').pathname;
  const asset = pathname.startsWith('/DexPermuter/') && assets.get(pathname.slice('/DexPermuter/'.length));
  if (!asset || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(new URL(asset[0], root));
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch {
    response.writeHead(500).end('Could not read application asset.');
  }
});
server.listen(4173, '127.0.0.1', () => console.log('Browser fixture server: http://127.0.0.1:4173/DexPermuter/'));
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
