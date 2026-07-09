/**
 * Node-RED settings — mounted read-only into /data/settings.js.
 *
 * Served behind the dashboard's own origin via a path-based reverse proxy
 * (dashboard/server.js proxies /nodered/* to this container, HTTP + the
 * WebSocket "comms" channel used for live deploy status / the debug panel).
 * The dashboard's "Automation" page then embeds /nodered in an <iframe> so
 * the dashboard's own sidebar/layout stays visible around it.
 * httpAdminRoot/httpNodeRoot below must match that proxy path exactly, or
 * the editor's own asset/API/websocket URLs won't resolve once proxied.
 *
 * No admin auth is configured here — this intentionally matches the rest of
 * the dashboard (no login system today; the deployment network is assumed
 * trusted/internal). If that assumption ever changes, add `adminAuth` here
 * (see https://nodered.org/docs/user-guide/runtime/securing-node-red)
 * BEFORE exposing this to anything less trusted — Function/exec nodes let
 * anyone who can reach the editor run arbitrary code on this host.
 */
module.exports = {
    uiPort: process.env.PORT || 1880,

    // Path this editor/runtime is served under once proxied by the dashboard.
    httpAdminRoot: '/nodered',
    // Flow-defined HTTP in/out nodes live under a distinct sub-path so they
    // never collide with the dashboard's own /api/* Next.js routes.
    httpNodeRoot: '/nodered/api',

    // Everything below persists in the /data volume (named volume in
    // docker-compose, NOT committed to git — contains flows + credentials +
    // any community nodes installed via "Manage palette").
    flowFile: 'flows.json',
    userDir: '/data',

    // Community nodes (via the editor's "Manage palette", or by adding
    // dependencies to /data/package.json) install into this same volume and
    // survive container recreation as long as the volume isn't deleted.

    functionGlobalContext: {
        // Add shared modules/config here if flows need them, e.g.:
        // mqttBroker: process.env.MQTT_BROKER,
    },

    editorTheme: {
        page: {
            title: 'Automation',
            css: '/data/custom-theme.css',
        },
        header: {
            title: 'Automation',
        },
        // The dashboard already provisions/manages docker-compose services —
        // Node-RED's own "Projects" (git-backed flow storage) would be a
        // second, redundant place to manage config. Keep flows as a single
        // flows.json file instead (the default/simpler model).
        projects: {
            enabled: false,
        },
    },

    logging: {
        console: {
            level: 'info',
            metrics: false,
            audit: false,
        },
    },

    // The dashboard embeds this editor in a same-origin <iframe> (app/automation/page.tsx).
    // Explicitly allow same-origin framing so a stricter default (or a future
    // Node-RED version defaulting to X-Frame-Options: DENY) can't silently
    // blank out that iframe.
    httpAdminMiddleware: function (req, res, next) {
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
        next();
    },
};
