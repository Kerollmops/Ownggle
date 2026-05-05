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

// Clone the document first — both DOMPurify (IN_PLACE mode) and Readability
// mutate the node tree they receive.
const documentClone = document.cloneNode(true);

// Sanitize the clone before handing it to Readability. Readability explicitly
// does not sanitize its input, so a malicious page could otherwise inject
// scripts into the output. WHOLE_DOCUMENT preserves the <html>/<head>/<body>
// structure that Readability relies on to locate the main content area.
DOMPurify.sanitize(documentClone.documentElement, {
  IN_PLACE: true,
  WHOLE_DOCUMENT: true,
});

const article = new Readability(documentClone).parse();
const content = article?.textContent?.trim();

if (content) {
  // The service worker will look up the matching HistoryItem to obtain the
  // stable `id` and up-to-date `lastVisitTime` before indexing the chunks.
  chrome.runtime.sendMessage({ type: 'PAGE_CONTENT', url: location.href, content });
}
