// Copyright 2024 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  outdir: 'dist',
  platform: 'browser',
  target: 'chrome120',
};

// MV3 background service workers support ES modules when "type": "module"
// is declared in the manifest's background section.
const serviceWorker = { ...shared, entryPoints: ['src/service-worker.js'], format: 'esm' };

// Content scripts are loaded as classic scripts — ES module syntax is not
// supported, so we wrap the bundle in an IIFE instead.
const contentScript = { ...shared, entryPoints: ['src/content-script.js'], format: 'iife' };

const configs = [serviceWorker, contentScript];

if (watch) {
  Promise.all(configs.map((cfg) => esbuild.context(cfg).then((ctx) => ctx.watch()))).catch(
    () => process.exit(1)
  );
} else {
  Promise.all(configs.map((cfg) => esbuild.build(cfg))).catch(() => process.exit(1));
}
