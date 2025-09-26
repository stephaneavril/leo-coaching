'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useUnmount } from 'ahooks';
import { useRouter, useSearchParams } from 'next/navigation';

import {
  AvatarQuality,
  StreamingEvents,
  VoiceChatTransport,
  VoiceEmotion,
  StartAvatarRequest,
  ElevenLabsModel,
} from '@heygen/streaming-avatar';

import {
  StreamingAvatarProvider,
  StreamingAvatarSessionState,
  useStreamingAvatarSession,
  useVoiceChat,
  MessageSender,
} from '@/components/logic';

import { Button } from '@/components/Button';
import { AvatarConfig } from '@/components/AvatarConfig';
import { AvatarVideo } from '@/components/AvatarSession/AvatarVideo';
import { AvatarControls } from '@/components/AvatarSession/AvatarControls';
import { LoadingIcon } from '@/components/Icons';
import { MessageHistory } from '@/components/AvatarSession/MessageHistory';
import { LoaderCircle } from 'lucide-react';

/** Preferencia fija: WEBRTC (si no, cae a WS) */
const RESOLVED_TRANSPORT =
  (VoiceChatTransport as any)?.WEBRTC ?? VoiceChatTransport.WEBSOCKET;

/** Config por defecto del avatar */
const DEFAULT_CONFIG: StartAvatarRequest = {
  quality: AvatarQuality.Low,
  avatarName: 'SilasHR_public',
  knowledgeId: 'f46a58cb19184e9ab569f00547229c9b',
  language: 'es',
  voice: {
    voiceId: '82d534d580f04edb8e4701f6f00f92ea',
    model: ElevenLabsModel.eleven_multilingual_v2,
    rate: 1.15,
    emotion: VoiceEmotion.FRIENDLY,
  },
  voiceChatTransport: RESOLVED_TRANSPORT as any,
};

function InteractiveSessionContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const {
    initAvatar,
    startAvatar,
    stopAvatar,
    sessionState,
    stream,
    messages,
    handleUserTalkingMessage,
    handleStreamingTalkingMessage,
  } = useStreamingAvatarSession();

  const { startVoiceChat } = useVoiceChat();

  // Estado UI
  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);
  const [sessionInfo, setSessionInfo] = useState<{
    name: string;
    email: string;
    scenario: string;
    token: string;
  } | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [showAutoplayBlockedMessage, setShowAutoplayBlockedMessage] = useState(false);
  const [isAttemptingAutoStart, setIsAttemptingAutoStart] = useState(false);
  const [hasUserMediaPermission, setHasUserMediaPermission] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);

  // Refs
  const avatarRef = useRef<any>(null);
  const voiceStartedOnceRef = useRef(false);
  const reconnectingRef = useRef(false);
  const silenceGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstUserTurnFallbackRef = useRef(false);
  const lastAvatarTTSAtRef = useRef<number>(0);
  const keepAliveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const heygenSessionIdRef = useRef<string | null>(null); // session_id para keep-alive

  // 8 minutos
  const recordingTimerRef = useRef<number>(480);
  const [timerDisplay, setTimerDisplay] = useState('08:00');

  const messagesRef = useRef<any[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunks = useRef<Blob[]>([]);
  const localUserStreamRef = useRef<MediaStream | null>(null);
  const userCameraRef = useRef<HTMLVideoElement>(null);
  const avatarVideoRef = useRef<HTMLVideoElement>(null);
  const isFinalizingRef = useRef(false);

  // ——— Debug/recuperación de video/TTS remoto ———
  const noFrameSinceRef = useRef<number>(Date.now());
  const lastTotalFramesRef = useRef<number>(0);
  const watchdogIntervalRef = useRef<NodeJS.Timeout | null>(null);

  function getTotalFrames(v: HTMLVideoElement) {
    try {
      // @ts-ignore Chrome/Edge
      if (typeof v.getVideoPlaybackQuality === 'function') {
        // @ts-ignore
        const q = v.getVideoPlaybackQuality();
        return q.totalVideoFrames || 0;
      }
      // @ts-ignore Safari
      if (typeof (v as any).webkitDecodedFrameCount === 'number') {
        // @ts-ignore
        return (v as any).webkitDecodedFrameCount || 0;
      }
    } catch {}
    return 0;
  }

  async function recoverRemoteVideo(reason: string) {
    const v = avatarVideoRef.current;
    const ms = (v?.srcObject as MediaStream) || null;
    console.warn('[RECOVER] intento →', reason, { hasVideo: !!v, hasStream: !!ms });
    if (!v || !ms) return;

    try {
      v.muted = false;
      v.volume = 1.0;
      await v.play();
      console.log('[RECOVER] play() OK');
    } catch (e) {
      console.warn('[RECOVER] play() falló', e);
    }

    try {
      v.srcObject = null;
      await new Promise((r) => setTimeout(r, 50));
      v.srcObject = ms;
      await v.play().catch(() => {});
      console.log('[RECOVER] rebind srcObject OK');
    } catch (e) {
      console.warn('[RECOVER] rebind falló', e);
    }

    try {
      const vids = ms.getVideoTracks().filter((t) => t.readyState === 'live');
      const auds = ms.getAudioTracks().filter((t) => t.readyState === 'live');
      if (vids.length || auds.length) {
        const fresh = new MediaStream([...vids, ...auds]);
        v.srcObject = fresh;
        await v.play().catch(() => {});
        console.log('[RECOVER] new MediaStream wrapper OK');
      }
    } catch (e) {
      console.warn('[RECOVER] new wrapper falló', e);
    }
  }
  // ——————————————————————————————————————————————

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /** ---------- Helper para speak ---------- */
  const trySpeak = useCallback(async (text: string) => {
    const a: any = avatarRef.current;
    if (!a) return;
    try {
      if (typeof a.speakText === 'function') await a.speakText(text);
      else if (typeof a.say === 'function') await a.say(text);
      else if (typeof a.send === 'function') await a.send(text);
    } catch (e) {
      console.warn('trySpeak fallback warning:', e);
    }
  }, []);

  /** ---------- Keep-alive (cada 30s + primer ping inmediato) ---------- */
  const startKeepAlive = useCallback((sessionId: string) => {
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = null;
    }

    const send = async () => {
      try {
        const r = await fetch('/api/keep-alive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
          cache: 'no-store',
        });
        if (!r.ok) {
          const txt = await r.text();
          console.warn('[keep-alive] fallo', r.status, txt);
        } else {
          console.log('[keep-alive] OK', sessionId);
        }
      } catch (e) {
        console.warn('[keep-alive] error de red:', e);
      }
    };

    // primer ping y luego cada 30 s
    send();
    keepAliveIntervalRef.current = setInterval(send, 30_000);
  }, []);

  /** ---------- Pings al volver al foco/visibilidad ---------- */
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && heygenSessionIdRef.current) {
        fetch('/api/keep-alive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: heygenSessionIdRef.current }),
          cache: 'no-store',
        }).catch(() => {});
        avatarVideoRef.current?.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, []);

  /** ---------- Leer URL/JWT ---------- */
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

  /** ---------- Cámara/Grabación usuario ---------- */
  const stopUserCameraRecording = useCallback(() => {
    if (localUserStreamRef.current) {
      localUserStreamRef.current.getTracks().forEach((t) => t.stop());
      localUserStreamRef.current = null;
    }
    if (userCameraRef.current) userCameraRef.current.srcObject = null;
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
  }, []);

  const startUserCameraRecording = useCallback(() => {
    if (!localUserStreamRef.current || mediaRecorderRef.current?.state === 'recording') return;
    try {
      const recorder = new MediaRecorder(localUserStreamRef.current, {
        mimeType: 'video/webm; codecs=vp8',
        videoBitsPerSecond: 800_000, // ↓ tamaño final
        audioBitsPerSecond: 64_000,
      });
      recordedChunks.current = [];
      recorder.ondataavailable = (e) => e.data.size && recordedChunks.current.push(e.data);
      recorder.start();
      mediaRecorderRef.current = recorder;
    } catch (err) {
      console.error('Error al iniciar MediaRecorder:', err);
    }
  }, []);

  /** ---------- Finalizar + subir ---------- */
  const stopAndFinalizeSession = useCallback(
    async (sessionMessages: any[]) => {
      if (isFinalizingRef.current || !sessionInfo) return;
      isFinalizingRef.current = true;
      setIsUploading(true);

      // apaga keep-alive
      if (keepAliveIntervalRef.current) {
        clearInterval(keepAliveIntervalRef.current);
        keepAliveIntervalRef.current = null;
      }

      try {
        try {
          stopAvatar();
        } catch {}
        setIsVoiceActive(false);

        const finalize = async () => {
          stopUserCameraRecording();

          const { name, email, scenario, token } = sessionInfo;
          const userTranscript = sessionMessages
            .filter((m) => m.sender === MessageSender.CLIENT)
            .map((m) => m.content)
            .join('\n');
          const avatarTranscript = sessionMessages
            .filter((m) => m.sender === MessageSender.AVATAR)
            .map((m) => m.content)
            .join('\n');
          const duration = 480 - recordingTimerRef.current;
          const flaskApiUrl = process.env.NEXT_PUBLIC_FLASK_API_URL || '';

          try {
            let videoS3Key: string | null = null;
            if (recordedChunks.current.length) {
              const videoBlob = new Blob(recordedChunks.current, { type: 'video/webm' });
              if (videoBlob.size) {
                const form = new FormData();
                form.append('video', videoBlob, 'user_recording.webm');
                const uploadRes = await fetch(`${flaskApiUrl}/upload_video`, {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${token}` },
                  body: form,
                });
                const uploadJson = await uploadRes.json();
                if (!uploadRes.ok) throw new Error(uploadJson.message || 'Error desconocido');
                videoS3Key = uploadJson.s3_object_key;
              }
            }

            await fetch(`${flaskApiUrl}/log_full_session`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                email,
                scenario,
                conversation: userTranscript,
                avatar_transcript: avatarTranscript,
                duration,
                s3_object_key: videoS3Key,
              }),
            });
          } catch (err: any) {
            console.error('❌ Error finalizando sesión:', err);
            alert(`⚠️ ${err.message}`);
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
      } catch (err: any) {
        console.error('❌ Error finalizando sesión:', err);
        alert(`⚠️ ${err.message}`);
        setIsUploading(false);
        router.push('/dashboard');
      }
    },
    [stopAvatar, stopUserCameraRecording, router, sessionInfo]
  );

  /** ---------- Obtener access token del backend ---------- */
  const fetchAccessToken = useCallback(async (): Promise<string> => {
    const res = await fetch('/api/get-access-token', { method: 'POST' });
    if (!res.ok) throw new Error(`Fallo al obtener token de acceso: ${res.status}`);
    const txt = await res.text();
    console.log('[HeyGen] Access token length:', txt?.length ?? 0);
    return txt;
  }, []);

  /** ---------- Silence guard ---------- */
  const armSilenceGuard = useCallback(() => {
    if (silenceGuardTimerRef.current) clearTimeout(silenceGuardTimerRef.current);
    silenceGuardTimerRef.current = setTimeout(async () => {
      if (Date.now() - lastAvatarTTSAtRef.current > 3000) {
        await trySpeak('Perdona, tuve un pequeño retraso. Ya te escucho, ¿puedes repetir o continuar?');
      }
    }, 5000);
  }, [trySpeak]);

  const cancelSilenceGuard = useCallback(() => {
    if (silenceGuardTimerRef.current) {
      clearTimeout(silenceGuardTimerRef.current);
      silenceGuardTimerRef.current = null;
    }
  }, []);

  /** ---------- Arrancar sesión HeyGen ---------- */
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
        avatarRef.current = avatar;

        avatar.on(StreamingEvents.USER_TALKING_MESSAGE, (e: any) => {
          console.log('USER_STT:', e.detail);
          handleUserTalkingMessage({ detail: e.detail });
          armSilenceGuard();

          if (!firstUserTurnFallbackRef.current) {
            firstUserTurnFallbackRef.current = true;
            setTimeout(() => {
              if (Date.now() - lastAvatarTTSAtRef.current > 900) {
                trySpeak('Hola, te escucho. Cuéntame, ¿en qué puedo ayudarte hoy?');
              }
            }, 1000);
          }
        });

        avatar.on(StreamingEvents.AVATAR_TALKING_MESSAGE, (e: any) => {
          console.log('AVATAR_TTS:', e.detail);
          lastAvatarTTSAtRef.current = Date.now();
          handleStreamingTalkingMessage({ detail: e.detail });
          cancelSilenceGuard();
        });

        (avatar as any).on?.((StreamingEvents as any).ERROR ?? 'error', (err: any) => {
          console.error('STREAM_ERROR:', err);
        });

        avatar.on(StreamingEvents.STREAM_READY, async () => {
          console.log('STREAM_READY');

          // Resolver session_id y arrancar keep-alive
          try {
            // @ts-ignore (distintos builds)
            heygenSessionIdRef.current =
              (avatar as any)?.sessionId ||
              (avatar as any)?.session_id ||
              (avatar as any)?._sessionId ||
              (avatar as any)?.session?.id ||
              (stream as any)?.id ||
              null;
          } catch {}
          if (heygenSessionIdRef.current) {
            startKeepAlive(heygenSessionIdRef.current);
            console.log('[keep-alive] session_id =', heygenSessionIdRef.current);
          } else {
            console.warn('No pude resolver session_id para keep-alive');
          }

          try {
            if (avatarVideoRef.current) {
              avatarVideoRef.current.muted = false;
              avatarVideoRef.current.volume = 1.0;
              await avatarVideoRef.current.play().catch(() => {});
            }
          } catch (e) {
            console.warn('No se pudo auto-reproducir el video remoto:', e);
            setShowAutoplayBlockedMessage(true);
          }

          setIsAttemptingAutoStart(false);
          await trySpeak('Hola, ya te escucho. Cuando quieras, empezamos.');

          if (withVoice && !voiceStartedOnceRef.current) {
            try {
              await startVoiceChat();
              voiceStartedOnceRef.current = true;
              setIsVoiceActive(true);
              console.log('startVoiceChat OK');
            } catch (e) {
              console.error('startVoiceChat falló:', e);
            }
          }
        });

        await startAvatar({
          ...config,
          voiceChatTransport: RESOLVED_TRANSPORT as any,
          // Algunas versiones del SDK aceptan este campo; si no, lo ignoran.
          // @ts-ignore
          activityIdleTimeout: 600, // 10 min para cubrir tus 8 min
        });
      } catch (err: any) {
        console.error('Error iniciando sesión con HeyGen:', err);
        setShowAutoplayBlockedMessage(true);
      } finally {
        setIsAttemptingAutoStart(false);
      }
    },
    [
      hasUserMediaPermission,
      fetchAccessToken,
      initAvatar,
      config,
      startAvatar,
      startVoiceChat,
      armSilenceGuard,
      cancelSilenceGuard,
      handleUserTalkingMessage,
      handleStreamingTalkingMessage,
      trySpeak,
      stream,
      startKeepAlive,
    ]
  );

  /** ---------- Botón “Voice Chat” ---------- */
  const handleVoiceChatClick = useCallback(
    async () => {
      if (!hasUserMediaPermission) {
        alert('Por favor, permite el acceso a la cámara y el micrófono.');
        return;
      }
      if (sessionState === StreamingAvatarSessionState.CONNECTED) {
        try {
          if (!voiceStartedOnceRef.current) {
            await startVoiceChat();
            voiceStartedOnceRef.current = true;
          }
          setIsVoiceActive(true);
          console.log('startVoiceChat OK (sesión ya conectada)');
        } catch (e) {
          console.error('startVoiceChat falló:', e);
        }
      } else {
        startHeyGenSession(true);
      }
    },
    [hasUserMediaPermission, sessionState, startVoiceChat, startHeyGenSession]
  );

  /** ---------- Permisos cámara/mic ---------- */
  useEffect(() => {
    const getUserMediaStream = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { width: 640, height: 480, frameRate: 15 },
        });
        localUserStreamRef.current = stream;
        if (userCameraRef.current) userCameraRef.current.srcObject = stream;
        setHasUserMediaPermission(true);
      } catch (err) {
        console.error('❌ Error al obtener permisos:', err);
        setShowAutoplayBlockedMessage(true);
      }
    };
    if (isReady) getUserMediaStream();
  }, [isReady]);

  /** ---------- Grabar cámara usuario al conectar ---------- */
  useEffect(() => {
    if (
      sessionState === StreamingAvatarSessionState.CONNECTED &&
      hasUserMediaPermission &&
      !mediaRecorderRef.current
    ) {
      startUserCameraRecording();
    }
  }, [sessionState, hasUserMediaPermission, startUserCameraRecording]);

  /** ---------- Vincular stream remoto ---------- */
  useEffect(() => {
    if (stream && avatarVideoRef.current) {
      avatarVideoRef.current.srcObject = stream;
      avatarVideoRef.current.onloadedmetadata = () => {
        avatarVideoRef.current!.muted = false;
        avatarVideoRef.current!.volume = 1.0;
        avatarVideoRef.current!.play().catch(() => {
          setShowAutoplayBlockedMessage(true);
        });
      };
    }
  }, [stream]);

  /** ---------- Eventos del <video> + watchdog de frames ---------- */
  useEffect(() => {
    const v = avatarVideoRef.current;
    if (!v) return;

    const log = (...a: any[]) => console.log('[AVATAR VIDEO]', ...a);
    const handlers: Record<string, any> = {
      playing: () => log('playing'),
      pause: () => log('pause'),
      waiting: () => { log('waiting'); recoverRemoteVideo('waiting'); },
      stalled: () => { log('stalled'); recoverRemoteVideo('stalled'); },
      suspend: () => log('suspend'),
      canplay: () => log('canplay'),
      canplaythrough: () => log('canplaythrough'),
      ended: () => log('ended'),
      error: () => log('error', (v as any).error),
    };
    Object.entries(handlers).forEach(([ev, fn]) => v.addEventListener(ev, fn));

    // Watchdog de frames
    if (watchdogIntervalRef.current) {
      clearInterval(watchdogIntervalRef.current);
      watchdogIntervalRef.current = null;
    }
    lastTotalFramesRef.current = getTotalFrames(v);
    noFrameSinceRef.current = Date.now();

    watchdogIntervalRef.current = setInterval(() => {
      const tf = getTotalFrames(v);
      if (tf > lastTotalFramesRef.current) {
        lastTotalFramesRef.current = tf;
        noFrameSinceRef.current = Date.now();
        return;
      }
      const gap = Date.now() - noFrameSinceRef.current;
      if (gap > 3500) {
        console.warn('[WATCHDOG] sin frames por', gap, 'ms → recover');
        recoverRemoteVideo('watchdog-no-frames');
        noFrameSinceRef.current = Date.now();
      }
    }, 1200);

    return () => {
      Object.entries(handlers).forEach(([ev, fn]) => v.removeEventListener(ev, fn));
      if (watchdogIntervalRef.current) {
        clearInterval(watchdogIntervalRef.current);
        watchdogIntervalRef.current = null;
      }
    };
  }, [stream]);

  /** ---------- Temporizador UI + autostop ---------- */
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
    return () => {
      if (id) clearInterval(id);
    };
  }, [sessionState, stopAndFinalizeSession]);

  /** ---------- Cleanup ---------- */
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

  /** ---------- Loading guard ---------- */
  if (!isReady) {
    return (
      <div className="w-screen h-screen flex flex-col items-center justify-center bg-zinc-900 text-white">
        <LoadingIcon className="w-10 h-10 animate-spin" />
        <p className="mt-4">Verificando datos de sesión...</p>
      </div>
    );
  }

  /** ---------- UI ---------- */
  return (
    <div className="w-screen h-screen flex flex-col items-center bg-zinc-900 text-white relative">
      <h1 className="text-3xl font-bold text-blue-400 mt-6 mb-4" suppressHydrationWarning>
        {`🧠 Leo – ${sessionInfo?.scenario || ''}`}
      </h1>

      {sessionState === StreamingAvatarSessionState.INACTIVE &&
        !hasUserMediaPermission &&
        !showAutoplayBlockedMessage && <p className="text-zinc-300 mb-6">Solicitando permisos...</p>}

      {showAutoplayBlockedMessage && (
        <div className="text-red-400 mb-6 text-center">
          Permisos de cámara/micrófono denegados o no disponibles.
        </div>
      )}

      {/* Video area */}
      <div className="relative w-full max-w-4xl flex flex-col md:flex-row items-center justify-center gap-5 p-4">
        {/* Avatar video */}
        <div className="relative w-full md:w-1/2 aspect-video min-h-[300px] flex items-center justify-center bg-zinc-800 rounded-lg shadow-lg overflow-hidden">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <AvatarVideo ref={avatarVideoRef} />
          ) : (
            !showAutoplayBlockedMessage && <AvatarConfig config={config} onConfigChange={setConfig} />
          )}

          {showAutoplayBlockedMessage && (
            <div className="absolute inset-0 bg-black/75 flex flex-col items-center justify-center text-center p-4 z-30">
              <p className="mb-4 text-lg font-semibold">Video y Audio Bloqueados</p>
              <p className="mb-6">Haz clic para reintentar.</p>
              <Button onClick={handleAutoplayRetry} className="bg-blue-600 hover:bg-blue-700">
                Habilitar
              </Button>
            </div>
          )}

          {sessionState === StreamingAvatarSessionState.CONNECTING && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-20">
              <LoadingIcon className="w-10 h-10 animate-spin" />
              <span className="ml-2">Conectando…</span>
            </div>
          )}

          {sessionState === StreamingAvatarSessionState.CONNECTED && (
            <div className="absolute top-2 left-2 bg-black/70 text-white text-sm px-3 py-1 rounded-full z-10">
              Grabando: {timerDisplay}
            </div>
          )}
        </div>

        {/* User camera */}
        <div className="w-full md:w-1/2">
          <video
            ref={userCameraRef}
            autoPlay
            muted
            playsInline
            className="rounded-lg border border-blue-500 w-full aspect-video object-cover bg-black"
          />
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-3 items-center justify-center p-4 border-t border-zinc-700 w-full mt-6">
        {sessionState === StreamingAvatarSessionState.INACTIVE && !showAutoplayBlockedMessage && (
          <div className="flex flex-row gap-4">
            <Button onClick={handleVoiceChatClick} disabled={isAttemptingAutoStart || !hasUserMediaPermission}>
              Iniciar Chat de Voz
            </Button>
            <Button onClick={() => startHeyGenSession(false)} disabled={isAttemptingAutoStart || !hasUserMediaPermission}>
              Iniciar Chat de Texto
            </Button>
          </div>
        )}

        {sessionState === StreamingAvatarSessionState.CONNECTED && !isVoiceActive && (
          <Button onClick={handleVoiceChatClick}>Encender voz</Button>
        )}

        {sessionState === StreamingAvatarSessionState.CONNECTED && (
          <>
            <AvatarControls />
            <Button
              onClick={() => stopAndFinalizeSession(messagesRef.current)}
              className="bg-red-600 hover:bg-red-700"
            >
              Finalizar Sesión
            </Button>
          </>
        )}
      </div>

      {sessionState === StreamingAvatarSessionState.CONNECTED && <MessageHistory />}

      <footer className="mt-auto mb-5 text-sm text-zinc-500 text-center w-full">
        <p>
          Desarrollado por{' '}
          <a href="https://www.teams.com.mx" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
            Teams
          </a>{' '}
          © 2025
        </p>
      </footer>

      {isUploading && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 text-white backdrop-blur-sm">
          <LoaderCircle className="h-12 w-12 animate-spin mb-6" />
          <p className="text-lg text-center px-4">Subiendo a servidores para&nbsp;análisis&nbsp;IA…</p>
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
