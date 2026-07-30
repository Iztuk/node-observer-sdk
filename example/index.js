const express = require("express");
const createObserverMiddleware = require("@Iztuk/observer-sdk");

const app = express();
const port = 3000;

app.use(express.json());

async function start() {
  const observerMiddleware = await createObserverMiddleware({
    observerAddr: "http://localhost:24899",
    hostName: "express-test-service",
    openApi: "./openapi.yaml",
    hostRules: "./rules.yaml",
  });

  app.use(observerMiddleware);

  app.get("/", (req, res) => {
    res.send("Hello World!");
  });

  app.listen(port, () => {
    console.log(`Example app listening on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start Express application:", error);
  process.exit(1);
});
