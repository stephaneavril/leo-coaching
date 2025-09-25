# evaluator.py
# -------------------------------------------------------------------
# Evaluación de Coaching (Gerente ↔ LEO) con enfoque GROW
# Retorna: {"public": str, "internal": dict, "level": "alto"|"error"}
# Incluye evaluate_and_persist(session_id, manager_text, leo_text)
# -------------------------------------------------------------------
import os, json, textwrap, unicodedata, re, difflib
from typing import Optional, Dict, Tuple
from urllib.parse import urlparse

import psycopg2
from openai import OpenAI, OpenAIError
from dotenv import load_dotenv

load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY", ""))

# ───────────────────────── Utils ─────────────────────────

def _strip_accents(s: str) -> str:
    return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()

def _despacer(s: str) -> str:
    # Repara separaciones raras del STT: "comprom isos" -> "compromisos"
    return re.sub(r"(\w)\s+(?=\w)", r"\1", s)

def _norm(txt: str) -> str:
    if not txt:
        return ""
    txt = _despacer(txt)
    txt = _strip_accents(txt.lower())
    txt = re.sub(r"\s+", " ", txt).strip()
    return txt

def _fuzzy(a: str, b: str, thr: float = 0.82) -> bool:
    if not a or not b: return False
    if b in a: return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= thr

def _count_hits(nt: str, phrases) -> int:
    return sum(1 for p in phrases if _fuzzy(nt, _strip_accents(p.lower())))

# ───────────────────────── Heurísticas GROW ─────────────────────────
# Añadimos "cuentame / platicame / hablame" como preguntas abiertas
OPEN_Q = (
    "como", "que", "cual", "cuando", "por que", "que tan", "en que medida",
    "cuentame", "cuentame mas", "platicame", "hablame"
)
WILL_HINTS = (
    "fecha", "cuando", "antes de", "para el", "proxima semana", "dos semanas",
    "revisamos", "seguimiento", "compromiso", "acordamos", "plan de accion", "revisemos"
)
LISTEN_HINTS = (
    "entiendo", "si te entiendo", "si entiendo bien", "lo que dices", "parafraseando",
    "veo que", "suena a que"
)
EMPOWER_HINTS = (
    "que opciones", "que alternativas", "como podrias", "que te ayudaria", "que necesitas"
)

COACH_SKILLS = {
    "preguntas_abiertas": list(OPEN_Q),
    "escucha_activa": list(LISTEN_HINTS),
    "empoderamiento": list(EMPOWER_HINTS),
    "guia_hacia_la_accion": list(WILL_HINTS),
}

def _score_grow(manager: str) -> Dict[str, str]:
    nt = _norm(manager)
    open_q = _count_hits(nt, OPEN_Q)
    followup = any(h in nt for h in WILL_HINTS)
    empower = _count_hits(nt, EMPOWER_HINTS)

    def lvl(val, hi=3, med=1):
        return "Excelente" if val >= hi else "Bien" if val >= med else "Necesita Mejora"

    return {
        "goal": "Bien" if ("objetivo" in nt or "meta" in nt) else "Necesita Mejora",
        "reality": lvl(open_q, 2, 1),
        "options": lvl(empower, 2, 1),
        "will": "Bien" if followup else "Necesita Mejora",
    }

def _score_skills(manager: str) -> Dict[str, str]:
    nt = _norm(manager)
    out = {}
    for skill, plist in COACH_SKILLS.items():
        h = _count_hits(nt, plist)
        out[skill] = "Excelente" if h >= 4 else "Bien" if h >= 2 else "Necesita Mejora"
    # complementos neutrales (no heurísticos por ahora)
    out.setdefault("retro_clara", "Bien")
    out.setdefault("conexion_emocional", "Bien")
    return out

def _quality_signals(manager: str) -> Dict[str, object]:
    t = manager or ""
    tokens = len(_norm(t).split())
    qmarks = t.count("?")
    return {
        "length_tokens": tokens,
        "question_marks": qmarks,
        "question_rate_pct": round(qmarks / max(1, tokens) * 100, 2),
        "closing_present": any(k in _norm(t) for k in ["siguiente paso", "acordamos", "compromiso", "revisamos", "revisemos"]),
    }

