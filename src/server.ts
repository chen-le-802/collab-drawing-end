import app from "./app";
import { env } from "./config/env";

// server.ts 只做一件事：启动 HTTP 服务。
// 端口统一从 env 配置中读取，避免把 process.env 散落到各个文件里。
app.listen(env.port, () => {
  console.log(`Server is running on port ${env.port}`);
});
