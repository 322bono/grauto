const DEFAULT_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiPart = {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
};

interface GenerateGeminiJsonOptions<T> {
  apiKey: string;
  model: string;
  systemInstruction: string;
  parts: GeminiPart[];
  responseJsonSchema?: Record<string, unknown>;
  maxOutputTokens: number;
  temperature?: number;
}

export async function generateGeminiJson<T>({
  apiKey,
  model,
  systemInstruction,
  parts,
  responseJsonSchema,
  maxOutputTokens,
  temperature = 0.1
}: GenerateGeminiJsonOptions<T>) {
  const response = await fetch(`${DEFAULT_API_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [
        {
          role: "user",
          parts
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema,
        maxOutputTokens,
        temperature,
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const raw = await response.json();
  const outputText = extractGeminiText(raw);

  if (!outputText) {
    throw new Error("Gemini 응답에서 JSON 텍스트를 찾지 못했습니다.");
  }

  return parseGeminiJsonText<T>(outputText);
}

export function imagePartFromDataUrl(dataUrl: string): GeminiPart {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);

  if (!match) {
    throw new Error("이미지 데이터 URL 형식을 읽지 못했습니다.");
  }

  return {
    inlineData: {
      mimeType: match[1],
      data: match[2]
    }
  };
}

function extractGeminiText(raw: any) {
  const candidates = Array.isArray(raw?.candidates) ? raw.candidates : [];

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const text = parts
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();

    if (text) {
      return text;
    }
  }

  return typeof raw?.text === "string" ? raw.text.trim() : "";
}

function stripJsonFence(text: string) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseGeminiJsonText<T>(text: string) {
  const stripped = stripJsonFence(text);
  const candidates = [
    stripped,
    extractLikelyJson(stripped),
    repairCommonJsonIssues(stripped),
    repairCommonJsonIssues(extractLikelyJson(stripped))
  ].filter((candidate, index, list): candidate is string => Boolean(candidate) && list.indexOf(candidate) === index);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next repaired candidate.
    }
  }

  throw new Error("Gemini JSON parse failed after local repair attempts.");
}

function extractLikelyJson(text: string) {
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");

  if (objectStart >= 0 && objectEnd > objectStart) {
    return text.slice(objectStart, objectEnd + 1).trim();
  }

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");

  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return text.slice(arrayStart, arrayEnd + 1).trim();
  }

  return text.trim();
}

function repairCommonJsonIssues(text: string) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
    .trim();
}
