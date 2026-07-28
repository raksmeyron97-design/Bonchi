// Metro configuration.
//
// Two concerns here, both non-obvious.
//
// 1. pnpm monorepo: `node-linker=hoisted` in .npmrc keeps node_modules flat, but
//    Metro still has to be told that source lives outside this app directory so
//    the workspace packages (@bonchi/domain and friends) resolve and hot-reload.
//
// 2. expo-sqlite on web: its worker imports `wa-sqlite.wasm`, which Metro will not
//    resolve unless `wasm` is an asset extension, and wa-sqlite needs
//    SharedArrayBuffer, which the browser only exposes on a cross-origin-isolated
//    page. Without both, the worker bundle fails to build and
//    `openDatabaseAsync()` never settles — the app sits on its loading spinner
//    forever with no error, because a hang is not a rejection.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// --- expo-sqlite on web ------------------------------------------------------
config.resolver.assetExts.push('wasm');

// Cross-origin isolation (COOP/COEP) is ALSO required, because the worker talks to
// SQLite through a SharedArrayBuffer. It is deliberately NOT configured here:
// Metro's `server.enhanceMiddleware` hook exists, but Expo CLI runs its own dev
// server and never calls it, so setting it in this file silently does nothing.
//
// The headers are added by scripts/web-preview.js instead — a small proxy in front
// of the dev server. See that file. Native builds need none of this: SQLite is
// native there.

module.exports = config;
