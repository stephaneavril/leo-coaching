/* eslint-disable prettier/prettier */
/* eslint-disable react/jsx-sort-props */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUnmount } from 'ahooks';
import { useRouter, useSearchParams } from 'next/navigation';

import {
  AvatarQuality,
  ElevenLabsModel,
  STTProvider,
  StartAvatarRequest,
  StreamingEvents,
  VoiceChatTransport,
  VoiceEmotion,
} from '@heygen/streaming-avatar';

import {
  MessageSender,
  StreamingAvatarProvider,
  StreamingAvatarSessionState,
  useStreamingAvatarSession,
  useVoiceChat,
} from '@/components/logic';

import { AvatarConfig } from '@/components/AvatarConfig';
import { AvatarControls } from '@/components/AvatarSession/AvatarControls';
import { AvatarVideo } from '@/components/AvatarSession/AvatarVideo';
import { MessageHistory } from '@/components/AvatarSession/MessageHistory';
import { Button } from '@/components/Button';
import { LoadingIcon } from '@/components/Icons';
import { LoaderCircle } from 'lucide-react';

// ───────────────────────────────────────────────────────────────
// Config de HeyGen
// ───────────────────────────────────────────────────────────────
const DEFAULT_CONFIG: StartAvatarRequest = {
  avatarName: 'Graham_Chair_Sitting_public',
  knowledgeId: 'bca7f7c812cf49caabe462699a579b44',
  language: 'es',
  quality: AvatarQuality.Low,
  sttSettings: { provider: STTProvider.DEEPGRAM },
  voice: {
    emotion: VoiceEmotion.FRIENDLY,
    model: ElevenLabsModel.eleven_multilingual_v2,
    rate: 1.15,
    voiceId: '92c8bd8d48f5467ab8a65f5db5d769f6',
  },
  voiceChatTransport: VoiceChatTransport.WEBSOCKET,
};

function InteractiveSessionContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const {
    handleStreamingTalkingMessage,
    handleUserTalkingMessage,
    initAvatar,
    messages,
    sessionState,
    startAvatar,
    stopAvatar,
    stream,
  } = useStreamingAvatarSession();

  const { startVoiceChat } = useVoiceChat();

  // ── Local UI State ────────────────────────────────────────────
  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);
  const [sessionInfo, setSessionInfo] = useState<{
    name: string;
    email: string;
    scenario: string;
    token: string;
  } | null>(null);
  const [isAttemptingAutoStart, setIsAttemptingAutoStart] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [showAutoplayBlockedMessage, setShowAutoplayBlockedMessage] = useState(false);
  const [hasUserMediaPermission, setHasUserMediaPermission] = useState(false);

  // ── Refs ─────────────────────────────────────────────────────
  const avatarVideoRef = useRef<HTMLVideoElement>(null);
  const connectedOnceRef = useRef(false);
  const isFinalizingRef = useRef(false);
  const localUserStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const messagesRef = useRef<any[]>([]);
  const recordingTimerRef = useRef<number>(900); // countdown de 15 min
  const recordedChunks = useRef<Blob[]>([]);
  const startedAtRef = useRef<number | null>(null); // ms desde 1ª conexión real
  const [timerDisplay, setTimerDisplay] = useState('15:00');
  const userCameraRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // ── Parse URL params & JWT ───────────────────────────────────
  useEffect(() => {
    const name = searchParams.get('name') || '';
    const email = searchParams.get('email') || '';
    const scenario = searchParams.get('scenario') || '';
    const urlToken = searchParams.get('token') || '';
    const cookieToken = (() => {
      if (typeof document !== 'undefined') {
        const m = document.cookie.match(/(?:^|; )jwt=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
      }
      return '';
    })();
    const token = urlToken || cookieToken;

    if (name && email && scenario && token) {
      setSessionInfo({ name, email, scenario, token });
      setIsReady(true);
    } else {
      console.error('Faltan parámetros en la URL');
    }
  }, [searchParams]);

  // ── Camera helpers ───────────────────────────────────────────
  const stopUserCameraRecording = useCallback(() => {
    if (localUserStreamRef.current) {
      localUserStreamRef.current.getTracks().forEach((t) => t.stop());
      localUserStreamRef.current = null;
    }
    if (userCameraRef.current) {
      userCameraRef.current.srcObject = null;
    }
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const startUserCameraRecording = useCallback(() => {
    if (!localUserStreamRef.current || mediaRecorderRef.current?.state === 'recording') return;
    try {
      const recorder = new MediaRecorder(localUserStreamRef.current, {
        audioBitsPerSecond: 128_000,
        mimeType: 'video/webm; codecs=vp8',
        videoBitsPerSecond: 2_500_000,
      });
      recordedChunks.current = [];
      recorder.ondataavailable = (e) => e.data.size && recordedChunks.current.push(e.data);
      recorder.start();
      mediaRecorderRef.current = recorder;
    } catch (err) {
      console.error('Error al iniciar MediaRecorder:', err);
    }
  }, []);

  // ── Finalize & Upload ────────────────────────────────────────
  const stopAndFinalizeSession = useCallback(
    async (sessionMessages: any[]) => {
      if (isFinalizingRef.current || !sessionInfo) return;
      isFinalizingRef.current = true;
      setIsUploading(true);

      stopAvatar();
      setIsVoiceActive(false);

      const finalize = async () => {
        stopUserCameraRecording();

        const { email, name, scenario, token } = sessionInfo;

        const userTranscript = sessionMessages
          .filter((m) => m.sender === MessageSender.CLIENT)
          .map((m) => m.content)
          .join('\n');

        const avatarTranscript = sessionMessages
          .filter((m) => m.sender === MessageSender.AVATAR)
          .map((m) => m.content)
          .join('\n');

        // DURACIÓN ROBUSTA: timestamps + fallback al countdown
        let duration = 0;
        if (startedAtRef.current) {
          duration = Math.floor((Date.now() - startedAtRef.current) / 1000);
        } else {
          duration = Math.max(0, 900 - recordingTimerRef.current);
        }
        duration = Math.max(0, Math.min(900, duration)); // blinda 0–900

        const flaskApiUrl = process.env.NEXT_PUBLIC_FLASK_API_URL || '';

        try {
          let videoS3Key: string | null = null;

          if (recordedChunks.current.length) {
            const videoBlob = new Blob(recordedChunks.current, { type: 'video/webm' });
            if (videoBlob.size) {
              const form = new FormData();
              form.append('video', videoBlob, 'user_recording.webm');

              const uploadRes = await fetch(`${flaskApiUrl}/upload_video`, {
                body: form,
                headers: { Authorization: `Bearer ${token}` },
                method: 'POST',
              });

              const uploadJson = await uploadRes.json().catch(() => ({}));
              if (!uploadRes.ok) throw new Error(uploadJson.message || 'Error al subir video');
              videoS3Key = uploadJson.s3_object_key;
            }
          }

          const res = await fetch(`${flaskApiUrl}/log_full_session`, {
            body: JSON.stringify({
              avatar_transcript: avatarTranscript,
              conversation: userTranscript,
              duration,
              email,
              name,
              scenario,
              s3_object_key: videoS3Key,
            }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
          });

          const json = await res.json().catch(() => ({}));
          if (!res.ok || json.status === 'error') {
            throw new Error(json.message || `Error HTTP ${res.status}`);
          }
        } catch (err: any) {
          console.error('❌ Error finalizando sesión:', err);
          alert(`⚠️ ${err.message || 'Ocurrió un problema guardando tu sesión.'}`);
          setIsUploading(false);
        } finally {
          router.push('/dashboard');
        }
      };

      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.onstop = finalize;
        mediaRecorderRef.current.stop();
      } else {
        finalize();
      }
    },
    [router, sessionInfo, stopAvatar, stopUserCameraRecording]
  );

  // ── Access token helper ─────────────────────────────────────
  const fetchAccessToken = useCallback(async () => {
    const res = await fetch('/api/get-access-token', { method: 'POST' });
    if (!res.ok) throw new Error(`Fallo al obtener token de acceso: ${res.status}`);
    return res.text();
  }, []);

  // ── Start session with HeyGen ────────────────────────────────
  const startHeyGenSession = useCallback(
    async (withVoice: boolean) => {
      if (!hasUserMediaPermission) {
        alert('Por favor, permite el acceso a la cámara y el micrófono.');
        return;
      }
      setIsAttemptingAutoStart(true);
      try {
        const heygenToken = await fetchAccessToken();
        const avatar = initAvatar(heygenToken);

        avatar.on(StreamingEvents.USER_TALKING_MESSAGE, (e) => {
          handleUserTalkingMessage({ detail: e.detail });
        });

        avatar.on(StreamingEvents.AVATAR_TALKING_MESSAGE, (e) => {
          handleStreamingTalkingMessage({ detail: e.detail });
        });

        avatar.on(StreamingEvents.STREAM_DISCONNECTED, () => {
          if (!isFinalizingRef.current) stopAndFinalizeSession(messagesRef.current);
          setIsVoiceActive(false);
        });

        avatar.on(StreamingEvents.STREAM_READY, async () => {
          setIsAttemptingAutoStart(false);
          try {
            await (avatar as any)?.speakText?.('Hola, ya te escucho. Cuando quieras, empezamos.');
          } catch {}
          if (withVoice) {
            try {
              await startVoiceChat();
              setIsVoiceActive(true);
            } catch (e) {
              console.error('startVoiceChat falló:', e);
            }
          }
        });

        await startAvatar(config);
      } catch (err: any) {
        console.error('Error iniciando sesión con HeyGen:', err);
        setShowAutoplayBlockedMessage(true);
      } finally {
        setIsAttemptingAutoStart(false);
      }
    },
    [
      config,
      fetchAccessToken,
      handleStreamingTalkingMessage,
      handleUserTalkingMessage,
      hasUserMediaPermission,
      initAvatar,
      startAvatar,
      startVoiceChat,
      stopAndFinalizeSession,
    ]
  );

  // ── “Encender voz” si ya hay stream activo ───────────────────
  const handleVoiceChatClick = useCallback(async () => {
    if (!hasUserMediaPermission) {
      alert('Por favor, permite el acceso a la cámara y el micrófono.');
      return;
    }
    if (sessionState === StreamingAvatarSessionState.CONNECTED) {
      try {
        await startVoiceChat();
        setIsVoiceActive(true);
      } catch (e) {
        console.error('startVoiceChat falló:', e);
      }
    } else {
      startHeyGenSession(true);
    }
  }, [hasUserMediaPermission, sessionState, startVoiceChat, startHeyGenSession]);

  // ── Get user media on mount ─────────────────────────────────
  useEffect(() => {
    const getUserMediaStream = async () => {
      try {
        const streamLocal = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { frameRate: 15, height: 480, width: 640 },
        });
        localUserStreamRef.current = streamLocal;
        if (userCameraRef.current) userCameraRef.current.srcObject = streamLocal;
        setHasUserMediaPermission(true);
      } catch (err) {
        console.error('❌ Error al obtener permisos:', err);
        setShowAutoplayBlockedMessage(true);
      }
    };
    if (isReady) getUserMediaStream();
  }, [isReady]);

  // ── Start recording + MARCA DE INICIO en 1ª conexión ────────
  useEffect(() => {
    if (sessionState === StreamingAvatarSessionState.CONNECTED && hasUserMediaPermission) {
      if (!connectedOnceRef.current) {
        connectedOnceRef.current = true;
        startedAtRef.current = Date.now(); // *** MARCA DE INICIO REAL ***
        recordingTimerRef.current = 900; // (opcional) re-sincroniza countdown
      }
      if (!mediaRecorderRef.current) {
        startUserCameraRecording();
      }
    }
  }, [hasUserMediaPermission, sessionState, startUserCameraRecording]);

  // ── Bind remote stream to video tag ─────────────────────────
  useEffect(() => {
    if (stream && avatarVideoRef.current) {
      avatarVideoRef.current.srcObject = stream;
      avatarVideoRef.current.onloadedmetadata = () => {
        avatarVideoRef.current!.play().catch(() => {
          setShowAutoplayBlockedMessage(true);
        });
      };
    }
  }, [stream]);

  // ── Timer countdown (visual) ────────────────────────────────
  useEffect(() => {
    let id: NodeJS.Timeout | undefined;
    if (sessionState === StreamingAvatarSessionState.CONNECTED) {
      id = setInterval(() => {
        recordingTimerRef.current -= 1;
        const m = Math.floor(recordingTimerRef.current / 60)
          .toString()
          .padStart(2, '0');
        const s = (recordingTimerRef.current % 60).toString().padStart(2, '0');
        setTimerDisplay(`${m}:${s}`);
        if (recordingTimerRef.current <= 0) {
          clearInterval(id);
          stopAndFinalizeSession(messagesRef.current);
        }
      }, 1000);
    }
    return () => clearInterval(id);
  }, [sessionState, stopAndFinalizeSession]);

  // ── Clean up on unmount ─────────────────────────────────────
  useUnmount(() => {
    if (!isFinalizingRef.current) stopAndFinalizeSession(messagesRef.current);
  });

  const handleAutoplayRetry = () => {
    if (hasUserMediaPermission) {
      setShowAutoplayBlockedMessage(false);
      startHeyGenSession(true);
    } else {
      alert('Por favor, permite el acceso a la cámara y el micrófono primero.');
    }
  };

  // ── Loading guard ------------------------------------------------
  if (!isReady) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-zinc-900 text-white">
        <LoadingIcon className="h-10 w-10 animate-spin" />
        <p className="mt-4">Verificando datos de sesión...</p>
      </div>
    );
  }

  // ── Main UI -----------------------------------------------------
  return (
    <div className="relative flex h-screen w-screen flex-col items-center bg-zinc-900 text-white">
      <h1 className="mt-6 mb-4 text-3xl font-bold text-blue-400" suppressHydrationWarning>
        {`🧠 Leo – ${sessionInfo?.scenario || ''}`}
      </h1>

      {sessionState === StreamingAvatarSessionState.INACTIVE &&
        !hasUserMediaPermission &&
        !showAutoplayBlockedMessage && <p className="mb-6 text-zinc-300">Solicitando permisos...</p>}

      {showAutoplayBlockedMessage && (
        <div className="mb-6 text-center text-red-400">
          Permisos de cámara/micrófono denegados o no disponibles.
        </div>
      )}

      {/* Video area */}
      <div className="relative flex w-full max-w-4xl flex-col items-center justify-center gap-5 p-4 md:flex-row">
        {/* Avatar video */}
        <div className="relative flex min-h-[300px] w-full items-center justify-center overflow-hidden rounded-lg bg-zinc-800 shadow-lg md:w-1/2">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <AvatarVideo ref={avatarVideoRef} />
          ) : (
            !showAutoplayBlockedMessage && <AvatarConfig onConfigChange={setConfig} config={config} />
          )}

          {showAutoplayBlockedMessage && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/75 p-4 text-center">
              <p className="mb-4 text-lg font-semibold">Video y Audio Bloqueados</p>
              <p className="mb-6">
                Haz clic para reintentar. Permite la cámara y el micrófono en el navegador.
              </p>
              <Button className="bg-blue-600 text-white hover:bg-blue-700" onClick={handleAutoplayRetry}>
                Habilitar
              </Button>
            </div>
          )}

          {sessionState === StreamingAvatarSessionState.CONNECTING && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50">
              <LoadingIcon className="h-10 w-10 animate-spin" />
              <span className="ml-2">Conectando…</span>
            </div>
          )}

          {sessionState === StreamingAvatarSessionState.CONNECTED && (
            <div className="absolute left-2 top-2 z-10 rounded-full bg-black/70 px-3 py-1 text-sm text-white">
              Grabando: {timerDisplay}
            </div>
          )}
        </div>

        {/* User camera */}
        <div className="w-full md:w-1/2">
          <video
            autoPlay
            className="aspect-video w-full rounded-lg border border-blue-500 bg-black object-cover"
            muted
            playsInline
            ref={userCameraRef}
          />
        </div>
      </div>

      {/* Controls */}
      <div className="mt-6 flex w-full flex-col items-center justify-center gap-3 border-t border-zinc-700 p-4">
        {/* Arranque inicial */}
        {sessionState === StreamingAvatarSessionState.INACTIVE && !showAutoplayBlockedMessage && (
          <div className="flex flex-row gap-4">
            <Button
              disabled={isAttemptingAutoStart || !hasUserMediaPermission}
              onClick={() => startHeyGenSession(true)}
            >
              Iniciar Chat de Voz
            </Button>
            <Button
              disabled={isAttemptingAutoStart || !hasUserMediaPermission}
              onClick={() => startHeyGenSession(false)}
            >
              Iniciar Chat de Texto
            </Button>
          </div>
        )}

        {/* Si ya estoy conectado pero la voz aún no está activa */}
        {sessionState === StreamingAvatarSessionState.CONNECTED && !isVoiceActive && (
          <Button onClick={handleVoiceChatClick}>Encender voz</Button>
        )}

        {sessionState === StreamingAvatarSessionState.CONNECTED && (
          <>
            <AvatarControls />
            <Button className="bg-red-600 hover:bg-red-700" onClick={() => stopAndFinalizeSession(messagesRef.current)}>
              Finalizar Sesión
            </Button>
          </>
        )}
      </div>

      {sessionState === StreamingAvatarSessionState.CONNECTED && <MessageHistory />}

      <footer className="mt-auto mb-5 w-full text-center text-sm text-zinc-500">
        <p>
          Desarrollado por{' '}
          <a
            className="text-blue-400 hover:underline"
            href="https://www.teams.com.mx"
            rel="noopener noreferrer"
            target="_blank"
          >
            Teams
          </a>{' '}
          © 2025
        </p>
      </footer>

      {/* Overlay de subida / análisis IA */}
      {isUploading && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 text-white backdrop-blur-sm">
          <LoaderCircle className="mb-6 h-12 w-12 animate-spin" />
          <p className="px-4 text-lg">Subiendo a servidores para&nbsp;análisis&nbsp;IA…</p>
        </div>
      )}
    </div>
  );
}

export default function InteractiveSessionWrapper() {
  return (
    <StreamingAvatarProvider>
      <InteractiveSessionContent />
    </StreamingAvatarProvider>
  );
}
