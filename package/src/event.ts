export interface HTTPExchangeEvent {
  host: string;
  request?: RequestCopy;
  response?: ResponseCopy;
  failure?: FailureCopy;
}

export interface RequestCopy {
  method: string;
  url: string;
  header: HTTPHeaders;
  /**
   * Base64-encoded request body.
   *
   * This matches Go's JSON encoding behavior for []byte.
   */
  body: string;
}

export interface ResponseCopy {
  request: RequestCopy;
  status_code: number;
  headers: HTTPHeaders;
  /**
   * Base64-encoded response body.
   *
   * This matches Go's JSON encoding behavior for []byte.
   */
  body: string;
}

export interface FailureCopy {
  request: RequestCopy;
  error: string;
}

export interface ClientRegistration {
  host: string;
  openapi?: unknown;
  host_rules?: unknown;
}

export type HTTPHeaders = Record<string, string[]>;

export async function sendEvent(
  endpoint: URL | string,
  client: ClientRegistration,
  event: HTTPExchangeEvent,
): Promise<void> {
  const observerURL = parseObserverURL(endpoint);

  let response = await sendEventOnce(observerURL, event);

  if (response.status === 403) {
    await initializeClient(observerURL, client);

    response = await sendEventOnce(observerURL, event);

    if (!response.ok) {
      const responseBody = await readResponseBody(response);

      throw new Error(
        `observer server returned status ${response.status} ` +
          `after client initialization: ${responseBody}`,
      );
    }

    return;
  }

  if (!response.ok) {
    const responseBody = await readResponseBody(response);

    throw new Error(
      `observer server returned status ${response.status}: ` + responseBody,
    );
  }
}

async function sendEventOnce(
  endpoint: URL,
  event: HTTPExchangeEvent,
): Promise<Response> {
  const eventsURL = new URL("events", ensureTrailingSlash(endpoint));

  let response: Response;

  try {
    response = await fetch(eventsURL, {
      method: "POST",

      headers: {
        "content-type": "application/json",
        "user-agent": "node-observer-sdk",
      },

      body: JSON.stringify(event),
    });
  } catch (error) {
    throw new Error(`failed to send event to ${eventsURL.toString()}`, {
      cause: error,
    });
  }

  return response;
}

export async function initializeClient(
  endpoint: URL | string,
  client: ClientRegistration,
): Promise<void> {
  const observerURL = parseObserverURL(endpoint);

  const registrationURL = new URL(
    "register-client",
    ensureTrailingSlash(observerURL),
  );

  let response: Response;

  try {
    response = await fetch(registrationURL, {
      method: "POST",

      headers: {
        "content-type": "application/json",
        "user-agent": "node-observer-sdk",
      },

      body: JSON.stringify(client),
    });
  } catch (error) {
    throw new Error(
      `failed to initialize API Observer client at ` +
        registrationURL.toString(),
      {
        cause: error,
      },
    );
  }

  if (!response.ok) {
    const responseBody = await readResponseBody(response);

    throw new Error(
      `observer client initialization returned status ` +
        `${response.status}: ${responseBody}`,
    );
  }
}

function parseObserverURL(endpoint: URL | string): URL {
  if (endpoint instanceof URL) {
    return new URL(endpoint.toString());
  }

  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new TypeError("observer endpoint is required");
  }

  let parsedURL: URL;

  try {
    parsedURL = new URL(endpoint);
  } catch (error) {
    throw new TypeError(`invalid observer endpoint: ${endpoint}`, {
      cause: error,
    });
  }

  if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
    throw new TypeError("observer endpoint must use HTTP or HTTPS");
  }

  return parsedURL;
}

function ensureTrailingSlash(url: URL): URL {
  const normalizedURL = new URL(url.toString());

  normalizedURL.pathname = normalizedURL.pathname.replace(/\/+$/, "") + "/";

  return normalizedURL;
}

async function readResponseBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function encodeBody(body: Buffer | string | undefined | null): string {
  if (body === undefined || body === null) {
    return "";
  }

  if (Buffer.isBuffer(body)) {
    return body.toString("base64");
  }

  return Buffer.from(body, "utf8").toString("base64");
}

export function encodeJSONBody(body: unknown): string {
  if (body === undefined || body === null) {
    return "";
  }

  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}
