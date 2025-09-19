'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import Link from 'next/link';

// 🔹 Ajusta si tu API devuelve otros nombres de campos
interface SessionRecord {
  scenario: string;
  message: string;              // Mensaje del usuario
  evaluation: string;           // Resumen público de IA
  tip?: string;                 // Consejo personalizado
  visual_feedback?: string;     // Feedback visual
  comments_public?: string[];   // Comentarios o bullets
  video_s3: string | null;      // URL de video (S3) o null
  created_at: string;           // Fecha/hora ya normalizada desde backend
}

interface DashboardData {
  name: string;
  email: string;
  user_token: string;
  sessions: SessionRecord[];
  used_seconds: number;
}

const VIDEO_SENTINELS = new Set([
  'Video_Not_Available_Error',
  'Video_Processing_Failed',
  'Video_Missing_Error',
]);

export type Props = {
  initialData: DashboardData | null;
  error: string | null;
};

export default function DashboardClient({ initialData, error }: Props) {
  const router = useRouter();

  const [name, setName] = useState<string | null>(initialData?.name ?? null);
  const [email, setEmail] = useState<string | null>(initialData?.email ?? null);
  const [token, setToken] = useState<string | null>(initialData?.user_token ?? null);
  const [records, setRecords] = useState<SessionRecord[]>(initialData?.sessions ?? []);
  const [usedSeconds, setUsedSeconds] = useState<number>(initialData?.used_seconds ?? 0);

  const maxSeconds = 60 * 30; // 30 minutos

  // Normaliza sesiones (filtra sentinelas de video, asegura arrays, etc.)
  const normalizedRecords = useMemo<SessionRecord[]>(() => {
    return (records || []).map((s) => ({
      ...s,
      video_s3: s.video_s3 && !VIDEO_SENTINELS.has(s.video_s3) ? s.video_s3 : null,
      comments_public: Array.isArray(s.comments_public) ? s.comments_public : [],
    }));
  }, [records]);

  useEffect(() => {
    if (error) {
      console.error('Error fetching dashboard data:', error);
      alert(`Error al cargar el dashboard: ${error}`);
      router.push('/');
      return;
    }

    if (initialData) {
      setName(initialData.name ?? null);
      setEmail(initialData.email ?? null);
      setToken(initialData.user_token ?? null);
      setRecords(initialData.sessions ?? []);
      setUsedSeconds(initialData.used_seconds ?? 0);

      // (Opcional) Persistir en cookies para otros flujos
      Cookies.set('user_name', initialData.name ?? '', { sameSite: 'Lax' });
      Cookies.set('user_email', initialData.email ?? '', { sameSite: 'Lax' });
      Cookies.set('user_token', initialData.user_token ?? '', { sameSite: 'Lax' });
      return;
    }

    // Fallback: intenta desde cookies si no vino initialData
    const userName = Cookies.get('user_name') || null;
    const userEmail = Cookies.get('user_email') || null;
    const userToken = Cookies.get('user_token') || null;

    if (!userName || !userEmail || !userToken) {
      router.push('/');
    } else {
      setName(userName);
      setEmail(userEmail);
      setToken(userToken);
    }
  }, [initialData, error, router]);

  const formatTime = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  if (!name) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-900 text-white">
        Cargando...
      </div>
    );
  }

  const usagePct = Math.min(100, Math.max(0, (usedSeconds / maxSeconds) * 100));
  const usageColor =
    usedSeconds >= maxSeconds * 0.9 ? '#ff4d4d' : usedSeconds >= maxSeconds * 0.7 ? 'orange' : '#00bfff';

  return (
    <div className="min-h-screen bg-zinc-900 text-white flex flex-col items-center">
      <header className="w-full bg-zinc-950 p-6 shadow-md">
        <h1 className="text-3xl font-bold text-blue-400 text-center md:text-left md:ml-10">
          ¡Bienvenido/a, {name}!
        </h1>
        <p className="text-zinc-400 text-center md:text-left md:ml-10">
          Centro de entrenamiento virtual con Leo
        </p>
      </header>

      <main className="container max-w-4xl mx-auto p-6 flex flex-col gap-8 w-full">
        <section className="flex flex-col md:flex-row items-start gap-5 p-4 bg-zinc-800 rounded-lg shadow-md">
          <div className="flex-1 text-zinc-300">
            <h3 className="text-xl font-semibold text-blue-400 mb-3">
              📘 Instrucciones clave para tu sesión:
            </h3>
            <ul className="text-left list-disc list-inside space-y-2">
              <li>
                🖱️ Al hacer clic en <strong>"Iniciar"</strong>, serás conectado con el doctor virtual Leo.
              </li>
              <li>⏱️ El cronómetro comienza automáticamente (8 minutos por sesión).</li>
              <li>
                🎥 Autoriza el acceso a tu <strong>cámara</strong> y <strong>micrófono</strong> cuando se te pida.
              </li>
              <li>
                👨‍⚕️ Una vez conectado, haz clic en el micrófono en la ventana del avatar y comienza la conversación
                médica.
              </li>
              <li>🗣️ Habla con claridad y presenta tu producto de forma profesional.</li>
              <li>🤫 Cuando termines de hablar, espera la respuesta del Dr. Leo.</li>
              <li>🎤 Para volver a hablar, vuelve a activar el micrófono en la ventana del doctor.</li>
              <li>
                🎯 Sigue el modelo de ventas <strong>Da Vinci</strong>: saludo, necesidad, propuesta, cierre.
              </li>
            </ul>
            <p className="mt-4 text-sm">Tu sesión será evaluada automáticamente por IA. ¡Aprovecha cada minuto!</p>
          </div>
          <video
            controls
            autoPlay
            muted
            loop
            className="w-full md:w-80 rounded-lg shadow-lg border border-blue-500"
          >
            <source src="/video_intro.mp4" type="video/mp4" />
            Tu navegador no soporta la reproducción de video.
          </video>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="bg-zinc-800 rounded-lg p-6 shadow-md text-center">
            <h3 className="text-xl font-semibold text-blue-300 mb-3">Entrevista con Médico</h3>
            {email && token ? (
              <Link
                href={{
                  pathname: '/interactive-session',
                  query: {
                    name: name!,
                    email: email!,
                    scenario: 'coaching con gerente',
                    token: token!,
                  },
                }}
                className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition duration-200"
              >
                Iniciar
              </Link>
            ) : (
              <span className="text-zinc-400 text-sm">Requiere autenticación</span>
            )}
          </div>
        </section>

        <section className="bg-zinc-800 p-4 rounded-lg shadow-md border-l-4 border-blue-600">
          <strong className="text-blue-300 text-lg">⏱ Tiempo mensual utilizado:</strong>
          <div className="h-6 bg-zinc-700 rounded-full overflow-hidden mt-3 max-w-md mx-auto">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${usagePct}%`, background: usageColor }}
            />
          </div>
          <p className="mt-2 text-sm text-zinc-300 text-center">
            Usado: {formatTime(usedSeconds)} de {formatTime(maxSeconds)} minutos.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-bold text-blue-400 border-b-2 border-blue-600 pb-3 mb-5">
            Tus sesiones anteriores
          </h2>

          {normalizedRecords.length > 0 ? (
            normalizedRecords.map((r, idx) => (
              <article key={idx} className="bg-zinc-800 p-5 rounded-lg shadow-md mb-4">
                <p className="text-lg font-semibold text-blue-300">Escenario: {r.scenario}</p>
                <p className="text-zinc-400 text-sm">Fecha: {r.created_at}</p>

                <p className="mt-3 text-zinc-300">
                  <strong>Resumen IA:</strong>
                </p>
                <div className="mt-1 mb-3 p-3 bg-zinc-700 rounded text-zinc-200 text-sm">
                  <em>{r.evaluation}</em>
                </div>

                {r.tip && (
                  <div className="mt-3 p-3 bg-blue-900/30 border-l-4 border-blue-500 rounded text-zinc-200 text-sm">
                    <strong>🧠 Consejo personalizado de Leo:</strong>
                    <p className="mt-1">{r.tip}</p>
                  </div>
                )}

                {r.visual_feedback && (
                  <div className="mt-3 p-3 bg-blue-900/30 border-l-4 border-blue-500 rounded text-zinc-200 text-sm">
                    <strong>👁️ Retroalimentación Visual:</strong>
                    <p className="mt-1">{r.visual_feedback}</p>
                  </div>
                )}

                {r.comments_public && r.comments_public.length > 0 && (
                  <div className="mt-3 p-3 bg-zinc-700 rounded text-zinc-200 text-sm">
                    <strong>📋 Puntos clave:</strong>
                    <ul className="list-disc list-inside mt-2 space-y-1">
                      {r.comments_public.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {r.video_s3 && (
                  <div className="mt-4">
                    <video
                      controls
                      className="w-full md:max-w-xl mx-auto rounded-lg shadow-md border border-zinc-600"
                    >
                      <source src={r.video_s3} type="video/mp4" />
                      Tu navegador no soporta la reproducción de video.
                    </video>
                  </div>
                )}
              </article>
            ))
          ) : (
            <p className="text-zinc-400 text-center">
              No has realizado sesiones todavía. ¡Comienza una con Leo!
            </p>
          )}
        </section>
      </main>

      <footer className="mt-10 mb-5 text-sm text-zinc-500 text-center">
        <p>
          Desarrollado por{' '}
          <a
            href="https://www.teams.com.mx"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline"
          >
            Teams
          </a>{' '}
          &copy; 2025
        </p>
      </footer>
    </div>
  );
}
