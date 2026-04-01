import { apiRequest } from "./http-client.js";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_BUFFERED_UPDATES = 200;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    date?: number;
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string; is_bot?: boolean; username?: string };
    reply_to_message?: { message_id?: number; chat?: { id?: number | string } };
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number | string; is_bot?: boolean; username?: string };
    message?: {
      message_id?: number;
      chat?: { id?: number | string; type?: string };
    };
  };
}

interface StreamState {
  latestUpdateId: number;
  fetching: Promise<void> | null;
  history: TelegramUpdate[];
  consumerOffsets: Map<string, number>;
}

const streams = new Map<string, StreamState>();

function getState(token: string): StreamState {
  let state = streams.get(token);
  if (!state) {
    state = {
      latestUpdateId: 0,
      fetching: null,
      history: [],
      consumerOffsets: new Map(),
    };
    streams.set(token, state);
  }
  return state;
}

export async function telegramPullUpdates(
  token: string,
  consumerId: string,
  allowedUpdates: string[] = ["message", "callback_query"],
): Promise<TelegramUpdate[]> {
  const state = getState(token);
  await syncTelegramUpdates(token, allowedUpdates);

  const lastSeen = state.consumerOffsets.get(consumerId) ?? 0;
  const unseen = state.history.filter((u) => u.update_id > lastSeen);
  if (unseen.length > 0) {
    state.consumerOffsets.set(consumerId, unseen[unseen.length - 1].update_id);
  }
  return unseen;
}

export async function telegramSyncLatestUpdateId(
  token: string,
  allowedUpdates: string[] = ["message", "callback_query"],
): Promise<number> {
  await syncTelegramUpdates(token, allowedUpdates);
  return getState(token).latestUpdateId;
}

export function telegramMarkConsumerSeen(token: string, consumerId: string, updateId: number): void {
  const state = getState(token);
  state.consumerOffsets.set(consumerId, updateId);
}

async function syncTelegramUpdates(token: string, allowedUpdates: string[]): Promise<void> {
  const state = getState(token);
  if (state.fetching) {
    await state.fetching;
    return;
  }

  state.fetching = (async () => {
    const res = await apiRequest(
      `${TELEGRAM_API}/bot${token}/getUpdates`,
      "POST",
      {
        offset: state.latestUpdateId + 1,
        timeout: 0,
        allowed_updates: allowedUpdates,
      },
      { errorLabel: "Telegram API" },
    );

    if (!res?.ok || !Array.isArray(res.result)) return;

    for (const update of res.result as TelegramUpdate[]) {
      if (typeof update.update_id !== "number") continue;
      if (update.update_id > state.latestUpdateId) state.latestUpdateId = update.update_id;
      state.history.push(update);
    }

    if (state.history.length > MAX_BUFFERED_UPDATES) {
      state.history.splice(0, state.history.length - MAX_BUFFERED_UPDATES);
    }
  })();

  try {
    await state.fetching;
  } finally {
    state.fetching = null;
  }
}