def _to_num(level: str) -> int:
    return {"Excelente": 3, "Bien": 2, "Necesita Mejora": 1}.get(level, 1)

def _kpis_from_grow(grow: Dict[str, str]) -> Tuple[float, float]:
    vals = [_to_num(grow.get(k, "Necesita Mejora")) for k in ("goal", "reality", "options", "will")]
    avg_1_3 = round(sum(vals) / 4.0, 2)
    avg_0_10 = round((avg_1_3 - 1) * (10 / 2), 1)
    return avg_0_10, avg_1_3

# ───────────────────────── DB ─────────────────────────

def _db_conn():
    url = os.getenv("DATABASE_URL")
    if not url:
        raise ValueError("DATABASE_URL no configurada")
    p = urlparse(url)
    return psycopg2.connect(
        database=p.path[1:], user=p.username, password=p.password,
        host=p.hostname, port=p.port, sslmode="require"
    )

# ───────────────────────── Compact ─────────────────────────

def _build_compact(internal: dict) -> dict:
    grow = internal.get("grow_eval", {}) or {}
    avg0_10 = internal.get("kpis", {}).get("avg_score", 0.0)
    avg1_3  = internal.get("kpis", {}).get("avg_phase_score_1_3", 1.0)
    strengths, opps = [], []

    if grow.get("goal") in ("Bien","Excelente"): strengths.append("Define meta al inicio")
    else: opps.append("Aclarar meta y criterio de éxito")

    if grow.get("reality") == "Excelente": strengths.append("Explora realidad con preguntas abiertas")
    else: opps.append("Hacer 3 preguntas abiertas + parafraseo")

    if grow.get("options") in ("Bien","Excelente"): strengths.append("Co-crea opciones")
    else: opps.append("Generar 2 opciones viables")

    if grow.get("will") == "Excelente": strengths.append("Cierra con fecha y seguimiento")
    else: opps.append("Acordar 2 acciones con fecha y responsable")

    return {
        "score_14": int(round((avg1_3 - 1) * 6)),   # escala 0–6 desde 1–3 (simple)
        "risk": "ALTO" if avg1_3 <= 1.5 else "MEDIO" if avg1_3 < 2.5 else "BAJO",
        "strengths": strengths,
        "opportunities": opps,
        "coaching_3": [
            "Define objetivo GROW claro",
            "3 preguntas abiertas + parafraseo",
            "2 acciones con fecha y revisión"
        ],
        "frase_guia": "¿Te parece acordar dos acciones con fecha y revisamos en 2 semanas?",
        "kpis": [f"Avg 0–10: {avg0_10}", f"GROW 1–3: {avg1_3}"],
        "rh_text": "Sesión GROW. Refuerza meta, realidad con preguntas y cierre con acciones/fecha.",
        "user_text": "Clarifica meta, explora con 3 preguntas y cierra con 2 acciones con fecha."
    }

# ───────────────────────── LLM + Ensamble ─────────────────────────

