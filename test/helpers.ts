/** 测试工具：fetch 桩、响应构造、临时目录、睡眠记录。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface StubCall {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
}

export interface FetchStub {
  impl: typeof fetch
  calls: StubCall[]
}

/** 构造一个 fetch 桩：按调用序号返回响应，并记录每次请求。 */
export function makeFetch(
  resolver: (call: StubCall, index: number) => Response | Promise<Response>,
): FetchStub {
  const calls: StubCall[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const rawBody = init?.body
    let body: unknown = undefined
    if (typeof rawBody === 'string') {
      try { body = JSON.parse(rawBody) as unknown } catch { body = rawBody }
    }
    const call: StubCall = {
      url: String(input),
      method: String(init?.method ?? 'GET'),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    return await resolver(call, calls.length - 1)
  }) as unknown as typeof fetch
  return { impl, calls }
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

export function textResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers })
}

export function bytesResponse(bytes: Buffer, status = 200): Response {
  return new Response(new Uint8Array(bytes), { status, headers: { 'content-type': 'image/png' } })
}

/** 记录睡眠时长而不真的等待（退避/轮询测试用）。 */
export function makeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = []
  return {
    waits,
    sleep: async (ms: number) => { waits.push(ms) },
  }
}

export function tempDir(prefix = 'kimg-'): string {
  return mkdtempSync(join(process.cwd(), '.scratch', prefix))
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** 一张最小的合法 PNG（8x8 灰色），供下载落盘测试断言字节。 */
export function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
    'base64',
  )
}
