// 按 Magpie 官方页面服务协议：宿主提供回环服务，入口握手后导航。
import { startServer } from "./lib/server.mjs";

let activePromise = null;
let activeService = null;
let activePort = null;

export default {
  id: "magpie-claude-desktop-zh-cn",
  server: async (_input, options) => {
    const requestedPort = Number(options?.port);
    const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535
      ? requestedPort
      : 3485;

    if (activePromise && activePort !== null && activePort !== port) {
      const prev = await activePromise;
      activePromise = null;
      activeService = null;
      activePort = null;
      if (prev) {
        await prev.close().catch(() => {});
      }
    }

    if (!activePromise) {
      activePort = port;
      activePromise = startServer({ port })
        .then((svc) => {
          activeService = svc;
          activePort = svc.port;
          return svc;
        })
        .catch((error) => {
          console.error(`[claude-desktop-zh-cn] ${error.message}`);
          activePromise = null;
          activeService = null;
          activePort = null;
          return null;
        });
    }

    await activePromise;
    return {};
  },
};
