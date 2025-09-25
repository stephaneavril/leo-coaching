// app/api/start-session/route.ts
export async function POST() {
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;

  if (!HEYGEN_API_KEY) {
    return new Response("Missing API key", { status: 500 });
  }

  const res = await fetch("https://api.heygen.com/v1/streaming.start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HEYGEN_API_KEY}`,
    },
    body: JSON.stringify({
      avatar_name: "SilasHR_public", // o el nuevo nombre
      knowledge_base_id: "f46a58cb19184e9ab569f00547229c9b", // si usas uno
      activity_idle_timeout: 3600 // 🔥 esto evita que se congele
    }),
  });

  const data = await res.json();
  return new Response(JSON.stringify(data), { status: 200 });
}
