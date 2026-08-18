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
]
