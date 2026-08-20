/**
 * Миграции держим строками в коде, а не .sql-файлами: так они гарантированно
 * попадают в собранный образ и не зависят от копирования ассетов.
 * Добавлять только в конец, существующие не править.
 */
export interface Migration {
  name: string
  sql: string
}

export const migrations: Migration[] = [
  {
    name: '001_init',
    sql: `
      create extension if not exists "pgcrypto";

      create table if not exists wa_numbers (
        id                     uuid primary key default gen_random_uuid(),
        label                  text not null,
        phone                  text unique,
        jid                    text,
        status                 text not null default 'new',
        last_qr                text,
        last_qr_at             timestamptz,
        last_connected_at      timestamptz,
        last_disconnect_reason text,
        deleted_at             timestamptz,
        created_at             timestamptz not null default now(),
        updated_at             timestamptz not null default now()
      );

      create table if not exists wa_auth_state (
        number_id  uuid not null references wa_numbers(id) on delete cascade,
        key        text not null,
        value      jsonb not null,
        updated_at timestamptz not null default now(),
        primary key (number_id, key)
      );

      create table if not exists chats (
        id                bigserial primary key,
        number_id         uuid not null references wa_numbers(id) on delete cascade,
        chat_jid          text not null,
        phone             text,
        push_name         text,
        avatar_url        text,
        is_group          boolean not null default false,
        ignored           boolean not null default false,
        amo_chat_id       text,
        amo_conversation  text,
        amo_contact_id    bigint,
        amo_lead_id       bigint,
        first_outbound_at timestamptz,
        last_message_at   timestamptz,
        created_at        timestamptz not null default now(),
        updated_at        timestamptz not null default now(),
        unique (number_id, chat_jid)
      );
      create index if not exists chats_phone_idx on chats (phone);

      create table if not exists messages (
        id                    bigserial primary key,
        number_id             uuid not null references wa_numbers(id) on delete cascade,
        chat_id               bigint references chats(id) on delete cascade,
        wa_message_id         text,
        amo_message_id        text,
        direction             text not null,
        type                  text not null,
        body                  text,
        media_path            text,
        media_mime            text,
        media_name            text,
        media_size            bigint,
        quoted_wa_message_id  text,
        sender_name           text,
        status                text not null default 'received',
        error                 text,
        sent_at               timestamptz,
        delivered_at          timestamptz,
        read_at               timestamptz,
        occurred_at           timestamptz not null,
        created_at            timestamptz not null default now()
      );
      create unique index if not exists messages_wa_uniq
        on messages (number_id, wa_message_id, direction)
        where wa_message_id is not null;
      create unique index if not exists messages_amo_uniq
        on messages (amo_message_id)
        where amo_message_id is not null;
      create index if not exists messages_status_idx on messages (status, created_at desc);
      create index if not exists messages_chat_idx on messages (chat_id, occurred_at desc);

      create table if not exists outbound_daily (
        number_id uuid not null references wa_numbers(id) on delete cascade,
        day       date not null,
        new_chats integer not null default 0,
        primary key (number_id, day)
      );

      create table if not exists settings (
        key        text primary key,
        value      jsonb not null,
        updated_at timestamptz not null default now()
      );
    `,
  },
  {
    name: '002_multichannel',
    sql: `
      -- Платформа не про «номера WhatsApp», а про подключённые каналы:
      -- WhatsApp, Телеграм, MAX и что появится дальше. Убираем из основы
      -- слова, привязанные к одному мессенджеру.
      alter table wa_numbers rename to channels;
      alter table channels rename column jid to external_id;
      alter table channels add column if not exists kind text not null default 'whatsapp';

      alter table wa_auth_state rename to channel_auth_state;
      alter table channel_auth_state rename column number_id to channel_id;

      alter table chats rename column number_id to channel_id;
      alter table chats rename column chat_jid to external_chat_id;

      alter table messages rename column number_id to channel_id;
      alter table messages rename column wa_message_id to external_message_id;
      alter table messages rename column quoted_wa_message_id to quoted_external_message_id;
      drop index if exists messages_wa_uniq;
      create unique index if not exists messages_external_uniq
        on messages (channel_id, external_message_id, direction)
        where external_message_id is not null;
      alter table outbound_daily rename column number_id to channel_id;

      -- Один и тот же телефон может быть и в WhatsApp, и в Телеграме,
      -- поэтому телефон уникален в паре с типом канала, а не сам по себе.
      alter table channels drop constraint if exists wa_numbers_phone_key;
      create unique index if not exists channels_kind_phone_uniq
        on channels (kind, phone) where phone is not null;

      create index if not exists channels_kind_idx on channels (kind);
    `,
  },
  {
    name: '003_amo_started_chat',
    sql: `
      -- Когда менеджер пишет из карточки, в которой переписки ещё не было,
      -- amoCRM заводит свою беседу — с идентификатором, которого мы не
      -- знали. Ответ клиента нужно класть именно в неё: иначе он попадёт
      -- в отдельную беседу, а amoCRM заведёт под неё вторую сделку.
      -- Колонка была заведена в самом начале и ни разу не использовалась,
      -- поэтому просто даём ей верное имя.
      alter table chats rename column amo_conversation to amo_started_chat_id;
    `,
  },
  {
    name: '004_amo_conversation_key',
    sql: `
      -- Имя, под которым amoCRM знает нашу переписку. Обычно оно строится
      -- из номера переписки, но иногда приходится завести новое: если
      -- карточку удалили, беседа остаётся привязанной к ней навсегда —
      -- перевесить её amoCRM не разрешает, а сообщения в неё уходят
      -- в никуда. Тогда заводим беседу заново, под новым именем.
      alter table chats add column if not exists amo_conversation_key text;
    `,
  },
]
