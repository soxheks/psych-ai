const PAGE_CACHE = 'mindmate-pages-v6';
const NAVIGATION_PATHS = ['/', '/chat/', '/journal/'];

async function warmNavigationPages() {
    const cache = await caches.open(PAGE_CACHE);
    await Promise.allSettled(NAVIGATION_PATHS.map(async (path) => {
        const response = await fetch(path, { credentials: 'same-origin' });
        if (response.ok) await cache.put(path, response);
    }));
}

self.addEventListener('install', (event) => {
    event.waitUntil(warmNavigationPages().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter((name) => name.startsWith('mindmate-pages-') && name !== PAGE_CACHE)
            .map((name) => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    if (event.request.mode !== 'navigate' || event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !NAVIGATION_PATHS.includes(url.pathname)) return;

    event.respondWith((async () => {
        const cache = await caches.open(PAGE_CACHE);
        const cached = await cache.match(url.pathname, { ignoreSearch: true, ignoreVary: true });
        const refresh = fetch(event.request)
            .then(async (response) => {
                if (response.ok) await cache.put(url.pathname, response.clone());
                return response;
            })
            .catch(() => null);

        if (cached) {
            event.waitUntil(refresh);
            return cached;
        }

        return await refresh || Response.error();
    })());
});
