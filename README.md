# Avito Notify

Cloudflare Worker, который получает новые входящие сообщения из Avito Messenger API и пересылает уведомления в Telegram.

## Что делает

- принимает webhook от Авито;
- игнорирует собственные исходящие сообщения;
- отправляет уведомление в Telegram;
- по возможности добавляет имя клиента и название объявления;
- не отвечает клиентам автоматически;
- не хранит секреты в GitHub.

## Secrets в Cloudflare

В Worker должны быть добавлены как **Secret**:

- `AVITO_CLIENT_ID`
- `AVITO_CLIENT_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `WEBHOOK_SECRET`

`WEBHOOK_SECRET` — любая длинная случайная строка. Она используется только для защиты webhook URL.

## Подключение webhook Авито

После деплоя один раз открой:

`https://avito-notify.teymurlannn.workers.dev/setup`

Если всё настроено правильно, Worker зарегистрирует webhook в Авито и отправит в Telegram сообщение:

`✅ Авито подключён`

Повторное открытие `/setup` безопасно: Worker сначала проверяет существующую подписку и не должен создавать дубль.

## Проверка работы

Открой корень Worker:

`https://avito-notify.teymurlannn.workers.dev/`

Нормальный ответ:

```json
{"ok":true,"service":"avito-notify","status":"running"}
```

Затем попроси кого-нибудь отправить тестовое сообщение на Авито. Уведомление должно прийти в Telegram.

## Безопасность

Никогда не добавляй реальные ключи и токены в `worker.js`, `wrangler.toml`, README или GitHub Secrets репозитория. Все рабочие ключи хранятся только в Cloudflare Workers → Settings → Variables and Secrets.
