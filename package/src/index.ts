import crypto from "node:crypto";

import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

import {
  initializeClient,
  sendEvent,
  type ClientRegistration,
  type FailureCopy,
  type HTTPExchangeEvent,
  type HTTPHeaders,
  type RequestCopy,
  type ResponseCopy,
} from "./event";

import { loadOpenAPIDocument, loadRulesDocument } from "./audit";

export interface APIObserverConfig {
  observerAddr: string;
  hostName: string;
  openApi?: string;
  hostRules?: string;

  /**
   * Maximum number of response bytes retained in memory.
   */
  maxResponseBodyBytes?: number;
}

interface ObserverRequestState {
  requestCopy: RequestCopy;
  responseSent: boolean;
}

const observerRequestState = new WeakMap<Request, ObserverRequestState>();

/**
 * Loads the client files, registers the client with API Observer,
 * and returns the Express request middleware.
 *
 * Initialization failures are thrown to the consuming application.
 */
export async function createObserverMiddleware(
  config: APIObserverConfig,
): Promise<RequestHandler> {
  validateConfig(config);

  let client: ClientRegistration;

  try {
    client = await loadClientFiles(
      config.hostName,
      config.openApi,
      config.hostRules,
    );
  } catch (error) {
    throw new Error("failed to load API Observer client files", {
      cause: error,
    });
  }

  try {
    await initializeClient(config.observerAddr, client);
  } catch (error) {
    throw new Error("failed to initialize API Observer client", {
      cause: error,
    });
  }

  const maxResponseBodyBytes = config.maxResponseBodyBytes ?? 1024 * 1024;

  return function observerMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    try {
      const requestId = req.get("x-request-id") ?? crypto.randomUUID();

      // Make the request ID available to downstream middleware.
      req.headers["x-request-id"] = requestId;

      // Return the request ID to the caller.
      res.setHeader("x-request-id", requestId);

      const requestCopy: RequestCopy = {
        method: req.method,
        url: buildFullURL(req),
        header: {
          ...normalizeHeaders(req.headers),
          "x-request-id": [requestId],
        },
        body: encodeRequestBody(req.body),
      };

      const state: ObserverRequestState = {
        requestCopy,
        responseSent: false,
      };

      observerRequestState.set(req, state);

      const requestEvent: HTTPExchangeEvent = {
        host: client.host,
        request: requestCopy,
      };

      sendEventAsync(config.observerAddr, client, requestEvent);

      observeResponse({
        req,
        res,
        client,
        observerAddr: config.observerAddr,
        maxResponseBodyBytes,
      });

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Captures errors passed through Express's error pipeline.
 *
 * Register this after routes and before the application's final
 * error handler.
 */
export function createObserverErrorMiddleware(
  config: APIObserverConfig,
  client?: ClientRegistration,
): ErrorRequestHandler {
  return function observerErrorMiddleware(
    error: unknown,
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    const state = observerRequestState.get(req);

    if (!state) {
      next(error);
      return;
    }

    const failure: FailureCopy = {
      request: state.requestCopy,
      error: getErrorMessage(error),
    };

    const event: HTTPExchangeEvent = {
      host: client?.host ?? config.hostName,
      failure,
    };

    if (client) {
      sendEventAsync(config.observerAddr, client, event);
    } else {
      console.error(
        "API Observer could not send failure event: " +
          "client registration was not provided",
      );
    }

    // Do not consume the application's error.
    next(error);
  };
}

interface ObserveResponseOptions {
  req: Request;
  res: Response;
  client: ClientRegistration;
  observerAddr: string;
  maxResponseBodyBytes: number;
}

function observeResponse({
  req,
  res,
  client,
  observerAddr,
  maxResponseBodyBytes,
}: ObserveResponseOptions): void {
  const chunks: Buffer[] = [];

  let capturedBytes = 0;
  let truncated = false;
  let finished = false;

  const originalWrite = res.write.bind(res);

  const originalEnd = res.end.bind(res);

  function captureChunk(chunk: unknown, encoding?: BufferEncoding): void {
    if (chunk === undefined || chunk === null) {
      return;
    }

    const buffer = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : Buffer.from(String(chunk), encoding ?? "utf8");

    const remaining = maxResponseBodyBytes - capturedBytes;

    if (remaining <= 0) {
      truncated = true;
      return;
    }

    if (buffer.length > remaining) {
      chunks.push(buffer.subarray(0, remaining));
      capturedBytes += remaining;
      truncated = true;
      return;
    }

    chunks.push(buffer);
    capturedBytes += buffer.length;
  }

  res.write = ((
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    const encoding =
      typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;

    captureChunk(chunk, encoding);

    if (typeof encodingOrCallback === "function") {
      return originalWrite(chunk as never, encodingOrCallback);
    }

    return originalWrite(chunk as never, encodingOrCallback as never, callback);
  }) as typeof res.write;

  res.end = ((
    chunkOrCallback?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    if (
      typeof chunkOrCallback !== "function" &&
      chunkOrCallback !== undefined
    ) {
      const encoding =
        typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;

      captureChunk(chunkOrCallback, encoding);
    }

    return originalEnd(
      chunkOrCallback as never,
      encodingOrCallback as never,
      callback,
    );
  }) as typeof res.end;

  res.once("finish", () => {
    finished = true;

    const state = observerRequestState.get(req);

    if (!state || state.responseSent) {
      return;
    }

    state.responseSent = true;

    const responseCopy: ResponseCopy = {
      request: state.requestCopy,
      status_code: res.statusCode,
      headers: normalizeHeaders(res.getHeaders()),
      body: Buffer.concat(chunks).toString("base64"),
    };

    const responseEvent: HTTPExchangeEvent = {
      host: client.host,
      response: responseCopy,
    };

    sendEventAsync(observerAddr, client, responseEvent);
  });

  res.once("close", () => {
    if (finished) {
      return;
    }

    const state = observerRequestState.get(req);

    if (!state) {
      return;
    }

    const failureEvent: HTTPExchangeEvent = {
      host: client.host,
      failure: {
        request: state.requestCopy,
        error: "connection closed before response completed",
      },
    };

    sendEventAsync(observerAddr, client, failureEvent);
  });
}

async function loadClientFiles(
  hostName: string,
  openApiPath?: string,
  hostRulesPath?: string,
): Promise<ClientRegistration> {
  const registration: ClientRegistration = {
    host: hostName,
  };

  if (openApiPath) {
    registration.openapi = await loadOpenAPIDocument(openApiPath);
  }

  if (hostRulesPath) {
    registration.host_rules = await loadRulesDocument(hostRulesPath);
  }

  return registration;
}

function sendEventAsync(
  endpoint: string,
  client: ClientRegistration,
  event: HTTPExchangeEvent,
): void {
  void sendEvent(endpoint, client, event).catch((error: unknown) => {
    console.error("An error occurred while sending observer event:", error);
  });
}

function buildFullURL(req: Request): string {
  const forwardedProto = req.get("x-forwarded-proto");

  const scheme =
    forwardedProto?.split(",").at(0)?.trim() || req.protocol || "http";

  const host = req.get("host");
  const path = req.originalUrl || "/";

  if (!host) {
    return path;
  }

  return `${scheme}://${host}${path.startsWith("/") ? path : `/${path}`}`;
}

function encodeRequestBody(body: unknown): string {
  if (body === undefined || body === null) {
    return "";
  }

  if (Buffer.isBuffer(body)) {
    return body.toString("base64");
  }

  if (typeof body === "string") {
    return Buffer.from(body, "utf8").toString("base64");
  }

  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}

function normalizeHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): HTTPHeaders {
  const normalized: HTTPHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      normalized[name] = value.map(String);
      continue;
    }

    normalized[name] = [String(value)];
  }

  return normalized;
}

function validateConfig(config: APIObserverConfig): void {
  if (!config) {
    throw new TypeError("API Observer configuration is required");
  }

  if (
    typeof config.observerAddr !== "string" ||
    config.observerAddr.trim() === ""
  ) {
    throw new TypeError("API Observer observerAddr is required");
  }

  if (typeof config.hostName !== "string" || config.hostName.trim() === "") {
    throw new TypeError("API Observer hostName is required");
  }

  let observerURL: URL;

  try {
    observerURL = new URL(config.observerAddr);
  } catch (error) {
    throw new TypeError(
      `invalid API Observer address: ${config.observerAddr}`,
      { cause: error },
    );
  }

  if (observerURL.protocol !== "http:" && observerURL.protocol !== "https:") {
    throw new TypeError("API Observer address must use HTTP or HTTPS");
  }

  if (
    config.maxResponseBodyBytes !== undefined &&
    (!Number.isSafeInteger(config.maxResponseBodyBytes) ||
      config.maxResponseBodyBytes < 0)
  ) {
    throw new TypeError("maxResponseBodyBytes must be a non-negative integer");
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
