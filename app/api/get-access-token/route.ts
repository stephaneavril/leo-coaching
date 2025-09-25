// app/api/get-access-token/route.ts
export async function POST() {
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  if (!HEYGEN_API_KEY) {
    return new Response("Missing API key", { status: 500 });
  }

  const res = await fetch("https://api.heygen.com/v1/streaming.create_token", {
    method: "POST",
    headers: {
      "x-api-key": HEYGEN_API_KEY,         // <- para create_token se usa x-api-key
    },
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("create_token error:", err);
    return new Response("Failed to create token", { status: 500 });
  }

  // la API devuelve { data: { token: "..." } }
  const data = await res.json();
  return new Response(data?.data?.token || "", { status: 200 });
}
