// Custom Next.js server.
//
// --- Node-RED "Automation" integration: TEMPORARILY DISABLED ---
// See nodered/DEV_NOTES.md (gitignored) for current status/why. To
// re-enable: flip NODERED_ENABLED to true below, uncomment the `nodered`
// service in docker-compose.yml (and the dashboard service's `depends_on`/
// `NODERED_URL` lines), and uncomment the nav item in components/Sidebar.tsx.
// Everything else here (the proxy logic itself) is left intact rather than
// deleted so re-enabling is a one-line flip, not a rewrite.
//
// Proxies /nodered/* (HTTP + WebSocket) to the Node-RED container so it
// appears under the dashboard's own origin/port instead of a separate port,
// then hands everything else to Next's own request handler. WebSocket
// proxying (Node-RED's live deploy-status/debug panel) is why this is a
// custom server rather than next.config.ts rewrites() — rewrites don't
// proxy the `upgrade` event.
//
// /nodered is the RAW proxy target (Node-RED's own full-page UI) — the
// dashboard's actual "Automation" nav item is the Next.js page at
// app/automation/page.tsx, which keeps the dashboard's own sidebar/layout
// and embeds this path in an <iframe>. Kept as two distinct paths so an
// iframe pointed at /nodered isn't itself trying to render inside another
// iframe's worth of dashboard chrome.
//
// This intentionally does NOT use `output: 'standalone'` (see next.config.ts)
// — a hand-written server.js and Next's own generated standalone server are
// two different, non-combinable deployment modes; this is the standard
// custom-server pattern (https://nextjs.org/docs/app/building-your-application/configuring/custom-server).
// Kept even while Node-RED is disabled since reverting it and setting it back
// up again later would just be repeated work for a currently-inert file.
const NODERED_ENABLED = false;

const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const httpProxy = require('http-proxy');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);
const hostname = process.env.HOSTNAME || '0.0.0.0';
const noderedUrl = process.env.NODERED_URL || 'http://nodered:1880';

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const proxy = NODERED_ENABLED
  ? httpProxy.createProxyServer({ target: noderedUrl, ws: true, changeOrigin: true })
  : null;
if (proxy) {
  proxy.on('error', (err, req, res) => {
    console.error(`[nodered proxy] ${err.message}`);
    if (res && !res.headersSent && typeof res.writeHead === 'function') {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Automation service (Node-RED) is unreachable.');
    }
  });
}

function isNoderedPath(url) {
  return NODERED_ENABLED && (url === '/nodered' || url.startsWith('/nodered/'));
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    if (isNoderedPath(req.url)) {
      // Node-RED's own Express app registers its index route at
      // `<httpAdminRoot>/` (trailing slash) — hitting the bare path without
      // it 404s with "Cannot GET /nodered". Redirect once so both forms work.
      if (req.url === '/nodered') {
        res.writeHead(302, { Location: '/nodered/' });
        res.end();
        return;
      }
      proxy.web(req, res);
      return;
    }
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  // Node-RED's editor relies on a WebSocket ("comms") channel for live
  // deploy status and the debug sidebar — proxy the upgrade event too, not
  // just regular HTTP requests.
  server.on('upgrade', (req, socket, head) => {
    if (isNoderedPath(req.url)) {
      proxy.ws(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  server.listen(port, hostname, () => {
    const noderedStatus = NODERED_ENABLED ? `proxying /nodered -> ${noderedUrl}` : 'Node-RED integration disabled';
    console.log(`> Ready on http://${hostname}:${port} (${noderedStatus})`);
  });
});
