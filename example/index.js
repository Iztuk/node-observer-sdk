const express = require("express");

const { createObserverMiddleware } = require("@Iztuk/observer-sdk");

async function start() {
  const app = express();
  const port = 3000;

  app.use(express.json());
  app.use(
    express.urlencoded({
      extended: true,
    }),
  );

  const observerMiddleware = await createObserverMiddleware({
    observerAddr: "http://localhost:24899",
    hostName: "express-test-service",
    openApi: "./openapi.yaml",
    hostRules: "./rules.yaml",
  });

  app.use(observerMiddleware);

  app.get("/", (_req, res) => {
    res.send("Hello World!");
  });

  app.get("/hello", (req, res) => {
    res.json({
      message: "Hello from Express",
      requestId: req.get("x-request-id") ?? null,
    });
  });

  app.post("/users", (req, res) => {
    res.status(201).json({
      message: "User created",
      user: req.body,
    });
  });

  app.get("/failure", () => {
    throw new Error("Intentional test failure");
  });

  app.use((error, _req, res, _next) => {
    console.error(error);

    res.status(500).json({
      error: "Internal Server Error",
    });
  });

  app.listen(port, () => {
    console.log(`Express app listening on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to initialize application:", error);

  process.exitCode = 1;
});
