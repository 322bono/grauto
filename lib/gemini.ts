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
      .join("")
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
  const firstJsonBlock = extractFirstJsonBlock(stripped);
  const likelyJson = extractLikelyJson(stripped);
  const sanitizedStripped = sanitizeJsonText(stripped);
  const sanitizedLikelyJson = sanitizeJsonText(likelyJson);
  const sanitizedFirstBlock = sanitizeJsonText(firstJsonBlock);
  const repairedStripped = repairCommonJsonIssues(sanitizedStripped);
  const repairedLikelyJson = repairCommonJsonIssues(sanitizedLikelyJson);
  const repairedFirstBlock = sanitizeJsonText(firstJsonBlock)
    ? repairCommonJsonIssues(sanitizedFirstBlock)
    : "";
  const candidates = [
    stripped,
    likelyJson,
    firstJsonBlock,
    sanitizedStripped,
    sanitizedLikelyJson,
    sanitizedFirstBlock,
    repairedStripped,
    repairedLikelyJson,
    repairedFirstBlock
  ].filter((candidate, index, list): candidate is string => Boolean(candidate) && list.indexOf(candidate) === index);

  let lastErrorMessage = "";

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : "Unknown JSON parse error";
      // Try the next repaired candidate.
    }
  }

  throw new Error(`Gemini JSON parse failed after local repair attempts: ${lastErrorMessage}`);
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

function extractFirstJsonBlock(text: string) {
  const trimmed = text.trim();
  const startIndex = trimmed.search(/[\[{]/);

  if (startIndex < 0) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  const startChar = trimmed[startIndex];
  const openChar = startChar === "[" ? "[" : "{";
  const closeChar = startChar === "[" ? "]" : "}";

  for (let index = startIndex; index < trimmed.length; index += 1) {
    const char = trimmed[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === openChar) {
      depth += 1;
      continue;
    }

    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(startIndex, index + 1).trim();
      }
    }
  }

  return trimmed.slice(startIndex).trim();
}

function sanitizeJsonText(text: string) {
  if (!text) {
    return text;
  }

  let sanitized = repairUnescapedNewlines(text);
  sanitized = escapeUnescapedQuotesForField(sanitized, "text_snippet");
  return sanitized;
}

function repairCommonJsonIssues(text: string) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
    .trim();
}

function repairUnescapedNewlines(text: string) {
  let inString = false;
  let escaped = false;
  let output = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      output += char;
      continue;
    }

    if (inString && (char === "\n" || char === "\r")) {
      output += char === "\n" ? "\\n" : "\\r";
      continue;
    }

    if (inString && char === "\t") {
      output += "\\t";
      continue;
    }

    output += char;
  }

  return output;
}

function escapeUnescapedQuotesForField(text: string, fieldName: string) {
  const needle = `"${fieldName}"`;
  let output = "";
  let index = 0;

  while (index < text.length) {
    const fieldIndex = text.indexOf(needle, index);

    if (fieldIndex === -1) {
      output += text.slice(index);
      break;
    }

    output += text.slice(index, fieldIndex + needle.length);
    let cursor = fieldIndex + needle.length;

    const openerMatch = text.slice(cursor).match(/^\s*:\s*"/);

    if (!openerMatch) {
      index = cursor;
      continue;
    }

    output += openerMatch[0];
    cursor += openerMatch[0].length;

    let endIndex = -1;

    for (let scan = cursor; scan < text.length; scan += 1) {
      const char = text[scan];
      if (char !== '"' || isEscaped(text, scan)) {
        continue;
      }

      let lookahead = scan + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1;
      }

      if (text[lookahead] === "," || text[lookahead] === "}" || text[lookahead] === "]") {
        endIndex = scan;
        break;
      }
    }

    if (endIndex === -1) {
      output += text.slice(cursor);
      return output;
    }

    const rawValue = text.slice(cursor, endIndex);
    const escapedValue = rawValue.replace(/(^|[^\\])"/g, '$1\\"');
    output += escapedValue;
    output += '"';
    index = endIndex + 1;
  }

  return output;
}

function isEscaped(text: string, quoteIndex: number) {
  let backslashes = 0;
  for (let index = quoteIndex - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}
