const SW_VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const STATIC_CACHE = `static-${SW_VERSION}`;
const JSON_CACHE = `json-${SW_VERSION}`;
const AUDIO_CACHE = `audio-${SW_VERSION}`;
const META_CACHE = `meta-${SW_VERSION}`;
const AUDIO_META_KEY = '/__audio_meta__.json';

const AUDIO_MAX_ENTRIES = 40;
const AUDIO_MAX_BYTES = 180 * 1024 * 1024;

const APP_SCOPE_PATH = new URL(self.registration.scope).pathname;
const APP_BASE = APP_SCOPE_PATH.endsWith('/') ? APP_SCOPE_PATH : `${APP_SCOPE_PATH}/`;

function toAppPath(path = '') {
  return `${APP_BASE}${String(path).replace(/^\/+/, '')}`;
}

function stripAppBase(pathname = '') {
  if (!pathname.startsWith(APP_BASE)) return pathname;
  return pathname.slice(APP_BASE.length - 1);
}

const SHELL_ASSETS = [
  toAppPath(''),
  toAppPath('index.html'),
  toAppPath('offline/'),
  toAppPath('news/'),
  toAppPath('privacy/'),
  toAppPath('fb_feed/'),
  toAppPath('assets/'),
  toAppPath('favicon.ico'),
  toAppPath('favicon.svg'),
  toAppPath('manifest.webmanifest'),
  toAppPath('data/hymn-a-full.json'),
  toAppPath('data/hymn-b-full.json'),
  toAppPath('data/hymn-c-full.json'),
  toAppPath('data/hymn-d-full.json'),
  toAppPath('data/hymn-e-full.json'),
  toAppPath('data/asset-audit-report.json'),
  toAppPath('data/lighthouse-mobile-baseline.json'),
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key !== STATIC_CACHE &&
                key !== JSON_CACHE &&
                key !== AUDIO_CACHE &&
                key !== META_CACHE
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (!url.pathname.startsWith(APP_BASE)) {
    return;
  }

  const accept = request.headers.get('accept') || '';
  const isHtmlRequest = request.mode === 'navigate' || accept.includes('text/html');
  const isJsonRequest =
    request.destination === '' &&
    (stripAppBase(url.pathname).endsWith('.json') || accept.includes('application/json'));
  const isAudioRequest =
    request.destination === 'audio' ||
    stripAppBase(url.pathname).endsWith('.mid') ||
    stripAppBase(url.pathname).startsWith('/midi/');

  if (isHtmlRequest) {
    event.respondWith(networkFirstHtml(request));
    return;
  }

  if (isJsonRequest) {
    event.respondWith(networkFirstJson(request));
    return;
  }

  if (isAudioRequest) {
    event.respondWith(cacheFirstAudioWithLru(request, event));
  }
});

async function networkFirstHtml(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const networkResponse = await fetch(request);
    cache.put(request, networkResponse.clone());
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }

    const fallback = await cache.match(toAppPath('offline/')) || await cache.match(toAppPath('offline/index.html'));
    if (fallback) {
      return fallback;
    }

    return new Response('Offline', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function networkFirstJson(request) {
  const cache = await caches.open(JSON_CACHE);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
  }

  return new Response('{}', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function cacheFirstAudioWithLru(request, event) {
  const cache = await caches.open(AUDIO_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    event.waitUntil(touchAudioEntry(request.url));
    return cached;
  }

  const networkResponse = await fetch(request);
  if (!networkResponse || !networkResponse.ok) {
    return networkResponse;
  }

  const forCache = networkResponse.clone();
  const forSize = networkResponse.clone();
  cache.put(request, forCache);

  event.waitUntil(
    forSize
      .blob()
      .then((blob) => recordAudioEntry(request.url, blob.size))
      .then(() => pruneAudioCache())
  );

  return networkResponse;
}

async function readAudioMeta() {
  const cache = await caches.open(META_CACHE);
  const response = await cache.match(AUDIO_META_KEY);
  if (!response) {
    return {};
  }

  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function writeAudioMeta(meta) {
  const cache = await caches.open(META_CACHE);
  await cache.put(
    AUDIO_META_KEY,
    new Response(JSON.stringify(meta), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  );
}

async function touchAudioEntry(url) {
  const meta = await readAudioMeta();
  if (!meta[url]) {
    meta[url] = { size: 0, lastAccessed: Date.now() };
  } else {
    meta[url].lastAccessed = Date.now();
  }
  await writeAudioMeta(meta);
}

async function recordAudioEntry(url, size) {
  const meta = await readAudioMeta();
  meta[url] = {
    size,
    lastAccessed: Date.now(),
  };
  await writeAudioMeta(meta);
}

async function pruneAudioCache() {
  const cache = await caches.open(AUDIO_CACHE);
  const meta = await readAudioMeta();
  const entries = Object.entries(meta)
    .filter(([, value]) => value && typeof value.size === 'number')
    .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

  let totalBytes = entries.reduce((acc, [, value]) => acc + (value.size || 0), 0);
  let totalEntries = entries.length;

  while (totalEntries > AUDIO_MAX_ENTRIES || totalBytes > AUDIO_MAX_BYTES) {
    const oldest = entries.shift();
    if (!oldest) {
      break;
    }

    const [url, value] = oldest;
    await cache.delete(url);
    delete meta[url];

    totalEntries -= 1;
    totalBytes -= value.size || 0;
  }

  await writeAudioMeta(meta);
}
