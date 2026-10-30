// 本地反向代理:hutch 的 Zig http 不认代理,把它的下载源指到本机再经 Clash 转发。
// 规则:
//   /electrobun/templates/channels/stable.json  → 上游目录,改写其中绝对归档 URL 指回本机
//   /tpl/<sha>.tar.gz                            → 按 map 转发到 electrobun-artifacts.blackboard.sh
//   其余路径                                      → 原样转发 hutch.blackboard.sh
const PORT = 8642;
const HUTCH_BASE = "https://hutch.blackboard.sh";
const ARTIFACTS_BASE = "https://electrobun-artifacts.blackboard.sh";
const PROXY = process.env.PROXY_URL || "http://127.0.0.1:7897";
const SELF = `http://127.0.0.1:${PORT}`;

const tplMap = new Map<string, string>(); // 本机文件名 -> 上游绝对 URL

async function viaProxy(url: string, init?: any): Promise<Response> {
  return fetch(url, { ...init, proxy: PROXY, redirect: "follow" });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    console.log(`[fwd] ${req.method} ${path}`);
    try {
      // 模板目录:改写绝对归档 URL → 本机
      if (path === "/electrobun/templates/channels/stable.json" || path === "/channels/stable.json") {
        const resp = await viaProxy(`${HUTCH_BASE}/electrobun/templates/channels/stable.json`);
        const cat: any = await resp.json();
        for (const t of cat.templates ?? []) {
          const orig = t.archive?.url;
          if (typeof orig === "string") {
            const name = orig.split("/").pop();
            tplMap.set(`/tpl/${name}`, orig);
            t.archive.url = `${SELF}/tpl/${name}`;
          }
        }
        return Response.json(cat);
      }
      // 模板归档
      if (url.pathname.startsWith("/tpl/")) {
        const target = tplMap.get(url.pathname);
        if (!target) return new Response("no such tpl", { status: 404 });
        const resp = await viaProxy(target);
        const buf = await resp.arrayBuffer();
        return new Response(buf, { status: resp.status, headers: resp.headers });
      }
      // 默认:转发 hutch.blackboard.sh
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("connection");
      const resp = await viaProxy(HUTCH_BASE + path, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
      });
      const buf = await resp.arrayBuffer();
      return new Response(buf, { status: resp.status, headers: resp.headers });
    } catch (err: any) {
      console.error(`[fwd] ERROR ${path}: ${err?.message ?? err}`);
      return new Response("forwarder error: " + (err?.message ?? err), { status: 502 });
    }
  },
});
console.log(`[fwd] ${SELF} -> ${HUTCH_BASE} (+artifacts) via ${PROXY}`);
