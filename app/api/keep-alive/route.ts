import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { session_id } = await req.json();
    if (!session_id) {
      return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
    }

    const res = await fetch("https://api.heygen.com/v1/streaming.keep_alive", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.HEYGEN_API_KEY || "", // ⚠️ Asegúrate de tener esta env
      },
      body: JSON.stringify({ session_id }),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch (err: any) {
    console.error("KeepAlive error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
