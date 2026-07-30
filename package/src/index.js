const crypto = require("node:crypto");

async function createObserverMiddleware(config = {}) {
  return function observerMiddleware(req, res, next) {
    const requestId = req.get("x-request-id") ?? crypto.randomUUID();

    const reqCopy = {
      method: req.method,
      url: buildFullUrl(req),
      headers: {
        ...req.headers,
        "X-Request-ID": requestId,
      },
    };

    console.log(reqCopy);

    next();
  };
}

function buildFullUrl(req) {
  const forwardedProto = req.get("x-forwarded-proto");

  const protocol = forwardedProto
    ? forwardedProto.split(",")[0].trim()
    : req.protocol;

  const host = req.get("host") ?? "";

  if (!host) {
    return req.originalUrl;
  }

  return `${protocol}://${host}` + req.originalUrl;
}

module.exports = createObserverMiddleware;
