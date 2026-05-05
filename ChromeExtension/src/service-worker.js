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

const MEILISEARCH_HOST = 'http://localhost:7700';
const MEILISEARCH_API_KEY = 'FKWCx7iTGUvHbP7LsIV1rLvujYGn1tFF4f2WFZBTTLQ';

/** Number of documents sent per addDocuments call. */
const BATCH_SIZE = 1000;

/** Number of words per chunk. */
const CHUNK_SIZE = 150;

/** Number of words shared between two consecutive chunks (sliding window). */
const CHUNK_OVERLAP = 50;

const client = new MeiliSearch({
  host: MEILISEARCH_HOST,
  apiKey: MEILISEARCH_API_KEY,
});

/** Index that holds one document per visited URL (mirrors chrome.history). */
const historyIndex = client.index('browsing-history');

/** Index that holds word-level chunks of each page's readable text. */
const chunksIndex = client.index('page-chunks');

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

/** @type {string[]} */
const BLACKLISTED_HOSTNAMES = [
  "google.com",
  "google.fr",
  "duckduckgo.com",
  "bing.com"
];

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Yields successive slices of `array` of length `size`.
 *
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
 * Extracts the bare hostname from a URL (e.g. "local.kerollmops.com").
 * Returns null for IP addresses (IPv4 and IPv6) and for URLs that cannot
 * be parsed, so the field is always clean — no protocol, port, or path.
 *
 * @param {string} url
 * @returns {string | null}
 */
function extractHostname(url) {
  try {
    const { hostname } = new URL(url);
    // IPv4 — four dot-separated digit groups
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
    // IPv6 — URL.hostname strips the surrounding brackets, leaving raw colons
    if (hostname.includes(':')) return null;
    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Maps a Chrome HistoryItem to a `browsing-history` document.
 *
 * @param {chrome.history.HistoryItem} item
 * @returns {{ id: string, url: string, title: string, hostname: string | null, lastVisitTime: number, visitCount: number }}
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
 * Uploads run concurrently; errors are logged without blocking the caller.
 *
 * @param {object[]} documents
 * @param {import('meilisearch').Index} [targetIndex]
 */
function indexDocuments(documents, targetIndex = historyIndex) {
  for (const batch of chunks(documents, BATCH_SIZE)) {
    targetIndex.addDocuments(batch).catch((err) => {
      console.error('[history-meilisearch] Failed to upload batch:', err);
    });
  }
}

// ─── Page-chunk helpers ───────────────────────────────────────────────────────

/**
 * Splits `text` into overlapping word-based chunks.
 * Each chunk is CHUNK_SIZE words long; consecutive chunks overlap by
 * CHUNK_OVERLAP words (sliding window).
 *
 * @param {string} text
 * @yields {string}
 */
function* chunkText(text) {
  const words = text.trim().split(/\s+/);
  const step = CHUNK_SIZE - CHUNK_OVERLAP; // advance by 100 words each time

  for (let i = 0; i < words.length; i += step) {
    yield words.slice(i, i + CHUNK_SIZE).join(' ');
    // Stop once the last chunk has been yielded to avoid an empty tail chunk.
    if (i + CHUNK_SIZE >= words.length) break;
  }
}

/**
 * Indexes the readable text of a page as overlapping chunks in `chunksIndex`,
 * then enqueues a stale-chunk cleanup for the same page.
 *
 * Stale chunks are those that were written during an earlier visit
 * (lastVisitTime < currentLastVisitTime) for the same historyId.
 * Because Meilisearch processes tasks in FIFO order per index, the
 * deleteDocumentsByFilter task is guaranteed to run after all the
 * addDocuments tasks above it — so freshly created chunks are never at risk.
 *
 * @param {chrome.history.HistoryItem} historyItem
 * @param {string} content  Readable plain text extracted by Readability.
 */
function indexPageChunks(historyItem, content) {
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

  // Upload new chunks (fire-and-forget, batched).
  indexDocuments(documents, chunksIndex);

  // Remove chunks from any previous visit to the same page.
  chunksIndex
    .deleteDocuments({
      filter: `historyId = ${historyId} AND lastVisitTime < ${lastVisitTime}`,
    })
    .catch((err) => {
      console.error('[history-meilisearch] Failed to delete stale chunks:', err);
    });
}

// ─── On install: configure indices + bulk-import the full browsing history ────

chrome.runtime.onInstalled.addListener(async () => {
  // Create both indices with an explicit primary key, then apply their full
  // settings. Both steps are fire-and-forget: Meilisearch's global FIFO task
  // queue guarantees that updateSettings is always processed after createIndex
  // for the same index, even without awaiting. If an index already exists the
  // createIndex task fails silently and the queue keeps moving.
  client.createIndex('browsing-history', { primaryKey: 'id' }).catch(console.error);
  historyIndex.updateSettings(HISTORY_INDEX_SETTINGS).catch(console.error);

  client.createIndex('page-chunks', { primaryKey: 'id' }).catch(console.error);
  chunksIndex.updateSettings(CHUNKS_INDEX_SETTINGS).catch(console.error);

  const historyItems = await chrome.history.search({
    text: '',
    maxResults: 0,
    startTime: 0,
  });

  console.log(
    `[history-meilisearch] Indexing ${historyItems.length} history items` +
      ` in batches of ${BATCH_SIZE}…`
  );

  indexDocuments(historyItems.filter((item) => {
    return !BLACKLISTED_HOSTNAMES.includes(item.hostname);
  }).map(toHistoryDocument));
});

// ─── On every new visit: upsert the updated history entry ────────────────────

// chrome.history.onVisited fires after Chrome has already committed the visit
// to its database, so the HistoryItem it delivers (visitCount, lastVisitTime)
// is immediately up to date. No secondary lookup is needed.
chrome.history.onVisited.addListener((item) => {
  if (BLACKLISTED_HOSTNAMES.includes(item.hostname)) return;
  indexDocuments([toHistoryDocument(item)]);
});

// ─── On page content from the content script: chunk and index ─────────────────

chrome.runtime.onMessage.addListener((message, _sender) => {
  if (message.type !== 'PAGE_CONTENT') return;

  const { url, content } = message;

  // Retrieve the live HistoryItem for this URL so we have the canonical `id`
  // and an up-to-date `lastVisitTime` to tag the chunks with.
  // chrome.history.search does a text match; the strict url equality check
  // below guards against substring matches on unrelated URLs.
  chrome.history
    .search({ text: url, maxResults: 10 })
    .then((items) => {
      const item = items.find((i) => i.url === url);
      if (item) indexPageChunks(item, content);
    })
    .catch(console.error);

  // Return undefined (not `true`) — we are not sending a response, so the
  // message port can be closed immediately.
});
