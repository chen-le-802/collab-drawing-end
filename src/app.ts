import cors from "cors";
import express from "express";

import router from "./routes";

// app 只负责创建和配置 Express 实例。
// 这样后面如果要做测试，或者把服务启动逻辑拆开，会更清晰。
const app = express();

// 允许前端跨域访问当前服务。
app.use(cors());

// 解析 application/json 请求体。
app.use(express.json());

// 解析表单格式请求体。
app.use(express.urlencoded({ extended: true }));

// 统一把业务路由挂到 /api 前缀下。
// 后续新增模块路由时，优先在 routes/index.ts 中集中注册。
app.use("/api", router);

export default app;
