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
  channelId: string,
  externalMessageId: string,
  buffer: Buffer,
  mime: string,
  originalName?: string,
): Promise<MediaPayload> {
  const now = new Date()
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const safeId = externalMessageId.replace(/[^A-Za-z0-9_-]/g, '')
  const ext = extForMime(mime)
  const relPath = join(channelId, month, `${safeId}.${ext}`)
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

/**
 * Готовит вложение к отправке: путь к файлу на диске.
 *
 * amoCRM присылает не файл, а ссылку на своё хранилище — и она закрыта
 * для посторонних. Мессенджеру такую ссылку давать нельзя: он пойдёт
 * качать сам, получит отказ и вернёт непонятную ошибку. Телеграм отвечает
 * на это WEBPAGE_CURL_FAILED, MAX — молча падает. Поэтому файл скачиваем
 * сами и передаём уже готовым.
 */
export async function outgoingLocalFile(
  channelId: string,
  out: { mediaPath?: string; mediaMime?: string; mediaName?: string },
): Promise<string | undefined> {
  const path = out.mediaPath
  if (path === undefined || path === '') return undefined
  if (!path.startsWith('http')) return absoluteMediaPath(path)

  const response = await fetch(path)
  if (!response.ok) {
    throw new Error(`вложение не скачалось из amoCRM: HTTP ${response.status}`)
  }
  const mime = out.mediaMime ?? response.headers.get('content-type') ?? 'application/octet-stream'
  const buffer = Buffer.from(await response.arrayBuffer())
  const name = out.mediaName ?? `вложение.${extForMime(mime)}`
  const saved = await saveMedia(channelId, `out-${Date.now()}`, buffer, mime, name)
  return absoluteMediaPath(saved.path)
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
