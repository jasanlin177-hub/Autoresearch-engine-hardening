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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GOOGLE_STUDIO_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

type LayerResult = {
  layer: string;
  ok: boolean;
  status?: number;
  model: string;
  provider: string;
  summary: string;
};

async function postJson(
  url: string,
  apiKey: string,
  model: string,
  headers: Record<string, string>,
): Promise<LayerResult> {
  const body = {
    model,
    messages: [{ role: 'user', content: '請只回覆 OK' }],
    max_tokens: 16,
    stream: false,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    const summary = text.replace(/\s+/g, ' ').slice(0, 240);
    return {
      layer: '',
      ok: res.ok,
      status: res.status,
      model,
      provider: new URL(url).host,
      summary,
    };
  } catch (err: any) {
    const cause = err?.cause?.code || err?.cause?.message || '';
    return {
      layer: '',
      ok: false,
      model,
      provider: new URL(url).host,
      summary: String(err?.message || err) + (cause ? ` | cause=${cause}` : ''),
    };
  }
}

async function testGoogle(): Promise<LayerResult> {
  const key = process.env.GOOGLE_AI_STUDIO_API_KEY ?? '';
  if (!key) {
    return {
      layer: 'google',
      ok: false,
      model: 'gemini-3.1-pro-preview',
      provider: 'generativelanguage.googleapis.com',
      summary: 'missing GOOGLE_AI_STUDIO_API_KEY',
    };
  }

  const result = await postJson(
    GOOGLE_STUDIO_URL,
    key,
    'gemini-3.1-pro-preview',
    {},
  );
  return { ...result, layer: 'google' };
}

async function testOpenRouterFree(): Promise<LayerResult> {
  const key = process.env.OPENROUTER_API_KEY ?? '';
  if (!key) {
    return {
      layer: 'openrouter-free',
      ok: false,
      model: 'google/gemma-4-31b-it:free',
      provider: 'openrouter.ai',
      summary: 'missing OPENROUTER_API_KEY',
    };
  }

  const result = await postJson(
    OPENROUTER_URL,
    key,
    'google/gemma-4-31b-it:free',
    {
      'HTTP-Referer': 'https://investment-ai.local',
      'X-Title': 'AutoResearch LLM Test',
    },
  );
  return { ...result, layer: 'openrouter-free' };
}

async function testOpenRouterPaid(): Promise<LayerResult> {
  const key = process.env.OPENROUTER_API_KEY ?? '';
  if (!key) {
    return {
      layer: 'openrouter-paid',
      ok: false,
      model: 'google/gemini-2.5-flash',
      provider: 'openrouter.ai',
      summary: 'missing OPENROUTER_API_KEY',
    };
  }

  const result = await postJson(
    OPENROUTER_URL,
    key,
    'google/gemini-2.5-flash',
    {
      'HTTP-Referer': 'https://investment-ai.local',
      'X-Title': 'AutoResearch LLM Test',
    },
  );
  return { ...result, layer: 'openrouter-paid' };
}

function printResult(result: LayerResult): void {
  const status = result.status ? String(result.status) : '-';
  const flag = result.ok ? 'PASS' : 'FAIL';
  console.log(`\n[${flag}] ${result.layer}`);
  console.log(`provider: ${result.provider}`);
  console.log(`model:    ${result.model}`);
  console.log(`status:   ${status}`);
  console.log(`summary:  ${result.summary}`);
}

async function main(): Promise<void> {
  console.log('LLM layer smoke test');
  console.log(`node: ${process.version}`);
  console.log(`NODE_OPTIONS: ${process.env.NODE_OPTIONS ?? ''}`);

  const results = [
    await testGoogle(),
    await testOpenRouterFree(),
    await testOpenRouterPaid(),
  ];

  for (const result of results) printResult(result);

  if (results.some((r) => !r.ok)) {
    process.exitCode = 1;
  }
}

void main();
