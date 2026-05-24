import app from "./app";
import { env } from "./config/env";
import { runRuntimeGuard } from "./config/runtimeGuard";
import { startDbHealthcheck, stopDbHealthcheck } from "./services/dbHealthService";
import { initWebSocketServer } from "./ws/server";
import { createServer } from "http";

// server.ts 负责“启动层”职责：
// 1) 运行前检查
// 2) 创建并启动 HTTP Server
// 3) 在同一个 HTTP Server 上挂载 WebSocket
// 4) 注册进程退出清理逻辑
//
// 说明：
// - app.ts 只负责组装 Express 应用（中间件、路由），不负责监听端口。
// - WebSocket 初始化放在这里，是因为它需要绑定真正的 httpServer 实例。
// - 这样 HTTP 与 WS 共用同一端口，部署与鉴权链路更统一。
runRuntimeGuard();
startDbHealthcheck();

// 把 Express app 包装成 Node 原生 HTTP Server。
// 后续 WS 会挂在这个 server 上（而不是直接挂在 app 上）。
const httpServer = createServer(app);

// 初始化 WebSocket 服务入口（/ws）并绑定到当前 HTTP Server。
// 这样浏览器访问同一域名端口即可同时走 HTTP API 和 WS 长连接。
initWebSocketServer(httpServer);

// 启动监听端口。
// 端口统一从 env 读取，避免 process.env 在业务文件散落。
httpServer.listen(env.port, () => {
  console.log(`Server is running on port ${env.port}`);
});

// 进程退出时清理后台任务，避免健康检查定时器残留。
process.on("SIGTERM", () => {
  stopDbHealthcheck();
});
process.on("SIGINT", () => {
  stopDbHealthcheck();
});
