// app/api/keep-alive/route.ts
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { session_id } = await req.json();
    if (!session_id) {
      return NextResponse.json({ error: 'session_id requerido' }, { status: 400 });
    }

    const apiKey = process.env.HEYGEN_API_KEY;
    const base   = process.env.NEXT_PUBLIC_HEYGEN_BASE_URL || 'https://api.heygen.com';
    if (!apiKey) {
      return NextResponse.json({ error: 'Falta HEYGEN_API_KEY' }, { status: 500 });
    }

    const r = await fetch(`${base}/v1/streaming.keep_alive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,          // <- usa tu API key
        'Accept': 'application/json',
      },
      body: JSON.stringify({ session_id }),
      cache: 'no-store',
    });

    if (!r.ok) {
      const text = await r.text();
      return NextResponse.json({ error: text || `HeyGen keep_alive ${r.status}` }, { status: r.status });
    }

    const j = await r.json();
    return NextResponse.json(j, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Error interno' }, { status: 500 });
  }
}
