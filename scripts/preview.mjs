import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHarness } from "../test-support/harness.mjs";

const assets = new Map([
  ["/Carrot/", ["index.html", "text/html; charset=utf-8"]],
  ["/Carrot/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/Carrot/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

export async function startPreview() {
  const pagesUrl = "http://127.0.0.1:8788/Carrot/";
  const harness = createHarness({ pagesUrl, port: 8787 });
  try {
    const workerOrigin = (await harness.worker.ready).origin;
    const server = createServer(async (request, response) => {
      const path = new URL(request.url, pagesUrl).pathname;
      if (path === "/Carrot/config.js") {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        response.end(`export const workerOrigin = ${JSON.stringify(workerOrigin)};`);
        return;
      }
      const asset = assets.get(path);
      if (!asset) {
        response.writeHead(404).end();
        return;
      }
      try {
        const body = await readFile(new URL(`../docs/${asset[0]}`, import.meta.url));
        response.writeHead(200, { "Content-Type": asset[1] }).end(body);
      } catch {
        response.writeHead(500).end();
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(8788, "127.0.0.1", resolve);
    });
    return {
      ...harness, pagesUrl,
      async close() {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await harness.worker.dispose();
      },
    };
  } catch (error) {
    await harness.worker.dispose();
    throw error;
  }
}

if (import.meta.main) {
  const preview = await startPreview();
  console.log(`本机演示（仅虚拟数据，关闭后清空）\n${preview.pagesUrl}`);
  for (const [user, password] of Object.entries(preview.passwords)) {
    console.log(`测试账号 ${user}    密码 ${password}`);
  }
  process.once("SIGINT", () => void preview.close());
}
