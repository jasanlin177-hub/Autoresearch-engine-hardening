import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(): void {
  const envPath = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

const OPENROUTER_KEY   = process.env.OPENROUTER_API_KEY ?? '';
const GOOGLE_STUDIO_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY ?? '';
const OPENROUTER_URL   = 'https://openrouter.ai/api/v1/chat/completions';
const GOOGLE_STUDIO_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// ── timeout for Google AI Studio before falling back (ms) ──
const GOOGLE_TIMEOUT_MS = 90_000;

// ── Free OpenRouter models to try before paid quota ──
// Tried in order; skip to next on 429/402/timeout.
const FREE_MODELS: string[] = [
  'google/gemini-2.5-pro-exp-03-25:free',
  'google/gemini-2.0-flash-exp:free',
  'meta-llama/llama-4-maverick:free',
  'deepseek/deepseek-r1:free',
];

if (!GOOGLE_STUDIO_KEY && !OPENROUTER_KEY) {
  console.error(
    '[llm] No API key found.\n' +
    '  Set GOOGLE_AI_STUDIO_API_KEY in .env (free, from https://aistudio.google.com)\n' +
    '  or OPENROUTER_API_KEY (from https://openrouter.ai)\n' +
    '  You can set both — Google AI Studio will be tried first.',
  );
  process.exit(1);
}

// ── Model name mapping: OpenRouter → Google AI Studio ──
// OpenRouter uses "google/gemini-X" prefixes; Google Studio uses bare names.
function toGoogleModel(model: string): string {
  // Strip "google/" prefix if present
  const bare = model.replace(/^google\//, '');
  // Known mappings
  const MAP: Record<string, string> = {
    'gemini-3.1-pro-preview':  'gemini-2.5-pro-preview-05-06',
    'gemini-3.1-flash-preview': 'gemini-2.0-flash',
    'gemini-2.5-pro-preview':  'gemini-2.5-pro-preview-05-06',
    'gemini-2.5-flash-preview': 'gemini-2.5-flash-preview-04-17',
    'gemini-2.0-flash':        'gemini-2.0-flash',
    'gemini-2.0-pro':          'gemini-2.0-pro',
    'gemini-1.5-pro':          'gemini-1.5-pro',
    'gemini-1.5-flash':        'gemini-1.5-flash',
  };
  return MAP[bare] ?? bare;
}

function isGoogleModel(model: string): boolean {
  return model.startsWith('google/') || model.startsWith('gemini-');
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  provider?: 'google-studio' | 'openrouter';
}

// ── Internal: call a single endpoint ──
async function callEndpoint(
  url: string,
  apiKey: string,
  model: string,
  messages: Message[],
  options: { tools?: ToolDef[]; toolChoice?: 'auto' | 'none'; maxTokens?: number },
  timeoutMs?: number,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: options.maxTokens ?? 16384,
    stream: false,
  };

  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? 'auto';
  }

  const isOpenRouter = url.includes('openrouter.ai');
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (isOpenRouter) {
    headers['HTTP-Referer'] = 'https://investment-ai.local';
    headers['X-Title'] = 'AutoResearch';
  }

  const fetchPromise = fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const res = timeoutMs
    ? await Promise.race([
        fetchPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${timeoutMs / 1000}s`)), timeoutMs),
        ),
      ])
    : await fetchPromise;

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as any;
  const choice = data.choices?.[0];

  return {
    content: choice?.message?.content ?? null,
    toolCalls: choice?.message?.tool_calls ?? [],
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

// ── Public: chat with automatic fallback ──
export async function chat(
  messages: Message[],
  options?: {
    model?: string;
    tools?: ToolDef[];
    toolChoice?: 'auto' | 'none';
    maxTokens?: number;
  },
): Promise<ChatResult> {
  const requestedModel = options?.model ?? 'google/gemini-3.1-pro-preview';
  const opts = {
    tools: options?.tools,
    toolChoice: options?.toolChoice,
    maxTokens: options?.maxTokens,
  };

  // ── Try Google AI Studio first (if key is set and model is a Google model) ──
  if (GOOGLE_STUDIO_KEY && isGoogleModel(requestedModel)) {
    const googleModel = toGoogleModel(requestedModel);
    try {
      const result = await callEndpoint(
        GOOGLE_STUDIO_URL, GOOGLE_STUDIO_KEY, googleModel,
        messages, opts, GOOGLE_TIMEOUT_MS,
      );
      console.log(`  [llm] Google AI Studio (${googleModel}) ✓`);
      return { ...result, provider: 'google-studio' };
    } catch (err: any) {
      const msg: string = err.message ?? '';
      const is429  = msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('rate');
      const isTimeout = msg.toLowerCase().includes('timeout');
      if (is429) {
        console.warn(`  [llm] Google AI Studio quota exceeded → falling back to OpenRouter`);
      } else if (isTimeout) {
        console.warn(`  [llm] Google AI Studio timed out (${GOOGLE_TIMEOUT_MS / 1000}s) → falling back to OpenRouter`);
      } else {
        console.warn(`  [llm] Google AI Studio error: ${msg.slice(0, 120)} → falling back to OpenRouter`);
      }
    }
  }

  // ── Fallback: OpenRouter 免費模型（無需餘額）──
  if (OPENROUTER_KEY) {
    for (const freeModel of FREE_MODELS) {
      try {
        const result = await callEndpoint(
          OPENROUTER_URL, OPENROUTER_KEY, freeModel,
          messages, opts, 120_000,
        );
        console.log(`  [llm] OpenRouter free (${freeModel}) ✓`);
        return { ...result, provider: 'openrouter' };
      } catch (err: any) {
        const msg: string = err.message ?? '';
        const isQuota = msg.includes('402') || msg.includes('429') ||
                        msg.toLowerCase().includes('quota') ||
                        msg.toLowerCase().includes('rate') ||
                        msg.toLowerCase().includes('credits');
        if (isQuota) {
          console.warn(`  [llm] OpenRouter free model ${freeModel} unavailable → trying next`);
        } else {
          console.warn(`  [llm] OpenRouter free model ${freeModel} error: ${msg.slice(0, 80)} → trying next`);
        }
      }
    }
    console.warn('  [llm] All free models exhausted → trying paid OpenRouter');
  }

  // ── Last resort: OpenRouter 付費模型 ──
  if (!OPENROUTER_KEY) {
    throw new Error(
      '[llm] All providers failed and OPENROUTER_API_KEY is not set. ' +
      'Add GOOGLE_AI_STUDIO_API_KEY or OPENROUTER_API_KEY to .env.',
    );
  }

  const result = await callEndpoint(
    OPENROUTER_URL, OPENROUTER_KEY, requestedModel,
    messages, opts,
  );
  console.log(`  [llm] OpenRouter paid (${requestedModel}) ✓`);
  return { ...result, provider: 'openrouter' };
}

export function getEnv(key: string): string {
  return process.env[key] ?? '';
}
