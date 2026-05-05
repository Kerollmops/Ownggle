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

import { MeiliSearch } from 'meilisearch';

// ─── Storage keys ─────────────────────────────────────────────────────────────

const SK_URL        = 'meili_url';
const SK_ADMIN_KEY  = 'meili_admin_key';
const SK_SEARCH_KEY = 'meili_search_key';

// ─── Configuration ────────────────────────────────────────────────────────────

/** Number of documents sent per addDocuments call. */
const BATCH_SIZE = 1000;

/** Number of words per chunk. */
const CHUNK_SIZE = 150;

/** Number of words shared between two consecutive chunks (sliding window). */
const CHUNK_OVERLAP = 50;

/** @type {string[]} */
const BLACKLISTED_HOSTNAMES = [
  'google.com',
  'www.google.com',
  'google.fr',
  'duckduckgo.com',
  'noai.duckduckgo.com',
  'bing.com',
];

// ─── Settings cache ───────────────────────────────────────────────────────────

/** @type {{ url: string|null, adminKey: string|null, searchKey: string|null }|null} */
let _settingsCache = null;

/** Reads settings from chrome.storage.local with a simple in-memory cache. */
async function getSettings() {
  if (_settingsCache) return _settingsCache;
  const data = await chrome.storage.local.get([SK_URL, SK_ADMIN_KEY, SK_SEARCH_KEY]);
  _settingsCache = {
    url:       data[SK_URL]        || null,
    adminKey:  data[SK_ADMIN_KEY]  || null,
    searchKey: data[SK_SEARCH_KEY] || null,
  };
  return _settingsCache;
}

// Invalidate the cache whenever the user saves new settings.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') _settingsCache = null;
});

// ─── Client factory ───────────────────────────────────────────────────────────

/**
 * @param {{ url: string, adminKey: string }} settings
 * @returns {MeiliSearch}
 */
function makeClient({ url, adminKey }) {
  return new MeiliSearch({ host: url, apiKey: adminKey });
}

// ─── Index settings ───────────────────────────────────────────────────────────

/** @type {import('meilisearch').Settings} */
const HISTORY_INDEX_SETTINGS = {
  searchableAttributes: ['title', 'hostname'],
  filterableAttributes: [
    {
      attributePatterns: ['visitCount', 'lastVisitTime'],
      features: {
        facetSearch: false,
        filter: { equality: true, comparison: true },
      },
    },
    {
      attributePatterns: ['id', 'hostname'],
      features: {
        facetSearch: true,
        filter: { equality: true, comparison: false },
      },
    },
  ],
  sortableAttributes: ['visitCount', 'lastVisitTime'],
};

