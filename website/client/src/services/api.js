export async function api(path, body, options = {}) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "x-csrf-protection": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
    ...options,
  });
  const data = await response.json();
  if (!response.ok || !data.success)
    throw new Error(data.error || "Request failed");
  return data;
}
