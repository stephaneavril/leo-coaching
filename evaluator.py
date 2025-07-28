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
    Eres un evaluador experto en liderazgo y coaching farmacéutico.

    Recibirás una transcripción de una sesión de coaching entre un gerente de distrito (quien será evaluado) y Jorge, un representante médico de Alfasigma.

    Evalúa el desempeño del gerente con base en su habilidad para:
    - Hacer preguntas abiertas
    - Escuchar activamente
    - Dar retroalimentación clara
    - Promover reflexión y empoderamiento

    En la salida JSON:
    - El campo "resumen_publico" debe ser un bloque útil y empático que combine diagnóstico, sugerencias concretas (en viñetas) y un objetivo claro para la próxima sesión.
    - El campo "analisis_interno" debe resumir los hallazgos clave para Recursos Humanos.
    """)

    FORMAT_GUIDE = textwrap.dedent("""
    {
       "resumen_publico": "Escribe un resumen personalizado en español (máximo 120 palabras) dirigido al gerente evaluado. Incluye 1) diagnóstico claro de la interacción, 2) recomendaciones prácticas en viñetas y 3) un objetivo específico para la siguiente sesión. El tono debe ser empático, profesional y orientado al desarrollo.",
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
        gpt_public = gpt_json.get("resumen_publico", "")
        gpt_internal = gpt_json.get("analisis_interno", {})
        level = "alto"
    except (OpenAIError, json.JSONDecodeError, Exception) as e:
        gpt_public = f"⚠️ GPT error: {e}"
        gpt_internal = {"error": str(e)}
        level = "error"

    # ───────────── Salida organizada ─────────────
    def norm_keys(d: Dict[str, object]) -> Dict[str, object]:
        return {normalize(k): v for k, v in d.items()}

    internal_summary = {
        "overall_rh_summary": gpt_internal.get("resumen_general", ""),
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
