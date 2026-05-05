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

import DOMPurify from 'dompurify';
import { Readability } from '@mozilla/readability';

// ─── Page content extraction (skip own.kerollmops.com) ────────────────────────
//
// We don't want to index the search page itself into Meilisearch, and the
// bridge below handles all communication for that domain.

if (location.hostname !== 'own.kerollmops.com') {
  // Clone the document first — both DOMPurify (IN_PLACE mode) and Readability
  // mutate the node tree they receive.
  const documentClone = document.cloneNode(true);

  // Sanitize the clone before handing it to Readability.
  DOMPurify.sanitize(documentClone.documentElement, {
    IN_PLACE: true,
    WHOLE_DOCUMENT: true,
  });

  const article = new Readability(documentClone).parse();
  const content = article?.textContent?.trim();

  if (content) {
    chrome.runtime.sendMessage({ type: 'PAGE_CONTENT', url: location.href, content });
  }
}

// ─── Ownggle Bridge (own.kerollmops.com only) ─────────────────────────────────
//
// The page at own.kerollmops.com cannot talk to the extension service worker
// directly (no externally_connectable), so it posts window messages that this
// content script relays to chrome.runtime and back.

if (location.hostname === 'own.kerollmops.com') {
  const ORIGIN = location.origin; // 'https://own.kerollmops.com'

  // ── Page → Extension ──────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    // Only accept messages from the same window (the page itself).
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;

    // Save settings to chrome.storage.local so the service worker can read them.
    if (msg.type === 'OWNGGLE_SAVE_SETTINGS') {
      chrome.storage.local
        .set({
          meili_url:        msg.url       ?? '',
          meili_admin_key:  msg.adminKey  ?? '',
          meili_search_key: msg.searchKey ?? '',
        })
        .then(() => {
          window.postMessage({ type: 'OWNGGLE_SETTINGS_SAVED' }, ORIGIN);
        })
        .catch((err) => {
          window.postMessage({ type: 'OWNGGLE_SETTINGS_ERROR', error: err.message }, ORIGIN);
        });
    }

    // Ask the service worker to start a full history sync.
    if (msg.type === 'OWNGGLE_SYNC_HISTORY') {
      chrome.runtime.sendMessage({ type: 'SYNC_HISTORY' }, (response) => {
        if (chrome.runtime.lastError) {
          window.postMessage(
            { type: 'OWNGGLE_SYNC_ERROR', error: chrome.runtime.lastError.message },
            ORIGIN,
          );
        } else if (response?.started) {
          window.postMessage({ type: 'OWNGGLE_SYNC_STARTED' }, ORIGIN);
        }
      });
    }
  });

  // ── Extension → Page ──────────────────────────────────────────────────────
  // The service worker sends progress/completion messages via chrome.tabs.sendMessage;
  // we relay them to the page as OWNGGLE_* window messages.

  chrome.runtime.onMessage.addListener((message) => {
    if (['SYNC_PROGRESS', 'SYNC_COMPLETE', 'SYNC_ERROR'].includes(message.type)) {
      window.postMessage(
        { ...message, type: 'OWNGGLE_' + message.type },
        ORIGIN,
      );
    }
  });
}
