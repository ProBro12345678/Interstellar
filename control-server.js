import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import express from "express";

const app = express();
const CONTROL_PORT = 8080;
const INTERSTELLAR_PORT = 8081;
const PASSWORD = process.env.CONTROL_PASSWORD;

if (!PASSWORD) {
  console.warn("WARNING: CONTROL_PASSWORD is not set. The Start Server button is disabled until it is configured.");
}

let interstellar = null;

app.use(express.urlencoded({ extended: true }));

function serverIsListening() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port: INTERSTELLAR_PORT });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function startInterstellar() {
  if (interstellar && !interstellar.killed) return;

  interstellar = spawn("npm", ["start"], {
    env: { ...process.env, PORT: String(INTERSTELLAR_PORT) },
    stdio: "inherit",
    shell: true,
  });

  interstellar.on("exit", () => {
    interstellar = null;
  });
}

function page(title, body) {
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{font-family:Arial,sans-serif;background:#111;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.box{background:#222;padding:35px;border-radius:14px;width:min(360px,80vw);text-align:center;box-shadow:0 8px 30px #0008}
input{box-sizing:border-box;width:100%;padding:12px;margin:15px 0;border:0;border-radius:7px}
button{padding:12px 22px;border:0;border-radius:7px;cursor:pointer;font-weight:bold}
.status{margin:18px 0;color:#aaa}
.error{color:#ff7777}
</style>
</head>
<body><div class="box">${body}</div></body>
</html>`;
}

app.get("/", async (_req, res) => {
  if (await serverIsListening()) {
    return res.send(page("Interstellar", `
      <h1>Interstellar is running</h1>
      <p class="status">Opening Interstellar...</p>
      <script>location.replace("/__interstellar__")</script>
    `));
  }

  res.send(page("Interstellar Server", `
    <h1>Interstellar</h1>
    <p class="status">Server is currently offline.</p>
    ${PASSWORD ? `
    <form method="POST" action="/start">
      <input type="password" name="password" placeholder="Password" required autofocus>
      <button type="submit">Start Server</button>
    </form>` : `
    <p class="error">CONTROL_PASSWORD has not been configured.</p>
    <p>Set the Codespace secret/environment variable and restart the control server.</p>`}
  `));
});

app.post("/start", async (req, res) => {
  if (!PASSWORD || req.body.password !== PASSWORD) {
    return res.status(401).send(page("Access denied", "<h1>Access denied</h1><p class='error'>Incorrect password.</p><p><a href='/' style='color:white'>Go back</a></p>"));
  }

  startInterstellar();

  for (let i = 0; i < 30; i++) {
    if (await serverIsListening()) {
      return res.redirect("/");
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  res.status(504).send(page("Startup failed", "<h1>Startup timed out</h1><p>Interstellar did not start on port 8081. Check the Codespace terminal/logs.</p><p><a href='/' style='color:white'>Try again</a></p>"));
});

app.get("/__interstellar__", async (_req, res) => {
  if (!(await serverIsListening())) return res.redirect("/");
  res.redirect("/");
});

const controlServer = http.createServer(app);

// Proxy ordinary HTTP traffic to Interstellar while keeping the public URL on port 8080.
controlServer.on("request", async (req, res) => {
  if (req.url === "/" || req.url === "/start" || req.url === "/__interstellar__") return;

  if (!(await serverIsListening())) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Interstellar is offline. Return to / to start it.");
  }

  const proxy = http.request({
    hostname: "127.0.0.1",
    port: INTERSTELLAR_PORT,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${INTERSTELLAR_PORT}` },
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxy.on("error", err => {
    console.error("Proxy error:", err);
    if (!res.headersSent) res.writeHead(502);
    res.end("Interstellar proxy error.");
  });

  req.pipe(proxy);
});

// Preserve WebSocket upgrades used by the proxy itself.
controlServer.on("upgrade", async (req, socket, head) => {
  if (!(await serverIsListening())) {
    socket.destroy();
    return;
  }

  const proxy = http.request({
    hostname: "127.0.0.1",
    port: INTERSTELLAR_PORT,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${INTERSTELLAR_PORT}` },
  });

  proxy.once("upgrade", (_res, proxySocket, proxyHead) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\n");
    for (const [key, value] of Object.entries(_res.headers)) {
      socket.write(`${key}: ${value}\r\n`);
    }
    socket.write("\r\n");
    if (proxyHead.length) socket.write(proxyHead);
    if (head.length) proxySocket.write(head);
    proxySocket.pipe(socket).pipe(proxySocket);
  });

  proxy.on("error", () => socket.destroy());
  proxy.end();
});

controlServer.listen(CONTROL_PORT, () => {
  console.log(`Control server running on http://localhost:${CONTROL_PORT}`);
});
