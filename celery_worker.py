# celery_worker.py — Procesa sesión con transcripts (fallback sin romper)
from __future__ import annotations
import os, json, logging
from datetime import datetime
from urllib.parse import urlparse

import psycopg2
from celery import Celery
from dotenv import load_dotenv

from evaluator import evaluate_interaction

load_dotenv()

# ───────── Celery app ─────────
CELERY_BROKER_URL = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
CELERY_RESULT_BACKEND = os.getenv("CELERY_RESULT_BACKEND", "redis://localhost:6379/0")

celery_app = Celery("leo_coaching_worker", broker=CELERY_BROKER_URL, backend=CELERY_RESULT_BACKEND)
celery_app.conf.task_routes = {"celery_worker.process_session_transcript": {"queue": "default"}}
CELERY_SOFT_LIMIT = 600
CELERY_HARD_LIMIT = 900

# ───────── DB ─────────
def _db():
    url = os.getenv("DATABASE_URL")
    if not url:
        raise ValueError("DATABASE_URL no configurada")
    p = urlparse(url)
    return psycopg2.connect(
        database=p.path[1:], user=p.username, password=p.password,
        host=p.hostname, port=p.port, sslmode="require"
    )

def _update_db(sid: int, public: str, internal: dict):
    conn = _db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE interactions
                   SET evaluation=%s,
                       evaluation_rh=%s
                 WHERE id=%s
                """,
                (public, json.dumps(internal), int(sid))
            )
        conn.commit()
    finally:
        conn.close()

# ───────── Task ─────────
@celery_app.task(
    soft_time_limit=CELERY_SOFT_LIMIT,
    time_limit=CELERY_HARD_LIMIT,
    bind=True,
    name="celery_worker.process_session_transcript",
)
def process_session_transcript(self, payload: dict):
    """
    Espera en payload:
      - session_id (int, requerido)
      - video_object_key (string, opcional – para panel)
      - duration (int, opcional)
      - user_transcript (list[str] o str, opcional)
      - avatar_transcript (list[str] o str, opcional)
    """
    logging.info("🟢 START %s payload=%s", self.request.id, payload)
    sid = payload.get("session_id")
    if not sid:
        logging.error("❌ payload sin session_id")
        return

    # 1) Recupera textos del payload
    user_t = payload.get("user_transcript") or ""
    avatar_t = payload.get("avatar_transcript") or ""

    if isinstance(user_t, list):   user_t = "\n".join([str(x) for x in user_t])
    if isinstance(avatar_t, list): avatar_t = "\n".join([str(x) for x in avatar_t])
    user_t = str(user_t)
    avatar_t = str(avatar_t)

    # 2) Si faltara todo, no rompas; deja una evaluación mínima
    if not user_t.strip() and not avatar_t.strip():
        public = "⚠️ No se recibió transcript de la sesión. Intenta nuevamente."
        internal = {"status": "sin_transcripts"}
        _update_db(sid, public, internal)
        logging.warning("⚠️ session %s: sin transcripts en payload", sid)
        return

    # 3) Evalúa y persiste
    try:
        result = evaluate_interaction(user_t, avatar_t, video_path=None)
        public  = result.get("public", "")
        internal = result.get("internal", {})
        _update_db(sid, public, internal)
        logging.info("✅ session %s evaluada y guardada", sid)
    except Exception as e:
        logging.exception("❌ error evaluando session %s: %s", sid, e)
        public = "⚠️ Error interno al evaluar la sesión."
        internal = {"error": str(e)}
        _update_db(sid, public, internal)
