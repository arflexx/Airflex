import express from "express";
import { requestId } from "./requestId";

const app = express();
app.use(requestId);
app.get("/", (_req, res) => res.status(200).json({ status: "ok" }));

export default app;
