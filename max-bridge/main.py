"""
Служба-переводчик между нашим сервисом и мессенджером MAX.

Зачем отдельным процессом: рабочая библиотека для личного аккаунта MAX
существует только на Python, а сервис написан на другом языке. Переписывать
чужой недокументированный протокол с нуля вышло бы дольше и держалось бы
хуже, поэтому библиотеку используем как есть, а разговариваем с ней
по простому HTTP внутри докер-сети. Наружу эта служба не смотрит.
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web
from pymax import WebClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("max-bridge")

# Номера событий протокола MAX. Нужны только для разбора «что именно пришло»:
# библиотека молча пропускает кадр, который не смогла разобрать, поэтому
# считаем кадры сами.
OPCODE_PING = 1
OPCODE_NOTIF_MESSAGE = 128

APP_URL = os.environ.get("APP_URL", "http://app:3000")
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "")
MEDIA_DIR = Path(os.environ.get("MEDIA_DIR", "/app/media"))
SESSION_DIR = Path(os.environ.get("SESSION_DIR", "/data"))
PORT = int(os.environ.get("PORT", "8090"))


@dataclass
class Session:
    channel_id: str
    client: WebClient | None = None
    task: asyncio.Task[Any] | None = None
    status: str = "new"
    qr_url: str | None = None
    phone: str = ""
    user_id: str = ""
    error: str = ""
    stopping: bool = False
    raw_events: int = 0
    messages_seen: int = 0
    notifs_seen: int = 0
    chats_known: int = 0
    unparsed_notifs: int = 0
    last_notif_at: float = 0.0
    opcodes: dict[str, int] = field(default_factory=dict)
    last_event_at: float = field(default_factory=time.time)
    reconnects: int = 0
    started_at: float = field(default_factory=time.time)


sessions: dict[str, Session] = {}


class QrCatcher:
    """Ловит ссылку QR вместо того, чтобы рисовать её в консоли."""

    def __init__(self, session: Session) -> None:
        self.session = session

    async def show_qr(self, qr_url: str) -> None:
        self.session.qr_url = qr_url
        self.session.status = "qr"
        log.info("канал %s: получен QR", self.session.channel_id)


def ext_for(mime: str, name: str | None) -> str:
    if name and "." in name:
        return name.rsplit(".", 1)[-1][:8]
    guessed = mimetypes.guess_extension(mime or "") or ".bin"
    return guessed.lstrip(".")


async def download_to_media(session: Session, url: str, message_id: str, mime: str, name: str | None) -> dict[str, Any] | None:
    """Скачивает вложение в общий том, чтобы сервис отдал его amoCRM ссылкой."""
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    safe_id = "".join(ch for ch in str(message_id) if ch.isalnum() or ch in "-_")
    rel = f"{session.channel_id}/{month}/{safe_id}.{ext_for(mime, name)}"
    dest = MEDIA_DIR / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        async with aiohttp.ClientSession() as http:
            async with http.get(url, timeout=aiohttp.ClientTimeout(total=180)) as resp:
                if resp.status != 200:
                    log.warning("вложение не скачалось: HTTP %s", resp.status)
                    return None
                data = await resp.read()
        dest.write_bytes(data)
        return {"path": rel, "mime": mime, "name": name or dest.name, "size": len(data)}
    except Exception as err:  # noqa: BLE001
        log.warning("вложение не скачалось: %s", err)
        return None


async def resolve_attachment(session: Session, msg: Any, att: Any) -> tuple[str, dict[str, Any] | None, str]:
    """Возвращает (наш тип, сведения о файле, подпись)."""
    kind = str(getattr(att, "type", "") or "").lower()
    client = session.client
    mid = str(getattr(msg, "id", ""))

    if "photo" in kind:
        url = getattr(att, "base_url", None)
        media = await download_to_media(session, url, mid, "image/jpeg", None) if url else None
        return "image", media, ""

    if "audio" in kind:
        url = getattr(att, "url", None)
        media = await download_to_media(session, url, mid, "audio/ogg", None) if url else None
        # В MAX голосовые и аудиофайлы приходят одним типом.
        return "voice", media, ""

    if "sticker" in kind:
        url = getattr(att, "url", None)
        media = await download_to_media(session, url, mid, "image/webp", None) if url else None
        return "sticker", media, ""

    if "video" in kind and client is not None:
        vid = getattr(att, "video_id", None)
        req = await client.get_video_by_id(msg.chat_id, msg.id, vid) if vid else None
        url = getattr(req, "url", None)
        media = await download_to_media(session, url, mid, "video/mp4", None) if url else None
        return "video", media, ""

    if "file" in kind and client is not None:
        fid = getattr(att, "file_id", None)
        req = await client.get_file_by_id(msg.chat_id, msg.id, fid) if fid else None
        url = getattr(req, "url", None)
        name = getattr(att, "name", None)
        mime = mimetypes.guess_type(name or "")[0] or "application/octet-stream"
        media = await download_to_media(session, url, mid, mime, name) if url else None
        return "document", media, ""

    if "contact" in kind:
        name = getattr(att, "name", None) or " ".join(
            x for x in [getattr(att, "first_name", ""), getattr(att, "last_name", "")] if x
        )
        return "contact", None, name

    if "share" in kind:
        return "text", None, str(getattr(att, "url", "") or "")

    return "unsupported", None, ""


async def forward_to_app(payload: dict[str, Any]) -> None:
    try:
        async with aiohttp.ClientSession() as http:
            async with http.post(
                f"{APP_URL}/internal/max/incoming",
                json=payload,
                headers={"X-Bridge-Secret": BRIDGE_SECRET},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status >= 300:
                    log.warning("сервис не принял сообщение: HTTP %s", resp.status)
    except Exception as err:  # noqa: BLE001
        log.error("не смог передать сообщение сервису: %s", err)


def make_client(session: Session) -> WebClient:
    client = WebClient(
        session_name=f"{session.channel_id}.db",
        work_dir=str(SESSION_DIR),
        qr_provider=QrCatcher(session),
    )

    @client.on_start()
    async def _on_start(c: WebClient) -> None:  # type: ignore[misc]
        session.status = "online"
        session.qr_url = None
        me = getattr(c, "me", None)
        contact = getattr(me, "contact", None) if me else None
        session.user_id = str(getattr(contact, "id", "") or "")
        session.phone = str(getattr(contact, "phone", "") or "")
        log.info("канал %s: MAX в сети (%s)", session.channel_id, session.phone or session.user_id)

        # После переподключения список чатов приходит пустым, и MAX перестаёт
        # присылать события по существующим перепискам: при первом входе
        # клиент видел 40 чатов, после переподключения — ноль, и сообщения
        # до нас не доходили. Поэтому список подтягиваем сами.
        for attempt in range(1, 4):
            try:
                chats = await c.fetch_chats()
                session.chats_known = len(list(chats))
            except Exception as err:  # noqa: BLE001
                session.chats_known = 0
                log.warning("канал %s: не удалось получить список чатов: %s",
                            session.channel_id, str(err)[:200])
            if session.chats_known > 0:
                log.info("канал %s: подписан на %s переписок",
                         session.channel_id, session.chats_known)
                break
            log.warning("канал %s: список чатов пуст, попытка %s из 3",
                        session.channel_id, attempt)
            await asyncio.sleep(3)

    @client.on_message()
    async def _on_message(message: Any, c: WebClient) -> None:  # type: ignore[misc]
        try:
            await handle_message(session, message)
        except Exception as err:  # noqa: BLE001
            log.exception("ошибка обработки входящего: %s", err)

    @client.on_raw()
    async def _on_raw(frame: Any, c: WebClient) -> None:  # type: ignore[misc]
        # Диагностика: показывает, доходят ли до нас события вообще.
        # Содержимое не пишем — только вид события.
        session.raw_events += 1
        session.last_event_at = time.time()

        opcode = getattr(frame, "opcode", None)
        if opcode == OPCODE_PING:
            return
        session.opcodes[str(opcode)] = session.opcodes.get(str(opcode), 0) + 1
        if opcode != OPCODE_NOTIF_MESSAGE:
            return

        # Сюда мы попадаем ровно тогда, когда MAX сообщил о новом сообщении.
        # Если следом не сработал обработчик — виновата не связь, а разбор
        # кадра библиотекой. Различить эти два случая иначе нельзя: библиотека
        # о неудачном разборе не сообщает.
        session.notifs_seen += 1
        session.last_notif_at = time.time()
        payload = getattr(frame, "payload", None) or {}
        log.info(
            "канал %s: MAX сообщил о новом сообщении (#%s), поля кадра: %s",
            session.channel_id,
            session.notifs_seen,
            ",".join(sorted(payload)) if isinstance(payload, dict) else type(payload).__name__,
        )
        try:
            from pymax.types import Message as MaxMessage

            MaxMessage.model_validate(payload)
        except Exception as err:  # noqa: BLE001
            session.unparsed_notifs += 1
            log.error(
                "канал %s: библиотека не смогла разобрать кадр, сообщение потеряно: %s",
                session.channel_id,
                str(err)[:400],
            )

    @client.on_disconnect()
    async def _on_disconnect(*args: Any) -> None:  # type: ignore[misc]
        # Библиотека зовёт этот обработчик с тремя значениями
        # (ошибка, будет ли переподключение, задержка). Раньше он принимал
        # одно, падал с TypeError на каждом разрыве — и канал так и оставался
        # числиться в сети, хотя связи уже не было.
        if session.stopping:
            return
        session.status = "offline"
        reason = str(args[0])[:200] if args else ""
        log.warning("канал %s: связь с MAX потеряна%s",
                    session.channel_id, f" ({reason})" if reason else "")

    return client


async def handle_message(session: Session, message: Any) -> None:
    session.messages_seen += 1
    chat_id = getattr(message, "chat_id", None)
    log.info(
        "канал %s: сообщение #%s (чат %s, есть текст: %s)",
        session.channel_id,
        session.messages_seen,
        chat_id,
        bool(getattr(message, "text", "")),
    )
    if chat_id is None:
        return

    msg_type = "text"
    media: dict[str, Any] | None = None
    text = getattr(message, "text", "") or ""

    attaches = list(getattr(message, "attaches", None) or [])
    if attaches:
        msg_type, media, extra = await resolve_attachment(session, message, attaches[0])
        if extra and not text:
            text = extra

    sender = getattr(message, "sender", None)
    from_me = str(sender) == session.user_id and session.user_id != ""

    await forward_to_app(
        {
            "channelId": session.channel_id,
            "externalMessageId": str(getattr(message, "id", "")),
            "externalChatId": str(chat_id),
            "senderId": str(sender or ""),
            "fromMe": from_me,
            "type": msg_type,
            "text": text,
            "media": media,
            "occurredAt": int(getattr(message, "time", 0) or 0),
        }
    )


# --- HTTP ---------------------------------------------------------------


def check_secret(request: web.Request) -> None:
    if BRIDGE_SECRET and request.headers.get("X-Bridge-Secret") != BRIDGE_SECRET:
        raise web.HTTPUnauthorized(text="bad secret")


async def start_channel(request: web.Request) -> web.Response:
    check_secret(request)
    cid = request.match_info["cid"]
    session = sessions.get(cid)
    if session and session.status in {"online", "connecting", "qr"}:
        return web.json_response({"status": session.status})

    session = Session(channel_id=cid, status="connecting")
    sessions[cid] = session
    session.client = make_client(session)

    async def run() -> None:
        try:
            await session.client.start()  # type: ignore[union-attr]
        except Exception as err:  # noqa: BLE001
            session.status = "offline"
            session.error = str(err)[:300]
            log.error("канал %s: %s", cid, session.error)

    session.task = asyncio.create_task(run())
    return web.json_response({"status": session.status})


async def status_channel(request: web.Request) -> web.Response:
    check_secret(request)
    session = sessions.get(request.match_info["cid"])
    if session is None:
        return web.json_response({"status": "new"})
    return web.json_response(
        {
            "status": session.status,
            "qrUrl": session.qr_url,
            "phone": session.phone,
            "userId": session.user_id,
            "error": session.error,
            "rawEvents": session.raw_events,
            "messagesSeen": session.messages_seen,
            "notifsSeen": session.notifs_seen,
            "chatsKnown": session.chats_known,
            "unparsedNotifs": session.unparsed_notifs,
            "lastNotifAgoSec": (
                round(time.time() - session.last_notif_at) if session.last_notif_at else None
            ),
            "opcodes": session.opcodes,
            "silenceSec": round(time.time() - session.last_event_at),
            "reconnects": session.reconnects,
        }
    )


async def send_message(request: web.Request) -> web.Response:
    check_secret(request)
    session = sessions.get(request.match_info["cid"])
    if session is None or session.client is None or session.status != "online":
        raise web.HTTPServiceUnavailable(text="канал не в сети")

    body = await request.json()
    chat_id = int(body["chatId"])
    text = body.get("text") or None
    reply_to = int(body["replyTo"]) if body.get("replyTo") else None
    attachments = None

    path = body.get("filePath")
    if path:
        from pymax.files import File, Photo, Video, Voice

        kind = (body.get("type") or "").lower()
        name = body.get("fileName")
        cls = {"image": Photo, "video": Video, "voice": Voice}.get(kind, File)
        attachments = [cls(path=path, name=name)]

    msg = await session.client.send_message(
        chat_id, text=text, reply_to=reply_to, attachments=attachments
    )
    return web.json_response({"messageId": str(getattr(msg, "id", ""))})


def dialog_id(session: Session, user_id: int) -> int:
    """
    Номер личной переписки в MAX.

    Отдельного «создать диалог» здесь нет: номер переписки двух людей
    считается из их собственных номеров, и по нему сразу можно писать,
    даже если разговора ещё не было. Правило взято из самой библиотеки
    (UserService.get_chat_id); если она его поменяет — спросим её.
    """
    client = session.client
    own = int(session.user_id or 0)
    getter = getattr(client, "get_chat_id", None)
    if callable(getter):
        return int(getter(user_id, own))
    return user_id ^ own


async def search_phone(request: web.Request) -> web.Response:
    """Найти собеседника по номеру — чтобы менеджер мог написать первым."""
    check_secret(request)
    session = sessions.get(request.match_info["cid"])
    if session is None or session.client is None or session.status != "online":
        raise web.HTTPServiceUnavailable(text="канал не в сети")
    phone = request.query.get("phone", "")
    try:
        user = await session.client.search_by_phone(phone)
    except Exception as err:  # noqa: BLE001
        # «Такого человека нет» библиотека сообщает исключением. Для нас это
        # обычный ответ: значит, в MAX его просто нет.
        log.info("канал %s: по номеру никого нет (%s)", session.channel_id, str(err)[:120])
        return web.json_response({"found": False})
    if user is None:
        return web.json_response({"found": False})
    uid = getattr(user, "id", None) or getattr(getattr(user, "contact", None), "id", None)
    if uid is None or not session.user_id:
        return web.json_response({"found": False})
    return web.json_response(
        {"found": True, "userId": str(uid), "chatId": str(dialog_id(session, int(uid)))}
    )


async def stop_channel(request: web.Request) -> web.Response:
    check_secret(request)
    session = sessions.pop(request.match_info["cid"], None)
    if session is not None:
        session.stopping = True
        try:
            if session.client is not None:
                await session.client.stop()
        except Exception:  # noqa: BLE001
            pass
        if session.task is not None:
            session.task.cancel()
    return web.json_response({"ok": True})


async def recent_chats(request: web.Request) -> web.Response:
    """Последние переписки аккаунта — проверка, что связь действительно живая."""
    check_secret(request)
    session = sessions.get(request.match_info["cid"])
    if session is None or session.client is None:
        raise web.HTTPServiceUnavailable(text="канал не в сети")
    chats = await session.client.fetch_chats()
    out = []
    for c in list(chats)[:10]:
        last = getattr(c, "last_message", None)
        out.append(
            {
                "chatId": getattr(c, "id", None),
                "title": getattr(c, "title", None),
                "lastText": (getattr(last, "text", "") or "")[:40] if last else "",
                "lastTime": getattr(last, "time", None) if last else None,
            }
        )
    return web.json_response({"chats": out})


# MAX присылает «пульс» примерно раз в 30 секунд. Если его нет несколько
# минут — связь оборвалась. Библиотека при этом молчит: за сутки работы она
# ни разу не сообщила о разрыве, хотя сообщения до нас не доходили.
HEARTBEAT_TIMEOUT = 180.0
WATCHDOG_PERIOD = 60.0


async def watchdog() -> None:
    while True:
        await asyncio.sleep(WATCHDOG_PERIOD)
        for cid, session in list(sessions.items()):
            if session.stopping or session.status != "online":
                continue
            silence = time.time() - session.last_event_at
            if silence < HEARTBEAT_TIMEOUT:
                continue

            log.warning("канал %s: тишина %.0f сек, переподключаюсь", cid, silence)
            session.reconnects += 1
            session.status = "connecting"
            try:
                if session.client is not None:
                    await session.client.stop()
            except Exception:  # noqa: BLE001
                pass
            if session.task is not None:
                session.task.cancel()

            session.client = make_client(session)
            session.last_event_at = time.time()

            async def run(s: Session = session) -> None:
                try:
                    await s.client.start()  # type: ignore[union-attr]
                except Exception as err:  # noqa: BLE001
                    s.status = "offline"
                    s.error = str(err)[:300]
                    log.error("канал %s: переподключение не удалось: %s", s.channel_id, s.error)

            session.task = asyncio.create_task(run())


async def on_startup(app: web.Application) -> None:
    app["watchdog"] = asyncio.create_task(watchdog())


async def health(_: web.Request) -> web.Response:
    return web.json_response(
        {
            "ok": True,
            "channels": {
                c: {
                    "status": s.status,
                    "silenceSec": round(time.time() - s.last_event_at),
                    "messagesSeen": s.messages_seen,
                    "notifsSeen": s.notifs_seen,
                    "chatsKnown": s.chats_known,
                    "unparsedNotifs": s.unparsed_notifs,
                    "reconnects": s.reconnects,
                }
                for c, s in sessions.items()
            },
        }
    )


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_post("/channels/{cid}/start", start_channel)
    app.router.add_get("/channels/{cid}/status", status_channel)
    app.router.add_post("/channels/{cid}/send", send_message)
    app.router.add_get("/channels/{cid}/search", search_phone)
    app.router.add_post("/channels/{cid}/stop", stop_channel)
    app.router.add_get("/channels/{cid}/chats", recent_chats)
    app.on_startup.append(on_startup)
    return app


if __name__ == "__main__":
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    log.info("служба MAX слушает порт %s", PORT)
    web.run_app(build_app(), port=PORT, access_log=None)
