
const MAX_BYTES = 100_000;
const TIMEOUT_MS = 10_000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export default async (request) => {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const input = new URL(request.url).searchParams.get("url");

    if (!input || input.length > 2048) {
      return json({ error: "Invalid URL" }, 400);
    }

    let target;

    try {
      target = new URL(input);
    } catch {
      return json({ error: "Invalid website address" }, 400);
    }

    const allowedHosts = new Set(
      (process.env.ALLOWED_HOSTS || "example.com,www.example.com")
        .split(",")
        .map(host => host.trim().toLowerCase())
        .filter(Boolean)
    );

    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port !== "" ||
      !allowedHosts.has(target.hostname.toLowerCase())
    ) {
      return json({ error: "This website is not approved" }, 403);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      TIMEOUT_MS
    );

    let upstream;

    try {
      upstream = await fetch(target.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "Accept": "text/html, text/plain"
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      return json({ error: "Redirects are not supported" }, 403);
    }

    if (!upstream.ok) {
      return json({ error: "Remote website returned an error" }, 502);
    }

    const type = upstream.headers.get("content-type") || "";

    if (
      !type.includes("text/html") &&
      !type.includes("text/plain")
    ) {
      return json({ error: "Unsupported content type" }, 415);
    }

    const declaredLength = Number(
      upstream.headers.get("content-length") || 0
    );

    if (declaredLength > MAX_BYTES) {
      return json({ error: "Page is too large" }, 413);
    }

    if (!upstream.body) {
      return json({ error: "Empty response" }, 502);
    }

    const reader = upstream.body.getReader();
    const chunks = [];
    let total = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        total += value.byteLength;

        if (total > MAX_BYTES) {
          await reader.cancel();
          return json({ error: "Page is too large" }, 413);
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const combined = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const text = new TextDecoder("utf-8", {
      fatal: false
    }).decode(combined);

    return json({
      url: target.href,
      content: text
    });

  } catch {
    return json({
      error: "Unable to retrieve the requested website"
    }, 500);
  }
};
