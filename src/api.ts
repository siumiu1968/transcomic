const base = '/transcomic/api'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error ?? `請求失敗 (${response.status})`)
  return body as T
}

export function sourceImage(url: string | undefined): string {
  return url ? `${base}/source-image?url=${encodeURIComponent(url)}` : ''
}
