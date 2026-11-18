// 不使用 Magpie 时也可启动：node serve.mjs，然后打开 http://127.0.0.1:3485
import { startServer } from "./lib/server.mjs";

const rawPort = Number(process.env.PORT);
const port = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : 3485;
const service = await startServer({ port });
console.log(`Claude Desktop 中文助手：http://127.0.0.1:${service.port}`);
console.log("关闭此窗口即可停止服务。");

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await service.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
