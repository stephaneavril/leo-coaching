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
    You are a senior evaluator specialized in leadership coaching in the pharmaceutical industry.

    You will receive a real-life transcript of a coaching session between a district manager (the person being evaluated) and Jorge, a field sales representative from Alfasigma (an AI-powered avatar).

    Your task is to assess the manager's performance based on their ability to:
    - Ask meaningful open-ended questions
    - Actively listen
    - Provide clear and actionable feedback
    - Guide rather than instruct
    - Recognize progress and emotions
    - Foster accountability and next steps

    Focus only on the manager's behavior. Be constructive, concise, and actionable. Return the response in JSON format.
    """)

    FORMAT_GUIDE = textwrap.dedent("""
    {
      "public_summary": "<max 120 words for feedback visible to manager>",
      "internal_analysis": {
        "overall_evaluation": "<2-3 sentence summary>",
        "coaching_skills": {
          "active_listening": "Excellent | Good | Needs Improvement",
          "question_quality": "Excellent | Good | Needs Improvement",
          "feedback_clarity": "Excellent | Good | Needs Improvement",
          "empowerment_vs_instruction": "Excellent | Good | Needs Improvement",
          "emotional_connection": "Excellent | Good | Needs Improvement",
          "guidance_to_action": "Excellent | Good | Needs Improvement"
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
