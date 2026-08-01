import type { HostRulesDocument, OpenAPIDocument } from "./audit";

export interface ClientRegistration {
  host: string;
  openapi?: OpenAPIDocument;
  rules?: HostRulesDocument;
}

export async function initializeClient(
  endpoint: URL | string,
  client: ClientRegistration,
): Promise<void> {
  validateClientRegistration(client);

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
      `failed to connect to API Observer at ${registrationURL.toString()}`,
      {
        cause: error,
      },
    );
  }

  const responseBody = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(
      `observer server returned status ${response.status}: ${responseBody}`,
    );
  }

  if (responseBody) {
    console.log(responseBody);
  }
}

function validateClientRegistration(client: ClientRegistration): void {
  if (typeof client.host !== "string" || client.host.trim() === "") {
    throw new Error(
      "missing client host name: provide a host name for the client",
    );
  }

  if (client.openapi === undefined && client.rules === undefined) {
    throw new Error(
      "missing client registration files: provide an OpenAPI file path, a RuleSet file path, or both",
    );
  }
}

function parseObserverURL(endpoint: URL | string): URL {
  if (endpoint instanceof URL) {
    return new URL(endpoint.toString());
  }

  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new TypeError("API Observer endpoint is required");
  }

  let parsedURL: URL;

  try {
    parsedURL = new URL(endpoint);
  } catch (error) {
    throw new TypeError(`invalid API Observer endpoint: ${endpoint}`, {
      cause: error,
    });
  }

  if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
    throw new TypeError("API Observer endpoint must use HTTP or HTTPS");
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
