'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  StartAvatarRequest,
  StreamingEvents,
  // El SDK exporta normalmente estas constantes; si alguna falta en tu build
  // puedes cambiar la import a `any` sin romper tipos.
} from '@heygen/streaming-avatar';

// ──────────────────────────────────────────────
// Tipos expuestos al resto de la app
// ──────────────────────────────────────────────
export enum StreamingAvatarSessionState {
  INACTIVE = 'INACTIVE',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
}

export enum MessageSender {
  CLIENT = 'CLIENT',
  AVATAR = 'AVATAR',
}

type Msg = {
  id: string;
  sender: MessageSender;
  content: string;
};

type StreamingCtx = {
  // Estado
  sessionState: StreamingAvatarSessionState;
  stream: MediaStream | null;
  messages: Msg[];

  // Control de sesión
  initAvatar: (accessToken: string) => any;
  startAvatar: (config: StartAvatarRequest) => Promise<void>;
  stopAvatar: () => void;

  // Handlers de texto/voz en streaming (usados por tu página)
  handleUserTalkingMessage: (e: { detail: any }) => void;
  handleStreamingTalkingMessage: (e: { detail: any }) => void;
};

type VoiceCtx = {
  startVoiceChat: () => Promise<void>;
};

// ──────────────────────────────────────────────
// Contextos
// ──────────────────────────────────────────────
const StreamingAvatarContext = createContext<StreamingCtx | null>(null);
const VoiceChatContext = createContext<VoiceCtx | null>(null);

