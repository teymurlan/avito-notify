let cachedAvitoToken = null;
let cachedAvitoTokenExpiresAt = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        ok: true,
        service: "avito-notify",
        status: "running",
      });
    }

    if (url.pathname === "/setup") {
      try {
        assertEnv(env, [
          "AVITO_CLIENT_ID",
          "AVITO_CLIENT_SECRET",
          "TELEGRAM_BOT_TOKEN",
          "TELEGRAM_CHAT_ID",
          "WEBHOOK_SECRET",
        ]);

        const webhookUrl = `${url.origin}/webhook?secret=${encodeURIComponent(env.WEBHOOK_SECRET)}`;
        const token = await getAvitoToken(env);

        // Проверяем, не подключён ли уже этот webhook, чтобы не создавать дубли.
        const subscriptionsResponse = await avitoFetch(
          env,
          "https://api.avito.ru/messenger/v1/subscriptions",
          { method: "POST" },
          token
        );

        if (subscriptionsResponse.ok) {
          const subscriptionsData = await subscriptionsResponse.json();
          const subscriptions = Array.isArray(subscriptionsData?.subscriptions)
            ? subscriptionsData.subscriptions
            : [];

          const alreadySubscribed = subscriptions.some(
            (item) => item?.url === webhookUrl && String(item?.version) === "3"
          );

          if (alreadySubscribed) {
            return json({
              ok: true,
              status: "already_subscribed",
            });
          }
        }

        const subscribeResponse = await avitoFetch(
          env,
          "https://api.avito.ru/messenger/v3/webhook",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ url: webhookUrl }),
          },
          token
        );

        const subscribeBody = await readResponseBody(subscribeResponse);

        if (!subscribeResponse.ok) {
          return json(
            {
              ok: false,
              step: "avito_webhook_subscribe",
              status: subscribeResponse.status,
              details: subscribeBody,
            },
            subscribeResponse.status
          );
        }

        await sendTelegram(
          env,
          "✅ Авито подключён\n\nТеперь новые входящие сообщения будут приходить сюда 🔔"
        );

        return json({
          ok: true,
          status: "subscribed",
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: errorMessage(error),
          },
          500
        );
      }
    }

    if (url.pathname === "/webhook") {
      if (!env.WEBHOOK_SECRET) {
        return new Response("Webhook secret is not configured", { status: 503 });
      }

      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }

      if (request.method !== "POST") {
        return json({ ok: true });
      }

      let event;

      try {
        event = await request.json();
      } catch {
        // Авито ожидает быстрый 2xx. Некорректный JSON просто игнорируем.
        return json({ ok: true });
      }

      ctx.waitUntil(processAvitoEvent(event, env));

      return json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function processAvitoEvent(event, env) {
  try {
    const payload = event?.payload;

    if (!payload || payload.type !== "message") {
      return;
    }

    const message = payload.value;

    if (!message) {
      return;
    }

    // user_id — аккаунт, на который зарегистрирован webhook.
    // Если author_id совпадает с ним, сообщение отправили мы сами.
    if (
      message.author_id != null &&
      message.user_id != null &&
      String(message.author_id) === String(message.user_id)
    ) {
      return;
    }

    const messageText = describeMessage(message);
    let clientName = "";
    let adTitle = "";

    // Дополнительные данные чата не должны мешать основному уведомлению.
    try {
      if (message.user_id != null && message.chat_id) {
        const chatResponse = await avitoFetch(
          env,
          `https://api.avito.ru/messenger/v2/accounts/${encodeURIComponent(
            String(message.user_id)
          )}/chats/${encodeURIComponent(String(message.chat_id))}`,
          { method: "GET" }
        );

        if (chatResponse.ok) {
          const chat = await chatResponse.json();

          adTitle =
            chat?.context?.value?.title ||
            chat?.context?.value?.text ||
            "";

          if (Array.isArray(chat?.users)) {
            const client = chat.users.find(
              (user) => String(user?.id) === String(message.author_id)
            );

            clientName = client?.name || "";
          }
        }
      }
    } catch (error) {
      console.error("Failed to load Avito chat details", error);
    }

    const lines = ["🔔 НОВОЕ СООБЩЕНИЕ С АВИТО", ""];

    if (clientName) {
      lines.push(`👤 Клиент: ${clientName}`);
    }

    if (adTitle) {
      lines.push(`📋 Объявление: ${adTitle}`);
    } else if (message.item_id != null) {
      lines.push(`📋 ID объявления: ${message.item_id}`);
    }

    lines.push("", "💬 Сообщение:", truncate(messageText, 3000));

    await sendTelegram(env, lines.join("\n"));
  } catch (error) {
    console.error("Webhook processing error", error);
  }
}

