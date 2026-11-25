// Antigravity Chinese Localization Engine - Swarm
(function() {
  try {
    if (exports.__antigravitySwarmZhHooked || typeof exports.pluginResponse !== 'function') {
      return;
    }
    const fs = require('node:fs');
    const path = require('node:path');
    const originalPluginResponse = exports.pluginResponse;
    const SWARM_SCRIPT_MARKER = '__antigravitySwarmZhVersion';
    let cachedSwarmScript = null;

    function getSwarmScript() {
      if (cachedSwarmScript !== null) return cachedSwarmScript;
      try {
        const scriptFile = path.join(__dirname, 'swarm-translator.js');
        if (fs.existsSync(scriptFile)) {
          cachedSwarmScript = fs.readFileSync(scriptFile, 'utf8').replace(/<\/script/gi, '<\\/script');
        } else {
          cachedSwarmScript = '';
        }
      } catch {
        cachedSwarmScript = '';
      }
      return cachedSwarmScript;
    }

    function maybeInjectSwarmHtml(res) {
      try {
        if (!res || res.status !== 200 || !res.body) return res;
        if (!res.headers || typeof res.headers.get !== 'function') return res;
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('text/html')) return res;
        if (res.headers.get('content-encoding')) return res;
        const swarmScript = getSwarmScript();
        if (!swarmScript) return res;

        return res.text().then((html) => {
          if (
            typeof html !== 'string' ||
            !html.includes('data-testid="swarm-board"') ||
            html.includes(SWARM_SCRIPT_MARKER)
          ) {
            const passthroughHeaders = new Headers(res.headers);
            passthroughHeaders.delete('content-length');
            return new Response(html, {
              status: res.status,
              statusText: res.statusText,
              headers: passthroughHeaders,
            });
          }
          const tag = '\n<script>\n' + swarmScript + '\n</script>\n';
          const patched = /<\/body>/i.test(html)
            ? html.replace(/<\/body>/i, (matched) => tag + matched)
            : (html + tag);
          const headers = new Headers(res.headers);
          headers.delete('content-length');
          headers.delete('etag');
          return new Response(patched, {
            status: res.status,
            statusText: res.statusText,
            headers,
          });
        }).catch(() => res);
      } catch {
        return res;
      }
    }

    exports.pluginResponse = function(response, target, frame) {
      const res = originalPluginResponse.call(this, response, target, frame);
      if (res && typeof res.then === 'function') {
        return res.then(maybeInjectSwarmHtml);
      }
      return maybeInjectSwarmHtml(res);
    };
    exports.__antigravitySwarmZhHooked = true;
  } catch (e) {
    console.error('[antigravity-swarm-zh] Hook failed:', e);
  }
})();
