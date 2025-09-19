// app/dashboard/DashboardClient.tsx
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';

// ── tipos ─────────────────────────────────────
interface SessionRecord {
  id?: number;
  scenario: string;
  user_transcript: string;
  avatar_transcript: string;
  coach_advice: string;
  rh_evaluation?: string;
  video_s3: string | null;
  created_at: string;
  tip: string;
  visual_feedback: string;
  duration: number;
}
interface DashboardData {
  name: string;
  email: string;
  user_token: string;
  sessions: SessionRecord[];
  used_seconds: number;
}
const SENTINELS = ['Video_Not_Available_Error','Video_Processing_Failed','Video_Missing_Error'];

// ⬇⬇⬇ Asegúrate de que esté como **export default function** ⬇⬇⬇
export default function DashboardClient({
  initialData,
  error,
}: {
  initialData: DashboardData | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center">
        <style jsx global>{`
          html, body { margin: 0; padding: 0; background: #0c0e2c; color: #fff; font-family: 'Open Sans', sans-serif; }
        `}</style>
        <h2 className="text-2xl text-red-500 mb-2">Error al cargar datos</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!initialData) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <style jsx global>{`
          html, body { margin: 0; padding: 0; background: #0c0e2c; color: #fff; font-family: 'Open Sans', sans-serif; }
        `}</style>
        Cargando…
      </div>
    );
  }

  // ── estado + polling para refrescar barra ────────────────────
  const [data, setData] = useState<DashboardData>(initialData);
  const bearer = data?.user_token || initialData.user_token;
  const FLASK = process.env.NEXT_PUBLIC_FLASK_API_URL || '';

  useEffect(() => {
    if (!bearer || !FLASK) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`${FLASK}/dashboard_data`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${bearer}` },
          credentials: 'include',
        });
        if (res.ok) {
          const fresh: DashboardData = await res.json();
          setData(fresh);
        }
      } catch {
        /* silencioso */
      }
    }, 10000);
    return () => clearInterval(id);
  }, [bearer, FLASK]);

  const current = data || initialData;
  const { name: userName, email, user_token, sessions = [], used_seconds: usedSeconds = 0 } = current;

  const records: SessionRecord[] = sessions.map((s) => ({
    ...s,
    video_s3: s.video_s3 && !SENTINELS.includes(s.video_s3) ? s.video_s3 : null,
    created_at: s.created_at ? new Date(s.created_at).toLocaleString() : '',
  }));

  const visibleRecords = records.filter((r) => r.coach_advice || r.rh_evaluation);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  };

  const maxSeconds = 1800; // 30 min
  const defaultScenario = 'Coaching con LEO (GROW)';

  return (
    <>
      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700&family=Open+Sans:wght@400;600&display=swap');
        :root {
          --primary-dark: #0c0e2c; --primary-mid: #003559; --primary-light: #00bfff;
          --text-dark: #222; --bg-gray: #f4f6fa; --bg-white: #ffffff; --shadow-lg: rgba(0,0,0,0.12);
          --warning: #fff8e1; --warning-border: #ffca28;
        }
        html, body, .dashboard-page-container { background: var(--bg-gray) !important; color: var(--text-dark) !important; margin:0; padding:0; font-family:'Open Sans',sans-serif; }
        header { display:flex; flex-direction:column; gap:6px; padding:18px 28px; background:linear-gradient(90deg,var(--primary-dark),var(--primary-mid) 55%,var(--primary-light)); color:#fff; box-shadow:0 2px 6px rgba(0,0,0,.45); }
        header h1 { margin:0; font-family:'Montserrat',sans-serif; font-weight:700; font-size:26px; letter-spacing:.2px; }
        header p { margin:0; opacity:.9; }
        .container-content { max-width:1100px; margin:0 auto; padding:32px 22px 40px; }
        .section-title { font:700 22px 'Montserrat',sans-serif; margin:28px 0 16px; color:var(--primary-dark); display:inline-block; border-bottom:3px solid var(--primary-light); padding-bottom:6px; }
        .voice-alert { background:var(--warning); border:2px solid var(--warning-border); color:#5b4400; border-radius:12px; padding:14px 16px; box-shadow:0 6px 14px rgba(0,0,0,.06); margin:8px 0 22px; }
        .card-grid { display:flex; flex-wrap:wrap; gap:16px; }
        .card { background:var(--bg-white); border-radius:14px; padding:18px; width:260px; box-shadow:0 8px 22px var(--shadow-lg); transition:transform .18s ease; border:1px solid #eef2f7; }
        .card:hover { transform: translateY(-3px); }
        .card h3 { margin:4px 0 12px; font-family:'Montserrat'; color:var(--primary-dark); }
        .card p { margin:0 0 12px; font-size:.93rem; opacity:.9; }
        .card button { padding:10px 16px; border:none; border-radius:8px; background:var(--primary-light); color:#000; font-weight:700; cursor:pointer; transition:background .15s ease, transform .1s ease; width:100%; }
        .card button:hover { background:#00a4e6; transform: translateY(-1px); }
        .progress-bar { background:#e9eef4; border-radius:10px; overflow:hidden; height:18px; border:1px solid #dbe4ee; margin:10px 0 6px; }
        .progress-fill { height:100%; background:linear-gradient(to right,#00bfff,#007bff); display:flex; align-items:center; justify-content:flex-end; padding-right:8px; color:#fff; font-weight:700; font-size:12px; transition:width .35s ease-out; }
        .muted { color:#566; font-size:.92rem; }
        .session-entry { background:var(--bg-white); border-radius:16px; box-shadow:0 10px 28px var(--shadow-lg); padding:20px; margin-bottom:24px; border:1px solid #eef2f7; }
        .session-entry h3 { margin:0 0 6px; font:700 18px 'Montserrat',sans-serif; color:var(--primary-dark); }
        .evaluation-box { margin-top:14px; padding:14px; border-radius:12px; background:#eaf7fb; border-left:6px solid #00a4e6; }
        .evaluation-box.rh-box { background:#fff1f1; border-left-color:#cc0000; }
        .evaluation-box.tip-box { background:#f7fbff; border-left-color:#00bfff; }
        .howto-box { background:var(--bg-white); border:1px solid #eef2f7; border-radius:14px; box-shadow:0 6px 18px var(--shadow-lg); padding:16px 18px; margin:10px 0 22px; }
        .howto-box h3 { margin:0 0 10px; font:700 18px 'Montserrat',sans-serif; color:var(--primary-dark); }
        .howto-box ol { margin:8px 0 0; padding-left:20px; line-height:1.6; }
        .howto-box li { margin:6px 0; }
      `}</style>

      <div className="dashboard-page-container">
        <header>
          <h1>¡Bienvenido/a, {userName}!</h1>
          <p>Centro de coaching con LEO (GROW)</p>
        </header>

        <div className="container-content">
          {/* AVISO */}
          <div className="voice-alert" role="alert" aria-live="polite">
            <strong>⚠️ Para que la voz funcione bien:</strong>
            <ul>
              <li>Permite <strong>micrófono y cámara</strong> cuando el navegador lo pida.</li>
              <li>Haz clic en INICIAR → <strong>“Iniciar Chat de Voz”</strong> → luego TEXT CHAT → luego VOICE CHAT.</li>
              <li>Preferible usar <strong>audífonos</strong> para evitar eco.</li>
            </ul>
          </div>

          <h2 className="section-title">Selecciona tu entrenamiento</h2>

          <section className="howto-box">
            <h3>Cómo practicar GROW en 7 pasos</h3>
            <ol>
              <li>Elige “Coaching con LEO (GROW)”.</li>
              <li>Activa cámara y micrófono.</li>
              <li>Saluda y define tu <strong>Goal</strong>.</li>
              <li>Explora la <strong>Reality</strong> con 3 preguntas abiertas.</li>
              <li>Co-creen <strong>Options</strong> (2 alternativas concretas).</li>
              <li>Cierren con <strong>Will</strong>: 2 acciones con fecha y seguimiento.</li>
              <li>Dispones de 15 min por sesión y 30 min al mes.</li>
            </ol>
          </section>

          {/* Card de inicio */}
          <div className="card-grid">
            <div className="card">
              <h3>Coaching con LEO (GROW)</h3>
              <p>Practica metas, realidad, opciones y compromisos.</p>
              <Link
                href={{
                  pathname: '/interactive-session',
                  query: { name: userName, email, scenario: 'Coaching con LEO (GROW)', token: user_token },
                }}
                passHref
              >
                <button>Iniciar</button>
              </Link>
            </div>
          </div>

          {/* Consumo mensual */}
          <div style={{ marginTop: 22 }}>
            <strong>⏱ Tiempo mensual usado</strong>
            <div className="progress-bar" aria-label="Consumo mensual">
              <div
                className="progress-fill"
                style={{ width: `${Math.min(100, (usedSeconds / maxSeconds) * 100)}%` }}
              />
            </div>
            <div className="muted">
              {formatTime(usedSeconds)} / {formatTime(maxSeconds)}
            </div>
          </div>

          {/* Historial */}
          <h2 className="section-title">Tus sesiones anteriores</h2>
          {visibleRecords.length === 0 ? (
            <p className="muted">Aún no tienes retroalimentación disponible.</p>
          ) : (
            visibleRecords.map((r) => (
              <div key={r.id ?? r.created_at} className="session-entry">
                <h3>{r.scenario}</h3>
                <div className="muted">Fecha: {r.created_at}</div>
                <div className="muted">Duración: {Math.max(1, Math.round((r.duration || 0) / 60))} min</div>

                {r.coach_advice && (
                  <div className="evaluation-box">
                    <p style={{ marginTop: 0, marginBottom: 8 }}><strong>Resumen de tu sesión</strong></p>
                    <p style={{ marginBottom: 0 }}>{r.coach_advice}</p>
                  </div>
                )}
                {r.rh_evaluation && (
                  <div className="evaluation-box rh-box">
                    <p style={{ marginTop: 0, marginBottom: 8 }}><strong>Mensaje de Capacitación</strong></p>
                    <p style={{ marginBottom: 0 }}>{r.rh_evaluation}</p>
                  </div>
                )}
                {r.tip && (
                  <div className="evaluation-box tip-box">
                    <p style={{ marginTop: 0 }}><strong>Idea para tu próxima práctica</strong></p>
                    <p style={{ marginBottom: 0 }}>{r.tip}</p>
                  </div>
                )}
                <div style={{ marginTop: 12 }}>
                  {r.video_s3 ? (
                    <video controls src={r.video_s3} style={{ width: '100%', borderRadius: 12 }} />
                  ) : (
                    <p className="muted">Video no disponible o en procesamiento.</p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
