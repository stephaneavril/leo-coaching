# evaluator.py
# -------------------------------------------------------------------
# Coaching GROW para sesiones Gerente ↔ Avatar (representante de ventas)
# Retorna: {"public": str, "internal": dict, "level": "alto"|"error"}
# -------------------------------------------------------------------
import os, json, textwrap, unicodedata, re, difflib
from typing import Optional, Dict
from openai import OpenAI, OpenAIError
from dotenv import load_dotenv

load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY", ""))

# ───────────────────────── Utils ─────────────────────────
def _norm(txt: str) -> str:
    if not txt: return ""
    t = unicodedata.normalize("NFD", txt)
    t = t.encode("ascii", "ignore").decode().lower()
    t = re.sub(r"\s+", " ", t).strip()
    return t

def _fuzzy(hay: str, needle: str, thr: float = 0.82) -> bool:
    if not hay or not needle: return False
    if needle in hay: return True
    return difflib.SequenceMatcher(None, hay, needle).ratio() >= thr

# ───────────────────────── Señales GROW ─────────────────────────
GROW_SIGNALS = {
    # G – Goal: claridad de meta/resultado de sesión, estilo SMART
    "goal": {
        "weight": 3,
        "phrases": [
            "objetivo de esta sesi", "que te gustaria obtener al final",
            "meta", "objetivo smart", "que quieres lograr", "exito seria"
        ],
    },
    # R – Reality: explorar situación actual, evidencias, emociones, obstáculos
    "reality": {
        "weight": 3,
        "phrases": [
            "situacion actual", "que sucede hoy", "que has intentado",
            "que te inquieta", "que funciona", "que te detiene",
            "como llegas con", "escucha activa", "parafrase"
        ],
    },
    # O – Options: generar alternativas, brainstorm, pros/contras
    "options": {
        "weight": 2,
        "phrases": [
            "que opciones ves", "que otras alternativas", "que mas podrias",
            "como lo podrias hacer", "que otra pregunta se te ocurre",
            "que otra cosa", "romper el hielo", "sonreir", "storytelling"
        ],
    },
    # W – Will/Way forward: plan de acción, fechas y compromisos
    "will": {
        "weight": 3,
        "phrases": [
            "que haras concretamente", "cuando lo haras", "como lo haras",
            "siguiente paso", "plan de accion", "compromiso",
            "en la proxima visita", "primer semana de"
        ],
    },
}

# Señales de habilidades del gerente-coach (ventas farma)
COACH_SKILLS = {
    "preguntas_abiertas": ["que", "como", "cual seria", "de que manera"],
    "escucha_activa": ["entiendo", "si te escucho", "si te entiendo", "lo que dices", "parafrase"],
    "retro_clara": ["te propongo", "enfocate en", "evita", "haz", "prueba"],
    "empoderamiento": ["que prefieres", "que eliges", "que te funcionaria", "de quien depende"],
    "conexion_emo": ["como te sientes", "que te hace sentir", "me encanta", "gracias por compartir"],
    "guia_accion": ["cuando lo haras", "que harias", "primer paso", "fecha", "responsable"],
}

def _count_hits(txt: str, phrases):
    nt = _norm(txt)
    return sum(1 for p in phrases if _fuzzy(nt, _norm(p), 0.80))

def _score_grow(manager: str):
    nt = _norm(manager)
    detail, total = {}, 0
    for k, cfg in GROW_SIGNALS.items():
        hits = _count_hits(nt, cfg["phrases"])
        score = min(3, hits) * cfg["weight"]  # cap por sección
        total += score
        detail[k] = {"hits": hits, "weighted": score}
    return detail, total

def _score_skills(manager: str):
    nt = _norm(manager)
    out = {}
    for skill, plist in COACH_SKILLS.items():
        h = _count_hits(nt, plist)
        out[skill] = "Excelente" if h >= 4 else "Bien" if h >= 2 else "Necesita Mejora"
    return out

def _quality_signals(manager: str):
    t = manager or ""
    tokens = len(_norm(t).split())
    qmarks = t.count("?")
    question_rate = round(qmarks / max(1, tokens) * 100, 2)
    # Señales específicas del dominio de tus coachings (cierre por necesidades, sin “números” prematuros)
    evita_num_cierre = _fuzzy(_norm(t), "evita numeros") or "¿cuántos" not in t.lower()
    sonrisa = ("sonrie" in _norm(t)) or ("sonrisa" in _norm(t))
    parafraseo = "parafrase" in _norm(t)
    return {
        "length_tokens": tokens,
        "question_rate_pct": question_rate,
        "evita_numeros_en_cierre": evita_num_cierre,   # coaching reciente
        "menciona_sonrisa_o_pausa": sonrisa,           # apertura con sonrisa/pausa
        "parafraseo_mencion": parafraseo,
    }

