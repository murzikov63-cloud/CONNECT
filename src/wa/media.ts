import { createHash } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { config } from '../config/index.js'
import { log } from '../logger/index.js'
import type { MediaPayload } from '../types.js'

const logger = log('media')

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

export function extForMime(mime: string): string {
  const clean = mime.split(';')[0]?.trim() ?? ''
  return EXT_BY_MIME[mime] ?? EXT_BY_MIME[clean] ?? 'bin'
}

/** Ключ для подписанных ссылок — по нему amoCRM забирает файл. */
export function mediaToken(relPath: string): string {
  return createHash('sha256')
    .update(`${relPath}:${config.ADMIN_API_KEY}`)
    .digest('hex')
    .slice(0, 32)
}

export function mediaUrl(relPath: string): string {
  return `https://${config.PUBLIC_DOMAIN}/media/${relPath}?t=${mediaToken(relPath)}`
}

export function verifyMediaToken(relPath: string, token: string): boolean {
  return mediaToken(relPath) === token
}

export async function saveMedia(
  numberId: string,
  waMessageId: string,
  buffer: Buffer,
  mime: string,
  originalName?: string,
): Promise<MediaPayload> {
  const now = new Date()
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const safeId = waMessageId.replace(/[^A-Za-z0-9_-]/g, '')
  const ext = extForMime(mime)
  const relPath = join(numberId, month, `${safeId}.${ext}`)
  const absPath = join(config.MEDIA_DIR, relPath)

  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, buffer)

  return {
    path: relPath,
    mime,
    name: originalName !== undefined && originalName !== '' ? originalName : `${safeId}.${ext}`,
    size: buffer.length,
  }
}

export function absoluteMediaPath(relPath: string): string {
  return join(config.MEDIA_DIR, relPath)
}

/** Удаляет файлы старше MEDIA_TTL_DAYS. Вызывается по расписанию раз в сутки. */
export async function cleanupOldMedia(): Promise<number> {
  const cutoff = Date.now() - config.MEDIA_TTL_DAYS * 24 * 60 * 60 * 1000
  let removed = 0

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      const info = await stat(full)
      if (info.mtimeMs < cutoff) {
        await unlink(full)
        removed++
      }
    }
  }

  await walk(config.MEDIA_DIR)
  if (removed > 0) logger.info({ removed }, 'удалены старые медиафайлы')
  return removed
}