function describeMessage(message) {
  switch (message?.type) {
    case "text":
      return message?.content?.text || "Новое текстовое сообщение";
    case "image":
      return "📷 Клиент отправил фотографию";
    case "voice":
      return "🎤 Клиент отправил голосовое сообщение";
    case "video":
      return "🎥 Клиент отправил видео";
    case "location":
      return "📍 Клиент отправил геолокацию";
    case "call":
      return "📞 Новое событие звонка";
    case "link":
      return (
        message?.content?.link?.text ||
        message?.content?.link?.url ||
        "🔗 Клиент отправил ссылку"
      );
    case "file":
      return "📎 Клиент отправил файл";
    case "deleted":
      return "Сообщение было удалено";
    default:
      return `Новое сообщение${message?.type ? ` (${message.type})` : ""}`;
  }
}

async function getAvitoToken(env, forceRefresh = false) {
  const now = Date.now();

  if (
    !forceRefresh &&
    cachedAvitoToken &&
    cachedAvitoTokenExpiresAt > now + 60_000
  ) {
    return cachedAvitoToken;
  }

  assertEnv(env, ["AVITO_CLIENT_ID", "AVITO_CLIENT_SECRET"]);

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", env.AVITO_CLIENT_ID);
  body.set("client_secret", env.AVITO_CLIENT_SECRET);

  const response = await fetch("https://api.avito.ru/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await readResponseBody(response);

  if (!response.ok || !data?.access_token) {
    throw new Error(
      `Не удалось получить токен Авито: ${response.status} ${stringifySafe(data)}`
    );
  }

  cachedAvitoToken = data.access_token;
  const expiresInSeconds = Number(data.expires_in) || 86400;
  cachedAvitoTokenExpiresAt =
    Date.now() + Math.max(expiresInSeconds - 120, 60) * 1000;

  return cachedAvitoToken;
}

async function avitoFetch(env, url, options = {}, providedToken = null) {
  let token = providedToken || (await getAvitoToken(env));
  let response = await fetchWithBearer(url, options, token);

  if (response.status === 401) {
    cachedAvitoToken = null;
    cachedAvitoTokenExpiresAt = 0;
    token = await getAvitoToken(env, true);
    response = await fetchWithBearer(url, options, token);
  }

  return response;
}

async function fetchWithBearer(url, options, token) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);

  return fetch(url, {
    ...options,
    headers,
  });
}

async function sendTelegram(env, text) {
  assertEnv(env, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: truncate(text, 3900),
        disable_web_page_preview: true,
      }),
    }
  );

  if (!response.ok) {
    const body = await readResponseBody(response);
    throw new Error(
      `Ошибка Telegram: ${response.status} ${stringifySafe(body)}`
    );
  }
}

function assertEnv(env, names) {
  const missing = names.filter((name) => !env?.[name]);

  if (missing.length) {
    throw new Error(`Не заданы Secrets: ${missing.join(", ")}`);
  }
}

async function readResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function truncate(value, maxLength) {
  const text = String(value ?? "");

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function stringifySafe(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