# ───────────────────────── Evaluador principal ─────────────────────────
def evaluate_interaction(
    manager_text: str,
    avatar_text: Optional[str] = None,
    video_path: Optional[str] = None  # reservado por si luego integramos presencia no verbal
) -> Dict[str, object]:
    """
    manager_text: diálogo del gerente (coach)
    avatar_text: diálogo del avatar-representante (coachee)
    """

    # 1) Métricas objetivas GROW + habilidades
    grow_detail, grow_total = _score_grow(manager_text)
    skills = _score_skills(manager_text)
    quality = _quality_signals(manager_text)

    # 2) Llamada a GPT para síntesis cualitativa y mapa GROW
    SYSTEM = textwrap.dedent("""
    Actúas como evaluador senior de coaching comercial (farmacéutico) usando el modelo GROW.
    El gerente coachea a un REPRESENTANTE (avatar). Evalúa SOLO con el texto dado.
    Enfatiza: meta clara de sesión (Goal), exploración realista (Reality), co-creación de opciones (Options),
    y plan comprometido con fechas/seguimiento (Will). Observa habilidades: preguntas abiertas, escucha/parafraseo,
    retroalimentación clara, empoderamiento, conexión emocional y guía hacia la acción.
    Responde en JSON EXACTO con el FORMATO.
    """)
    FORMAT = textwrap.dedent("""
    {
      "resumen_publico": "<máx 120 palabras, empático, práctico>",
      "analisis_interno": {
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
        },
        "observaciones": "<2-3 frases objetivas sobre lo observado en la sesión>",
        "siguientes_pasos_coaching": [
          "<acción 1 concreta con fecha/criterio>",
          "<acción 2>",
          "<acción 3>"
        ]
      }
    }
    """)
    convo = (
        f"--- Gerente (coach) ---\n{manager_text}\n"
        f"--- Avatar (representante) ---\n{avatar_text or '(sin texto del avatar)'}"
    )

    try:
        completion = client.chat.completions.create(
            model=os.getenv("OPENAI_GPT_MODEL", "gpt-4o-mini"),
            timeout=40,
            response_format={"type": "json_object"},
            temperature=0.3,
            messages=[
                {"role": "system", "content": SYSTEM + "\n\nFORMATO:\n" + FORMAT},
                {"role": "user", "content": convo},
            ],
        )
        j = json.loads(completion.choices[0].message.content)
        public = j.get("resumen_publico", "")
        internal_ai = j.get("analisis_interno", {})
        level = "alto"
    except (OpenAIError, json.JSONDecodeError, Exception) as e:
        public = (
            "Sesión recibida. Trabaja una meta clara (G), explora realidad con preguntas y parafraseo (R), "
            "co-crea 2–3 opciones con pros/contras (O) y termina con plan SMART con fecha y responsable (W)."
        )
        internal_ai = {
            "GROW": {k: "Necesita Mejora" for k in ["goal","reality","options","will"]},
            "habilidades": {k: "Necesita Mejora" for k in [
                "preguntas_abiertas","escucha_activa","retro_clara","empoderamiento","conexion_emocional","guia_hacia_la_accion"
            ]},
            "observaciones": f"Evaluación parcial por error del modelo: {e}",
            "siguientes_pasos_coaching": [
                "Define objetivo de sesión en una frase y criterio de éxito",
                "Usa 3 preguntas abiertas para profundizar realidad",
                "Cierra con 2 compromisos con fecha y forma de seguimiento"
            ]
        }
        level = "error"

    # 3) Ensamble interno + compact
    def _to_num(qual: str) -> int:
        return {"Excelente": 3, "Bien": 2, "Necesita Mejora": 1}.get(qual, 1)

    g = internal_ai.get("GROW", {})
    grow_avg_1_3 = round(sum(_to_num(g.get(k, "Necesita Mejora")) for k in ["goal","reality","options","will"]) / 4.0, 2)
    score_comp = {
        "grow_detail_hits": grow_detail,
        "grow_weighted_total": grow_total,  # referencia objetiva por frases
        "skills_map": skills,
        "quality": quality,
        "grow_avg_1_3": grow_avg_1_3,
    }

    # Bloque público (añado recordatorios pro-calibración con tus sesiones)
    public_block = textwrap.dedent(f"""
        {public}

        Enfoque GROW:
        • G: inicia con meta explícita y criterio de éxito de la sesión.
        • R: profundiza con 3 preguntas abiertas + parafraseo.
        • O: co-crea 2 opciones viables (evita ir a números para el cierre temprano).
        • W: acuerda 2 acciones con fecha y seguimiento (¿cuándo y cómo revisarás?).
    """).strip()

    internal = {
        "gpt": internal_ai,
        "scores": score_comp,
    }

    return {"public": public_block, "internal": internal, "level": level}
