/**
 * Proxy module for forwarding requests to Invidious.
 *
 * Design:
 * - Pure functions for request/response transformation
 * - Injectable HTTP fetcher for testing
 * - Handles headers, body, and streaming responses
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Headers that should not be forwarded to the upstream server.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/**
 * Headers that should not be forwarded from the upstream response.
 */
const RESPONSE_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Proxy configuration.
 */
export interface ProxyConfig {
  /** Target URL to proxy to (e.g., "http://invidious:3000") */
  targetUrl: string;
  /** Optional timeout in milliseconds */
  timeout?: number;
}

/**
 * HTTP fetcher interface for dependency injection.
 */
export interface HttpFetcher {
  fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>;
}

/**
 * Default HTTP fetcher using global fetch.
 */
export const defaultHttpFetcher: HttpFetcher = {
  fetch: (input, init) => fetch(input, init),
};

/**
 * Proxy request options.
 */
export interface ProxyRequestOptions {
  /** Original request to proxy */
  request: Request;
  /** Path to forward (defaults to request URL path) */
  path?: string;
  /** Additional headers to add/override */
  additionalHeaders?: Record<string, string>;
  /** Signal for aborting the request */
  signal?: AbortSignal;
}

/**
 * Proxy result.
 */
export type ProxyResult =
  | { ok: true; response: Response }
  | { ok: false; error: ProxyError };

export interface ProxyError {
  type: "network_error" | "timeout" | "invalid_response";
  message: string;
  status?: number;
  cause?: unknown;
}

// ============================================================================
// Pure Functions
// ============================================================================

/**
 * Filter headers for forwarding to upstream.
 * Removes hop-by-hop headers and other problematic headers.
 */
export function filterRequestHeaders(headers: Headers): Headers {
  const filtered = new Headers();

  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerKey)) {
      filtered.set(key, value);
    }
  });

  return filtered;
}

/**
 * Rewrite Set-Cookie header to work on the proxy domain.
 * Removes Domain= attribute so cookies are set on the current domain.
 * Also removes Secure flag if present (in case proxy is HTTP).
 */
export function rewriteSetCookie(cookie: string): string {
  return cookie
    // Remove Domain=... attribute (with or without quotes)
    .replace(/;\s*Domain=[^;]*/gi, "")
    // Remove Secure flag in case proxy is served over HTTP
    .replace(/;\s*Secure/gi, "")
    // Ensure SameSite is Lax to allow normal navigation
    .replace(/;\s*SameSite=[^;]*/gi, "; SameSite=Lax");
}

/**
 * Filter headers for forwarding from upstream response.
 */
export function filterResponseHeaders(headers: Headers): Headers {
  const filtered = new Headers();

  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (!RESPONSE_HOP_BY_HOP_HEADERS.has(lowerKey)) {
      // Special handling for Set-Cookie to fix domain issues
      if (lowerKey === "set-cookie") {
        filtered.append(key, rewriteSetCookie(value));
      } else {
        filtered.set(key, value);
      }
    }
  });

  return filtered;
}

/**
 * Build the target URL for proxying.
 */
export function buildTargetUrl(targetBase: string, path: string, query: string): string {
  // Remove trailing slash from base
  const base = targetBase.replace(/\/+$/, "");
  // Ensure path starts with /
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  // Add query string if present
  const queryPart = query ? `?${query}` : "";

  return `${base}${normalizedPath}${queryPart}`;
}

/**
 * Extract path and query from a request URL.
 */
export function extractPathAndQuery(url: string): { path: string; query: string } {
  try {
    const parsed = new URL(url);
    return {
      path: parsed.pathname,
      query: parsed.search.slice(1), // Remove leading ?
    };
  } catch {
    // If URL parsing fails, try to extract manually
    const queryIndex = url.indexOf("?");
    if (queryIndex === -1) {
      return { path: url, query: "" };
    }
    return {
      path: url.slice(0, queryIndex),
      query: url.slice(queryIndex + 1),
    };
  }
}

// ============================================================================
// Proxy Factory
// ============================================================================

/**
 * Create a proxy handler with the given configuration.
 */
export function createProxy(config: ProxyConfig, fetcher: HttpFetcher = defaultHttpFetcher) {
  const { targetUrl, timeout = 30000 } = config;

  /**
   * Proxy a request to the target server.
   */
  async function proxyRequest(options: ProxyRequestOptions): Promise<ProxyResult> {
    const { request, additionalHeaders = {} } = options;

    // Extract path from request or use provided path
    const requestUrl = new URL(request.url);
    const path = options.path ?? requestUrl.pathname;
    const query = requestUrl.search.slice(1);

    // Build target URL
    const target = buildTargetUrl(targetUrl, path, query);

    // Build headers
    const headers = filterRequestHeaders(request.headers);

    // Add additional headers
    for (const [key, value] of Object.entries(additionalHeaders)) {
      headers.set(key, value);
    }

    // Set the host header to the target
    try {
      const targetParsed = new URL(target);
      headers.set("Host", targetParsed.host);
    } catch {
      // Ignore if URL parsing fails
    }

    // Create abort controller for timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    // Combine with external signal if provided
    const signal = options.signal
      ? createCombinedSignal(options.signal, abortController.signal)
      : abortController.signal;

    try {
      // Forward the request
      const response = await fetcher.fetch(target, {
        method: request.method,
        headers,
        body: request.body,
        signal,
        // Don't follow redirects - let the browser handle them
        // This fixes issues with POST requests that can't re-send streaming bodies
        redirect: "manual",
        // @ts-ignore - duplex is needed for streaming bodies
        duplex: "half",
      });

      clearTimeout(timeoutId);

      // Filter response headers
      const responseHeaders = filterResponseHeaders(response.headers);

      // Rewrite Location header for redirects to use relative paths
      // This ensures the browser redirects to the proxy, not the internal Invidious URL
      const location = responseHeaders.get("location");
      if (location) {
        try {
          const locationUrl = new URL(location, targetUrl);
          const targetParsed = new URL(targetUrl);
          // If the redirect is to our target server, rewrite to relative path
          if (locationUrl.host === targetParsed.host) {
            responseHeaders.set("location", locationUrl.pathname + locationUrl.search);
          }
        } catch {
          // If URL parsing fails, leave the header as-is
        }
      }

      // Create new response with filtered headers
      return {
        ok: true,
        response: new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        }),
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          return {
            ok: false,
            error: {
              type: "timeout",
              message: `Request timed out after ${timeout}ms`,
              cause: error,
            },
          };
        }

        return {
          ok: false,
          error: {
            type: "network_error",
            message: error.message,
            cause: error,
          },
        };
      }

      return {
        ok: false,
        error: {
          type: "network_error",
          message: "Unknown error occurred",
          cause: error,
        },
      };
    }
  }

  /**
   * Create a simple proxy response for Hono handlers.
   * Returns the Response directly or an error Response.
   */
  async function proxy(request: Request, options?: Partial<ProxyRequestOptions>): Promise<Response> {
    const result = await proxyRequest({
      request,
      ...options,
    });

    if (result.ok) {
      return result.response;
    }

    // Return error response
    const status = result.error.status ?? 502;
    return new Response(JSON.stringify({ error: result.error.message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return {
    proxyRequest,
    proxy,
    targetUrl,
  };
}

/**
 * Type for the proxy instance.
 */
export type Proxy = ReturnType<typeof createProxy>;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a combined abort signal from multiple signals.
 */
function createCombinedSignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }

  return controller.signal;
}
