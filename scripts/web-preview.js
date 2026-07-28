#!/usr/bin/env node
/**
 * Cross-origin-isolating proxy for the Expo Web dev server.
 *
 * WHY THIS EXISTS
 *
 * `expo-sqlite` on web runs SQLite in a Web Worker and talks to it through a
 * `SharedArrayBuffer` (see node_modules/expo-sqlite/web/WorkerChannel.ts). Browsers
 * only expose `SharedArrayBuffer` on a cross-origin-isolated page, which requires
 * two response headers on the document:
 *
 *     Cross-Origin-Opener-Policy:   same-origin
 *     Cross-Origin-Embedder-Policy: credentialless
 *
 * Metro has a `server.enhanceMiddleware` hook for this, but Expo CLI runs its own
 * dev server and does not call it, so setting it in metro.config.js has no effect.
 * Rather than patch Expo or contort the app, this proxy sits in front of the dev
 * server and adds the headers.
 *
 * It also has to serve the worker script itself. `expo-sqlite` loads its worker with
 *
 *     new Worker(new URL('./worker', window.location.href))
 *
 * i.e. from `/worker` on the page's own origin — but expo-router's catch-all route
 * answers `/worker` with the HTML shell. The browser then tries to execute HTML as
 * JavaScript, the worker dies, and `openDatabaseAsync()` waits forever on a reply
 * that never comes. Metro does serve the real worker, at a different path, so this
 * proxy maps one to the other.
 *
 * This is a DEVELOPMENT CONVENIENCE for previewing the app in a browser. It is not
 * part of the product and is not used by the Android or iOS builds, where SQLite is
 * native and none of this applies.
 *
 * Usage:
 *     npx expo start --web --port 8081        # in apps/mobile
 *     node scripts/web-preview.js             # then open http://localhost:8082
 */

const http = require('node:http');
const net = require('node:net');

const UPSTREAM_HOST = process.env.BONCHI_WEB_UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.BONCHI_WEB_UPSTREAM_PORT || 8081);
const LISTEN_PORT = Number(process.env.BONCHI_WEB_PREVIEW_PORT || 8082);

/**
 * `credentialless` rather than `require-corp`: it isolates the page without
 * demanding that every cross-origin subresource carry CORP headers, so ordinary
 * requests to the Supabase API keep working.
 */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/**
 * Metro's URL for the expo-sqlite web worker. The transform flags must match what
 * the main bundle was built with, or the worker gets an incompatible runtime.
 */
const SQLITE_WORKER_PATH =
  '/node_modules/expo-sqlite/web/worker.bundle' +
  '?platform=web&dev=true&hot=false&transform.engine=hermes&transform.routerRoot=app';

function upstreamPathFor(url) {
  const [pathname] = (url || '/').split('?');
  // expo-router would answer this with index.html; send it to the real worker.
  if (pathname === '/worker') return SQLITE_WORKER_PATH;
  return url;
}

const server = http.createServer((clientRequest, clientResponse) => {
  const isWorkerRequest = (clientRequest.url || '').split('?')[0] === '/worker';

  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: clientRequest.method,
      path: upstreamPathFor(clientRequest.url),
      headers: { ...clientRequest.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
    },
    (upstreamResponse) => {
      const headers = { ...upstreamResponse.headers, ...ISOLATION_HEADERS };
      if (isWorkerRequest) {
        // Metro labels bundles as JavaScript already, but be explicit: a worker
        // served with the wrong content type is rejected outright.
        headers['content-type'] = 'application/javascript; charset=utf-8';
      }
      clientResponse.writeHead(upstreamResponse.statusCode || 502, headers);
      upstreamResponse.pipe(clientResponse);
    },
  );

  upstream.on('error', (error) => {
    // The dev server not being up yet is the common case; say so plainly rather
    // than dumping a stack trace on every reload attempt.
    clientResponse.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    clientResponse.end(
      `Cannot reach the Expo dev server at ${UPSTREAM_HOST}:${UPSTREAM_PORT}.\n\n` +
        `Start it first:\n  cd apps/mobile && npx expo start --web --port ${UPSTREAM_PORT}\n\n` +
        `(${error.message})\n`,
    );
  });

  clientRequest.pipe(upstream);
});

// Metro's hot reload uses a WebSocket, so CONNECT/Upgrade has to be tunnelled or
// every edit would require a manual refresh.
server.on('upgrade', (clientRequest, clientSocket, head) => {
  const upstreamSocket = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    const headerLines = Object.entries(clientRequest.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n');
    upstreamSocket.write(
      `${clientRequest.method} ${clientRequest.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`,
    );
    if (head && head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstreamSocket.destroy());
});

server.listen(LISTEN_PORT, () => {
  console.log(`Bonchi web preview  →  http://localhost:${LISTEN_PORT}`);
  console.log(`  proxying          →  http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  console.log('  adding            →  COOP/COEP so expo-sqlite can use SharedArrayBuffer');
  console.log('  routing /worker   →  the real expo-sqlite worker bundle');
});