def evaluate_interaction(manager_text: str, leo_text: str, video_path: Optional[str] = None) -> Dict[str, object]:
    """Evalúa desempeño del GERENTE usando GROW. LEO se usa como contexto coachee."""
    mgr_raw = manager_text or ""
    leo_raw = leo_text or ""

    # Heurística base (si GPT falla)
    grow_h = _score_grow(mgr_raw)
    skills_h = _score_skills(mgr_raw)
    quality_h = _quality_signals(mgr_raw)

    try:
        SYSTEM = textwrap.dedent("""
        Actúa como evaluador senior de coaching en ventas usando el modelo GROW.
        Recibirás dos bloques: (1) texto del GERENTE (coach) y (2) texto de LEO (coachee).
        Evalúa SOLO el desempeño del GERENTE. Devuelve JSON EXACTO:
        {
          "public_summary": "<máx 120 palabras, empático y accionable, dirigido al COACH humano (no a LEO). Usa segunda persona ('tú') para dar feedback al coach. Nunca te dirijas a LEO.>",
          "internal_analysis": {
            "overall": "<2-3 frases objetivas>",
            "GROW": {
              "goal": "Excelente | Bien | Necesita Mejora",
              "reality": "Excelente | Bien | Necesita Mejora",
              "options": "Excelente | Bien | Necesita Mejora",
              "will": "Excelente | Bien | Necesita Mejora"
            },
            "habilidades": {
              "preguntas_abiertas": "Excelente | Bien | Necesita Mejora",
              "escucha_activa": "Excelente | Bien | Necesita Mejora",
              "retro_clara": "Excelente | Bien | Necesita Mejora",
              "empoderamiento": "Excelente | Bien | Necesita Mejora",
              "conexion_emocional": "Excelente | Bien | Necesita Mejora",
              "guia_hacia_la_accion": "Excelente | Bien | Necesita Mejora"
            }
          }
        }
        """).strip()

        convo = f"--- GERENTE (coach) ---\n{mgr_raw}\n\n--- LEO (coachee) ---\n{leo_raw}"
        completion = client.chat.completions.create(
            model=os.getenv("OPENAI_GPT_MODEL", "gpt-4o-mini"),
            timeout=40,
            response_format={"type": "json_object"},
            messages=[{"role": "system", "content": SYSTEM},
                      {"role": "user", "content": convo}],
            temperature=0.3
        )
        j = json.loads(completion.choices[0].message.content)
        public_summary = j.get("public_summary", "")
        ia = j.get("internal_analysis", {}) or {}
        grow = ia.get("GROW") or grow_h
        hab  = ia.get("habilidades") or skills_h
        overall = ia.get("overall", "")

        avg0_10, avg1_3 = _kpis_from_grow(grow)

        internal = {
            "overall_training_summary": overall,
            "grow_eval": grow,
            "gpt_detailed_feedback": {"habilidades": hab},
            "interaction_quality": quality_h,
            "kpis": {"avg_score": avg0_10, "avg_phase_score_1_3": avg1_3},
        }
        # 👉 Compact para el admin
        internal["compact"] = _build_compact(internal)

        public_block = textwrap.dedent(f"""
        {public_summary}

        Áreas sugeridas:
        • G: Clarifica meta y criterio de éxito.
        • R: 3 preguntas abiertas + parafraseo.
        • O: 2 opciones viables co-creadas.
        • W: 2 acciones con fecha y seguimiento.
        """).strip()

        return {"public": public_block, "internal": internal, "level": "alto"}

    except (OpenAIError, json.JSONDecodeError, Exception):
        # Fallback determinista
        avg0_10, avg1_3 = _kpis_from_grow(grow_h)
        internal = {
            "overall_training_summary": "Evaluación heurística por indisponibilidad del LLM.",
            "grow_eval": grow_h,
            "gpt_detailed_feedback": {"habilidades": skills_h},
            "interaction_quality": quality_h,
            "kpis": {"avg_score": avg0_10, "avg_phase_score_1_3": avg1_3},
        }
        internal["compact"] = _build_compact(internal)

        public = (
            "Buen esfuerzo. Usa GROW completo: aclara meta, explora realidad con 3 preguntas, "
            "co-crea opciones y cierra con 2 acciones con fecha."
        )
        return {"public": public, "internal": internal, "level": "error"}

# ───────────────────────── Persistencia ─────────────────────────

def evaluate_and_persist(session_id: int, manager_text: str, leo_text: str, video_path: Optional[str] = None) -> Dict[str, object]:
    """Evalúa y escribe evaluation / evaluation_rh en la tabla interactions."""
    res = evaluate_interaction(manager_text, leo_text, video_path)
    conn = None
    try:
        conn = _db_conn()
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE interactions
                   SET evaluation = %s,
                       evaluation_rh = %s
                 WHERE id = %s
                """,
                (res.get("public",""), json.dumps(res.get("internal", {})), int(session_id))
            )
        conn.commit()
    finally:
        if conn:
            conn.close()
    return res
