# History → Meilisearch

A Chrome Extension (Manifest V3) that, once installed, reads the **entire browsing history** and bulk-indexes it into a local [Meilisearch](https://www.meilisearch.com/) instance.

Each document stored in the `browsing-history` index contains:

| Field           | Type     | Description                              |
| --------------- | -------- | ---------------------------------------- |
| `id`            | `string` | Chrome's internal history item ID        |
| `url`           | `string` | Page URL                                 |
| `title`         | `string` | Page title                               |
| `lastVisitTime` | `number` | Timestamp of the last visit (ms epoch)   |
| `visitCount`    | `number` | Total number of visits to the page       |

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- A running Meilisearch instance at `http://localhost:7700`

## Setup

```
npm install
npm run build
```

This produces `dist/service-worker.js` — the bundled service worker with the Meilisearch SDK inlined.

During development you can run a watcher that rebuilds on every source change:

```
npm run watch
```

## Loading the extension

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this directory.

The `onInstalled` handler fires immediately, queries the full history, and dispatches batches of 1 000 documents to Meilisearch concurrently — without blocking the service worker.

Progress and any upload errors are logged to the extension's service-worker console (click **Inspect views: service worker** on the extensions page).
