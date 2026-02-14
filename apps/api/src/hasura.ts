import "./env.js";

const HASURA_ENDPOINT = "https://prod-eu.hasura.app/v1/graphql";

// ── in-memory token cache ──
let cachedToken: string | null = null;
let tokenExpiresAt = 0; // unix ms

function decodeExp(jwt: string): number {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  return (payload.exp as number) * 1000; // → ms
}

async function authenticate(): Promise<string> {
  const endpoint = process.env.AUTH_ENDPOINT;
  const email = process.env.EMAIL;
  const password = process.env.PASSWORD;
  if (!endpoint || !email || !password) {
    throw new Error("AUTH_ENDPOINT, EMAIL, or PASSWORD not set in .env");
  }

  console.log("[hasura] authenticating...");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth failed ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { accessToken: string };
  cachedToken = data.accessToken;
  tokenExpiresAt = decodeExp(cachedToken);
  console.log("[hasura] got token, expires", new Date(tokenExpiresAt).toISOString());
  return cachedToken;
}

async function getToken(): Promise<string> {
  // refresh 60s before expiry
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }
  return authenticate();
}

// ── GraphQL client ──

interface HasuraResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
}

export async function hasuraQuery<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = await getToken();

  const res = await fetch(HASURA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  // on 401, force re-auth and retry once
  if (res.status === 401) {
    console.log("[hasura] 401, re-authenticating...");
    const freshToken = await authenticate();
    const retry = await fetch(HASURA_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${freshToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!retry.ok) {
      const text = await retry.text();
      throw new Error(`Hasura ${retry.status}: ${text}`);
    }
    const json = (await retry.json()) as HasuraResponse<T>;
    if (json.errors?.length) {
      throw new Error(`Hasura: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    return json.data as T;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hasura ${res.status}: ${text}`);
  }

  const json = (await res.json()) as HasuraResponse<T>;

  if (json.errors?.length) {
    throw new Error(`Hasura: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  return json.data as T;
}
