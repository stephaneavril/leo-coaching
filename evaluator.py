# evaluator.py
# -------------------------------------------------------------------
# Analiza una sesión de coaching entre un gerente ↔ Jorge (avatar)
# Devuelve:
#   { "public": str, "internal": dict, "level": "alto" | "error" }
# -------------------------------------------------------------------

import os, json, textwrap, unicodedata
from typing import Optional, Dict
from openai import OpenAI, OpenAIError
from dotenv import load_dotenv

load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY", ""))

# ────────────────────────────────────────────────────────────────────
# Utilidad para normalizar textos
# ────────────────────────────────────────────────────────────────────

def normalize(txt: str) -> str:
    return unicodedata.normalize("NFD", txt).encode("ascii", "ignore").decode().lower()

# ────────────────────────────────────────────────────────────────────
# Evaluador principal
# ────────────────────────────────────────────────────────────────────

def evaluate_interaction(
    manager_text: str,
    jorge_text: str,
    video_path: Optional[str] = None  # se ignora por ahora
) -> Dict[str, object]:
    """
    manager_text : diálogo del gerente
    jorge_text   : diálogo del avatar Jorge (opcional, pero recomendado)
    Devuelve:
        - public: resumen visible para el gerente
        - internal: dict detallado para Recursos Humanos
        - level: "alto" | "error"
    """

    # ───────────── SYSTEM + FORMAT PROMPT para GPT ─────────────
    SYSTEM_PROMPT = textwrap.dedent("""
    Eres un evaluador senior especializado en liderazgo y coaching en la industria farmacéutica.

    Recibirás la transcripción de una sesión de coaching entre un gerente de distrito (quien será evaluado) y Jorge, un representante médico de Alfasigma (interpretado por un avatar IA).

    Tu tarea es evaluar el desempeño del gerente con base en su habilidad para:
    - Hacer preguntas abiertas y significativas.
    - Escuchar activamente.
    - Brindar retroalimentación clara y útil.
    - Guiar en lugar de solo instruir.
    - Reconocer emociones y avances.
    - Impulsar compromisos y siguientes pasos.

    Concéntrate únicamente en el comportamiento del gerente. Sé específico, constructivo y responde en formato JSON.
    """)

    FORMAT_GUIDE = textwrap.dedent("""
    {
       "resumen_publico": "<máximo 120 palabras para mostrar al gerente>",
        "analisis_interno": {
            "resumen_general": "<2-3 frases con resumen general para RH>",
            "habilidades_coaching": {
                "escucha_activa": "Excelente | Bien | Necesita Mejora",
                "preguntas_abiertas": "Excelente | Bien | Necesita Mejora",
                "claridad_retroalimentacion": "Excelente | Bien | Necesita Mejora",
                "empoderamiento_vs_instruccion": "Excelente | Bien | Necesita Mejora",
                "conexion_emocional": "Excelente | Bien | Necesita Mejora",
                "guia_hacia_la_accion": "Excelente | Bien | Necesita Mejora"
        }
      }
    }
    """)

    # Armar conversación de entrada
    convo = (
        f"--- District Manager ---\n{manager_text}\n"
        f"--- Jorge (avatar) ---\n{jorge_text or '(no avatar response provided)'}"
    )

    # ───────────── Llamada a GPT ─────────────
    try:
        completion = client.chat.completions.create(
            model=os.getenv("OPENAI_GPT_MODEL", "gpt-4o-mini"),
            timeout=40,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT + FORMAT_GUIDE},
                {"role": "user", "content": convo},
            ],
            temperature=0.4,
        )
        gpt_json = json.loads(completion.choices[0].message.content)
        gpt_public = gpt_json.get("public_summary", "")
        gpt_internal = gpt_json.get("internal_analysis", {})
        level = "alto"
    except (OpenAIError, json.JSONDecodeError, Exception) as e:
        gpt_public = f"⚠️ GPT error: {e}"
        gpt_internal = {"error": str(e)}
        level = "error"

    # ───────────── Salida organizada ─────────────
    def norm_keys(d: Dict[str, object]) -> Dict[str, object]:
        return {normalize(k): v for k, v in d.items()}

    internal_summary = {
        "overall_rh_summary": gpt_internal.get("overall_evaluation", ""),
        "gpt_detailed_feedback": norm_keys(gpt_internal),
    }

    public_block = textwrap.dedent(f"""
        {gpt_public}

        Recomendaciones generales:
        • Escucha activa, no interrumpas prematuramente.
        • Formula preguntas abiertas y específicas.
        • Ofrece retroalimentación clara, no solo genérica.
        • Promueve reflexión y empoderamiento, no solo instrucciones.
    """).strip()

    return {
        "public": public_block,
        "internal": internal_summary,
        "level": level
    }