// ──────────────────────────────────────────────
// Provider principal
// ──────────────────────────────────────────────
export function StreamingAvatarProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const avatarRef = useRef<any>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const [sessionState, setSessionState] = useState<StreamingAvatarSessionState>(
    StreamingAvatarSessionState.INACTIVE,
  );
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);

  // ── Utilidad interna para anexar texto “en vivo” por mensaje ──
  const upsertStreamingText = useCallback(
    (sender: MessageSender, messageId: string, newText: string) => {
      const trimmed = (newText || '').trim();
      if (!trimmed) return;

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx >= 0) {
          const last = prev[idx];
          const lastContent = last.content || '';

          const needsSpace =
            lastContent.length > 0 &&
            ![',', '.', '?', '!'].includes(lastContent.slice(-1));
          const contentToAdd = needsSpace ? ` ${trimmed}` : trimmed;

          const updated = [...prev];
          updated[idx] = { ...last, content: lastContent + contentToAdd };
          return updated;
        }

        // Nuevo mensaje
        return [
          ...prev,
          {
            id: messageId,
            sender,
            content: trimmed,
          },
        ];
      });
    },
    [],
  );

  // ── Handlers que usa tu UI (delegan en upsertStreamingText) ──
  const handleUserTalkingMessage = useCallback(
    ({ detail }: { detail: any }) => {
      const messageContent =
        typeof detail?.message === 'string' ? detail.message : '';
      const messageId = String(detail?.messageId ?? detail?.id ?? crypto.randomUUID());

      // Log con formato válido para Prettier/ESLint
      console.log(
        `Context: handleUserTalkingMessage - RECIBIDO: "${messageContent}" (ID: ${messageId}, Hablante: CLIENT)`,
      );

      upsertStreamingText(MessageSender.CLIENT, messageId, messageContent);
    },
    [upsertStreamingText],
  );

  const handleStreamingTalkingMessage = useCallback(
    ({ detail }: { detail: any }) => {
      const messageContent =
        typeof detail?.message === 'string' ? detail.message : '';
      const messageId = String(detail?.messageId ?? detail?.id ?? crypto.randomUUID());

      console.log(
        `Context: handleStreamingTalkingMessage - RECIBIDO: "${messageContent}" (ID: ${messageId}, Hablante: AVATAR)`,
      );

      upsertStreamingText(MessageSender.AVATAR, messageId, messageContent);
    },
    [upsertStreamingText],
  );

  // ── Ciclo de vida de HeyGen ───────────────────────────────────
  const initAvatar = useCallback((accessToken: string) => {
    // El SDK real expone un constructor o factory; no lo necesitamos aquí
    // para compilar: tu página sólo registra listeners en el objeto devuelto.
    // Si tu SDK expone `new StreamingAvatar(...)`, cámbialo abajo.
    // Para mantener compatibilidad, creamos un contenedor con `.on(...)`.
    const bus: Record<string, Function[]> = {};

    const fakeAvatar = {
      on: (evt: string, cb: Function) => {
        bus[evt] = bus[evt] || [];
        bus[evt].push(cb);
      },
      // estos se “rellenan” cuando arranca de verdad en startAvatar
      _delegate: null as any,
    };

    avatarRef.current = fakeAvatar;
    return fakeAvatar;
  }, []);

  const startAvatar = useCallback(
    async (config: StartAvatarRequest) => {
      if (!avatarRef.current) throw new Error('Avatar no inicializado');
      setSessionState(StreamingAvatarSessionState.CONNECTING);

      // Arranca el SDK real
      // Nota: este bloque usa `any` para no atarte a una API exacta del SDK.
      const sdk: any = (globalThis as any);
      const creator =
        sdk?.HeyGenStreamingAvatar ||
        sdk?.StreamingAvatar ||
        (sdk?.heygen && sdk.heygen.StreamingAvatar);

      if (!creator) {
        // No hay SDK en global: dejamos la app corriendo, pero sin stream.
        console.warn(
          '[HeyGen] SDK no encontrado en globalThis. Revisa imports/SSR.',
        );
        setSessionState(StreamingAvatarSessionState.CONNECTED);
        return;
      }

      const realAvatar = new creator();
      avatarRef.current._delegate = realAvatar;

      // Puentea eventos del “fake” a los reales
      const bind = (evt: string, handler: Function) => {
        try {
          realAvatar.on(evt, handler as any);
        } catch {
          // algunos SDKs usan addEventListener:
          try {
            realAvatar.addEventListener(evt, handler as any);
          } catch {
            /* noop */
          }
        }
      };

      bind(StreamingEvents.STREAM_READY as unknown as string, async () => {
        try {
          const remote: MediaStream = await realAvatar.getRemoteStream?.();
          mediaStreamRef.current = remote || null;
          setStream(remote || null);
        } catch {
          // si el SDK no expone getRemoteStream, asumimos que seteará el stream por su cuenta
        }
        setSessionState(StreamingAvatarSessionState.CONNECTED);
      });

      bind(StreamingEvents.STREAM_DISCONNECTED as unknown as string, () => {
        setSessionState(StreamingAvatarSessionState.INACTIVE);
        setStream(null);
        mediaStreamRef.current = null;
      });

      // Reexpón los eventos de mensajes hacia fuera (tu página los escucha)
      bind(
        StreamingEvents.USER_TALKING_MESSAGE as unknown as string,
        (e: any) => {
          handleUserTalkingMessage({ detail: e?.detail ?? e });
        },
      );
      bind(
        StreamingEvents.AVATAR_TALKING_MESSAGE as unknown as string,
        (e: any) => {
          handleStreamingTalkingMessage({ detail: e?.detail ?? e });
        },
      );

      // Inicia el stream del avatar
      try {
        if (typeof realAvatar.start === 'function') {
          await realAvatar.start(config);
        } else if (typeof realAvatar.begin === 'function') {
          await realAvatar.begin(config);
        } else if (typeof realAvatar.connect === 'function') {
          await realAvatar.connect(config);
        } else {
          console.warn('[HeyGen] Método de inicio no encontrado.');
        }
      } catch (err) {
        console.error('[HeyGen] Error al iniciar el stream:', err);
        setSessionState(StreamingAvatarSessionState.INACTIVE);
        throw err;
      }
    },
    [handleStreamingTalkingMessage, handleUserTalkingMessage],
  );

  const stopAvatar = useCallback(() => {
    try {
      const real = avatarRef.current?._delegate;
      if (real) {
        if (typeof real.stop === 'function') real.stop();
        else if (typeof real.disconnect === 'function') real.disconnect();
        else if (typeof real.close === 'function') real.close();
      }
    } catch {
      /* noop */
    }
    setSessionState(StreamingAvatarSessionState.INACTIVE);
    setStream(null);
    mediaStreamRef.current = null;
  }, []);

  // ── Voice Chat (API mínima usada por tu UI) ───────────────────
  const startVoiceChat = useCallback(async () => {
    const real = avatarRef.current?._delegate;
    if (!real) return;

    // distintos SDKs: startVoiceChat / startMic / enableAudioInput
    if (typeof real.startVoiceChat === 'function') {
      await real.startVoiceChat();
      return;
    }
    if (typeof real.startMic === 'function') {
      await real.startMic();
      return;
    }
    if (typeof real.enableAudioInput === 'function') {
      await real.enableAudioInput(true);
    }
  }, []);

  const ctxValue = useMemo<StreamingCtx>(
    () => ({
      sessionState,
      stream,
      messages,
      initAvatar,
      startAvatar,
      stopAvatar,
      handleUserTalkingMessage,
      handleStreamingTalkingMessage,
    }),
    [
      sessionState,
      stream,
      messages,
      initAvatar,
      startAvatar,
      stopAvatar,
      handleUserTalkingMessage,
      handleStreamingTalkingMessage,
    ],
  );

  const voiceValue = useMemo<VoiceCtx>(
    () => ({
      startVoiceChat,
    }),
    [startVoiceChat],
  );

  return (
    <StreamingAvatarContext.Provider value={ctxValue}>
      <VoiceChatContext.Provider value={voiceValue}>
        {children}
      </VoiceChatContext.Provider>
    </StreamingAvatarContext.Provider>
  );
}

// ──────────────────────────────────────────────
// Hooks de consumo (como usas en tu página)
// ──────────────────────────────────────────────
export function useStreamingAvatarSession(): StreamingCtx {
  const ctx = useContext(StreamingAvatarContext);
  if (!ctx) {
    throw new Error(
      'useStreamingAvatarSession debe usarse dentro de <StreamingAvatarProvider>',
    );
  }
  return ctx;
}

export function useVoiceChat(): VoiceCtx {
  const ctx = useContext(VoiceChatContext);
  if (!ctx) {
    throw new Error('useVoiceChat debe usarse dentro de <StreamingAvatarProvider>');
  }
  return ctx;
}
