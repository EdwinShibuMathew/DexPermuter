import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Test-only streams use real HTTP headers/bodies; production assets stay under
// the same repository prefix as GitHub Pages. This server binds loopback only.
const root = new URL('../../', import.meta.url);
const streams = new Map();
const assets = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['index.html', ['index.html', 'text/html; charset=utf-8']],
  ['css/styles.css', ['css/styles.css', 'text/css; charset=utf-8']],
  ['js/app.js', ['js/app.js', 'text/javascript; charset=utf-8']],
  ['js/teams.js', ['js/teams.js', 'text/javascript; charset=utf-8']],
  ['js/team-ui.js', ['js/team-ui.js', 'text/javascript; charset=utf-8']],
  ['js/api.js', ['js/api.js', 'text/javascript; charset=utf-8']],
  ['js/permute.js', ['js/permute.js', 'text/javascript; charset=utf-8']],
]);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1:4173').pathname;
  const stream = pathname.match(/^\/DexPermuter\/__test__\/streams\/([a-zA-Z0-9-]+)(\/complete)?$/);
  if (stream) {
    const [, id, complete] = stream;
    if (request.method === 'GET' && !complete) {
      if (streams.has(id)) { response.writeHead(409).end(); return; }
      streams.set(id, response);
      response.on('close', () => { if (streams.get(id) === response) streams.delete(id); });
      response.on('error', () => { if (streams.get(id) === response) streams.delete(id); });
      // Chromium can report ERR_ABORTED after successful no-store stream reads:
      // https://github.com/microsoft/playwright/issues/42742
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      response.flushHeaders();
      response.write('{"id":');
      return;
    }
    if (request.method === 'POST' && complete) {
      const pending = streams.get(id);
      if (!pending || pending.destroyed) { response.writeHead(404).end(); return; }
      streams.delete(id);
      pending.end(JSON.stringify(id) + '}');
      response.writeHead(200).end('complete');
      return;
    }
    response.writeHead(405).end();
    return;
  }
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