/** @type {import('meilisearch').Settings} */
const CHUNKS_INDEX_SETTINGS = {
  searchableAttributes: ['content', 'hostname'],
  filterableAttributes: [
    {
      attributePatterns: ['lastVisitTime'],
      features: {
        facetSearch: false,
        filter: { equality: true, comparison: true },
      },
    },
    {
      attributePatterns: ['historyId'],
      features: {
        facetSearch: false,
        filter: { equality: true, comparison: false },
      },
    },
  ],
  sortableAttributes: ['chunkIndex', 'lastVisitTime'],
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Yields successive slices of `array` of length `size`.
 * @template T
 * @param {T[]} array
 * @param {number} size
 * @yields {T[]}
 */
function* chunks(array, size) {
  for (let i = 0; i < array.length; i += size) {
    yield array.slice(i, i + size);
  }
}

/**
 * Extracts the bare hostname from a URL.
 * Returns null for IP addresses, localhost, and unparseable URLs.
 * @param {string} url
 * @returns {string | null}
 */
function extractHostname(url) {
  try {
    const { hostname } = new URL(url);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
    if (hostname.includes(':')) return null;
    if (hostname === 'localhost') return null;
    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Maps a Chrome HistoryItem to a `browsing-history` document.
 * @param {chrome.history.HistoryItem} item
 */
function toHistoryDocument({ id, url, title, lastVisitTime, visitCount }) {
  return {
    id,
    url,
    title: title ?? '',
    hostname: extractHostname(url),
    lastVisitTime: lastVisitTime ?? 0,
    visitCount: visitCount ?? 0,
  };
}

/**
 * Sends `documents` to `targetIndex` in fire-and-forget batches of BATCH_SIZE.
 * @param {object[]} documents
 * @param {import('meilisearch').Index} targetIndex
 */
function indexDocuments(documents, targetIndex) {
  for (const batch of chunks(documents, BATCH_SIZE)) {
    targetIndex.addDocuments(batch).catch((err) => {
      console.error('[ownggle] Failed to upload batch:', err);
    });
  }
}

// ─── Page-chunk helpers ───────────────────────────────────────────────────────

/**
 * Splits `text` into overlapping word-based chunks.
 * @param {string} text
 * @yields {string}
 */
function* chunkText(text) {
  const words = text.trim().split(/\s+/);
  const step = CHUNK_SIZE - CHUNK_OVERLAP;
  for (let i = 0; i < words.length; i += step) {
    yield words.slice(i, i + CHUNK_SIZE).join(' ');
    if (i + CHUNK_SIZE >= words.length) break;
  }
}

/**
 * Indexes the readable text of a page as overlapping chunks.
 * @param {chrome.history.HistoryItem} historyItem
 * @param {string} content  Readable plain text from Readability.
 * @param {import('meilisearch').Index} chunksIndex
 */
function indexPageChunks(historyItem, content, chunksIndex) {
  const { id: historyId, url, lastVisitTime } = historyItem;
  const hostname = extractHostname(url);

  const documents = Array.from(
    chunkText(content),
    (chunkContent, chunkIndex) => ({
      id: crypto.randomUUID(),
      historyId,
      url,
      hostname,
      lastVisitTime,
      chunkIndex,
      content: chunkContent,
    })
  );

  if (documents.length === 0) return;

  indexDocuments(documents, chunksIndex);

  chunksIndex
    .deleteDocuments({
      filter: `historyId = ${historyId} AND lastVisitTime < ${lastVisitTime}`,
    })
    .catch((err) => {
      console.error('[ownggle] Failed to delete stale chunks:', err);
    });
}

// ─── Full sync ────────────────────────────────────────────────────────────────

/**
 * Creates/configures both indices and bulk-imports the full browsing history.
 * Sends progress + completion messages to the requesting tab.
 * @param {number|undefined} tabId  Chrome tab to notify.
 */
async function handleSyncHistory(tabId) {
  /** Sends a message to the requesting tab (best-effort, ignores errors). */
  const notify = (msg) => {
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    }
  };

  const settings = await getSettings();
  if (!settings.url || !settings.adminKey) {
    notify({
      type: 'SYNC_ERROR',
      error: 'Meilisearch is not configured. Please save your settings first.',
    });
    return;
  }

  const client       = makeClient(settings);
  const historyIndex = client.index('browsing-history');
  const chunksIndex  = client.index('page-chunks');

  // Create indices (idempotent — createIndex fails silently if they already exist).
  await client.createIndex('browsing-history', { primaryKey: 'id' }).catch(() => {});
  await client.createIndex('page-chunks',      { primaryKey: 'id' }).catch(() => {});

  // Apply settings (Meilisearch's FIFO task queue guarantees ordering).
  historyIndex.updateSettings(HISTORY_INDEX_SETTINGS).catch(console.error);
  chunksIndex.updateSettings(CHUNKS_INDEX_SETTINGS).catch(console.error);

  // Fetch the full browsing history.
  const historyItems = await chrome.history.search({ text: '', maxResults: 0, startTime: 0 });

  const docs = historyItems
    .filter((item) => {
      const h = extractHostname(item.url ?? '');
      return h !== null && !BLACKLISTED_HOSTNAMES.includes(h);
    })
    .map(toHistoryDocument);

  console.log(`[ownggle] Syncing ${docs.length} history items…`);
  notify({ type: 'SYNC_PROGRESS', indexed: 0, total: docs.length });

  let indexed = 0;
  for (const batch of chunks(docs, BATCH_SIZE)) {
    await historyIndex.addDocuments(batch);
    indexed += batch.length;
    notify({ type: 'SYNC_PROGRESS', indexed, total: docs.length });
  }

  notify({ type: 'SYNC_COMPLETE', total: indexed });
  console.log(`[ownggle] Sync complete: ${indexed} items queued.`);
}

// ─── On install: open the setup page ─────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.create({ url: 'https://own.kerollmops.com' });
});

// ─── On every new visit: upsert the updated history entry ────────────────────

chrome.history.onVisited.addListener(async (item) => {
  const settings = await getSettings();
  if (!settings.url || !settings.adminKey) return; // not configured yet

  const hostname = extractHostname(item.url ?? '');
  if (hostname && BLACKLISTED_HOSTNAMES.includes(hostname)) return;

  const client       = makeClient(settings);
  const historyIndex = client.index('browsing-history');
  indexDocuments([toHistoryDocument(item)], historyIndex);
});

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── SYNC_HISTORY ──────────────────────────────────────────────────────────
  // Triggered from the setup page via the content-script bridge.
  if (message.type === 'SYNC_HISTORY') {
    const tabId = sender.tab?.id;
    // Respond immediately so the page knows the request was received,
    // then continue the heavy work asynchronously in the background.
    sendResponse({ started: true });
    handleSyncHistory(tabId).catch((err) => {
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, {
          type: 'SYNC_ERROR',
          error: err.message,
        }).catch(() => {});
      }
      console.error('[ownggle] Sync failed:', err);
    });
    return false; // channel already closed by sendResponse above
  }

  // ── PAGE_CONTENT ──────────────────────────────────────────────────────────
  // Readable text extracted by the content script on every visited page.
  if (message.type === 'PAGE_CONTENT') {
    const { url, content } = message;

    getSettings()
      .then(async (settings) => {
        if (!settings.url || !settings.adminKey) return;

        const client      = makeClient(settings);
        const chunksIndex = client.index('page-chunks');

        const items = await chrome.history.search({ text: url, maxResults: 10 });
        const item  = items.find((i) => i.url === url);
        if (item) indexPageChunks(item, content, chunksIndex);
      })
      .catch(console.error);
    // No response needed; return nothing.
  }
});
