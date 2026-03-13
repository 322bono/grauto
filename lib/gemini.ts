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

  return JSON.parse(stripJsonFence(outputText)) as T;
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
