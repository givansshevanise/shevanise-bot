const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

const { TELEGRAM_TOKEN, NOTION_API_KEY, DATABASE_ID } = process.env;

if (!TELEGRAM_TOKEN) {
  throw new Error("Missing TELEGRAM_TOKEN environment variable.");
}

if (!NOTION_API_KEY) {
  throw new Error("Missing NOTION_API_KEY environment variable.");
}

if (!DATABASE_ID) {
  throw new Error("Missing DATABASE_ID environment variable.");
}

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

const panelState = new Map();

const ACTIONS = {
  START: "start",
  FINANCE: "finance",
  ADD_EXPENSE: "add_expense",
  TRANSPORT: "transport",
  PET_FOOD: "pet_food",
  BACK_HOME: "back_home",
  BACK_FINANCE: "back_finance",
  BACK_ADD_EXPENSE: "back_add_expense",
  SAVE_TRANSPORT_TO_PAPINE: "save_transport_to_papine",
  SAVE_TRANSPORT_FROM_PAPINE: "save_transport_from_papine",
  SAVE_CAT_FOOD: "save_cat_food",
  PET_FOOD_PLACEHOLDER: "pet_food_placeholder"
};

const ITEMS = {
  [ACTIONS.SAVE_TRANSPORT_TO_PAPINE]: {
    name: "Travel to Papine",
    amount: 200,
    category: "Transport"
  },
  [ACTIONS.SAVE_TRANSPORT_FROM_PAPINE]: {
    name: "Travel from Papine",
    amount: 200,
    category: "Transport"
  },
  [ACTIONS.SAVE_CAT_FOOD]: {
    name: "Cat Food",
    amount: 500,
    category: "Food"
  }
};

function normalizeNotionDatabaseId(rawValue) {
  if (!rawValue) {
    throw new Error("Missing DATABASE_ID environment variable.");
  }

  const trimmed = rawValue.trim();
  const urlMatch = trimmed.match(/[0-9a-fA-F]{32}|[0-9a-fA-F-]{36}/);
  const candidate = urlMatch ? urlMatch[0].replace(/-/g, "") : trimmed.replace(/-/g, "");

  if (!/^[0-9a-fA-F]{32}$/.test(candidate)) {
    throw new Error("DATABASE_ID must be a Notion database ID or a Notion database URL.");
  }

  return [
    candidate.slice(0, 8),
    candidate.slice(8, 12),
    candidate.slice(12, 16),
    candidate.slice(16, 20),
    candidate.slice(20)
  ].join("-");
}

const notionDatabaseId = normalizeNotionDatabaseId(DATABASE_ID);

function getPanelState(chatId) {
  const existing = panelState.get(chatId);
  if (existing) {
    return existing;
  }

  const initial = {
    messageId: null,
    returnTimer: null
  };

  panelState.set(chatId, initial);
  return initial;
}

function clearReturnTimer(chatId) {
  const state = getPanelState(chatId);
  if (state.returnTimer) {
    clearTimeout(state.returnTimer);
    state.returnTimer = null;
  }
}

function homePanel() {
  return {
    text: "Hey Shevanise 👋\nWhat would you like to do?",
    reply_markup: {
      inline_keyboard: [[{ text: "💰 Finance Tracker", callback_data: ACTIONS.FINANCE }]]
    }
  };
}

function financePanel() {
  return {
    text: "💰 Finance Tracker\nChoose an option:",
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Add Expense", callback_data: ACTIONS.ADD_EXPENSE }],
        [{ text: "🔙 Back", callback_data: ACTIONS.BACK_HOME }]
      ]
    }
  };
}

function addExpensePanel() {
  return {
    text: "🔎 Search or select an expense",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚕 Transport", callback_data: ACTIONS.TRANSPORT }],
        [{ text: "🐱 Pet Food", callback_data: ACTIONS.PET_FOOD }],
        [{ text: "🔙 Back", callback_data: ACTIONS.BACK_FINANCE }]
      ]
    }
  };
}

function transportPanel() {
  return {
    text: "🚕 Transport Options",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Travel to Papine ($200)", callback_data: ACTIONS.SAVE_TRANSPORT_TO_PAPINE }],
        [{ text: "Travel from Papine ($200)", callback_data: ACTIONS.SAVE_TRANSPORT_FROM_PAPINE }],
        [{ text: "🔙 Back", callback_data: ACTIONS.BACK_ADD_EXPENSE }]
      ]
    }
  };
}

function petFoodPanel() {
  return {
    text: "🐱 Pet Food Options",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Cat Food ($500)", callback_data: ACTIONS.SAVE_CAT_FOOD }],
        [{ text: "➕ Add New Item (future support placeholder)", callback_data: ACTIONS.PET_FOOD_PLACEHOLDER }],
        [{ text: "🔙 Back", callback_data: ACTIONS.BACK_ADD_EXPENSE }]
      ]
    }
  };
}

function placeholderPanel() {
  return {
    text: "🐱 Pet Food Options\nAdd New Item is not available yet.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Cat Food ($500)", callback_data: ACTIONS.SAVE_CAT_FOOD }],
        [{ text: "➕ Add New Item (future support placeholder)", callback_data: ACTIONS.PET_FOOD_PLACEHOLDER }],
        [{ text: "🔙 Back", callback_data: ACTIONS.BACK_ADD_EXPENSE }]
      ]
    }
  };
}

async function editPanel(chatId, panel) {
  const state = getPanelState(chatId);
  if (!state.messageId) {
    throw new Error(`No persistent panel message_id stored for chat ${chatId}.`);
  }

  try {
    await bot.editMessageText(panel.text, {
      chat_id: chatId,
      message_id: state.messageId,
      reply_markup: panel.reply_markup
    });
  } catch (error) {
    // Telegram returns this when the content is unchanged; this is harmless.
    if (
      error.response &&
      error.response.body &&
      error.response.body.description === "Bad Request: message is not modified"
    ) {
      return;
    }
    throw error;
  }
}

async function ensureStartPanel(chatId) {
  const state = getPanelState(chatId);
  clearReturnTimer(chatId);

  if (state.messageId) {
    await editPanel(chatId, homePanel());
    return;
  }

  const sent = await bot.sendMessage(chatId, homePanel().text, {
    reply_markup: homePanel().reply_markup
  });

  state.messageId = sent.message_id;
}

async function notionRequest(path, options = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
      ...(options.headers || {})
    }
  });

  const rawText = await response.text();
  let body = null;

  if (rawText) {
    try {
      body = JSON.parse(rawText);
    } catch (error) {
      body = rawText;
    }
  }

  if (!response.ok) {
    const detail =
      body && typeof body === "object"
        ? JSON.stringify(body)
        : String(body || rawText || "Unknown Notion error");

    throw new Error(`Notion API error ${response.status}: ${detail}`);
  }

  return body;
}

async function ensureDatabaseSchema(item) {
  const database = await notionRequest(`/databases/${notionDatabaseId}`, {
    method: "GET"
  });

  const properties = database.properties || {};
  const selectValueMap = {
    Category: item.category,
    Essential: "Yes",
    "Payment Method": "Cash",
    Type: "Expense"
  };

  for (const [propertyName, optionName] of Object.entries(selectValueMap)) {
    const property = properties[propertyName];
    if (!property || property.type !== "select") {
      continue;
    }

    const hasOption = (property.select.options || []).some((option) => option.name === optionName);
    if (hasOption) {
      continue;
    }

    const nextProperties = {
      ...properties,
      [propertyName]: {
        ...property,
        select: {
          ...property.select,
          options: [...(property.select.options || []), { name: optionName }]
        }
      }
    };

    await notionRequest(`/databases/${notionDatabaseId}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: database.title,
        properties: nextProperties
      })
    });
  }
}

async function saveExpenseToNotion(item) {
  await ensureDatabaseSchema(item);

  await notionRequest("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: {
        database_id: notionDatabaseId
      },
      properties: {
        Name: {
          title: [
            {
              text: {
                content: item.name
              }
            }
          ]
        },
        Amount: {
          number: item.amount
        },
        Category: {
          select: {
            name: item.category
          }
        },
        Essential: {
          select: {
            name: "Yes"
          }
        },
        "Payment Method": {
          select: {
            name: "Cash"
          }
        },
        Type: {
          select: {
            name: "Expense"
          }
        },
        Date: {
          date: {
            start: new Date().toISOString()
          }
        }
      }
    })
  });
}

async function showSavedState(chatId, item) {
  await editPanel(chatId, {
    text: `✅ Saved:\n${item.name} - $${item.amount}`,
    reply_markup: {
      inline_keyboard: []
    }
  });

  const state = getPanelState(chatId);
  clearReturnTimer(chatId);

  state.returnTimer = setTimeout(() => {
    editPanel(chatId, addExpensePanel()).catch((error) => {
      console.error("Failed to restore Add Expense panel:", error);
    });
    state.returnTimer = null;
  }, 1500);
}

async function showSavingState(chatId, item) {
  await editPanel(chatId, {
    text: `⏳ Saving...\n${item.name} - $${item.amount}`,
    reply_markup: {
      inline_keyboard: []
    }
  });
}

function getUserFacingErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "");

  if (message.includes("object_not_found")) {
    return "Notion database not found or not shared.";
  }

  if (message.includes("unauthorized")) {
    return "Invalid Notion API key.";
  }

  if (message.includes("validation_error")) {
    return "Database properties do not match required names/types.";
  }

  if (message.includes("DATABASE_ID")) {
    return "Invalid DATABASE_ID value.";
  }

  if (message.includes("Missing NOTION_API_KEY")) {
    return "Missing NOTION_API_KEY.";
  }

  if (message.includes("fetch")) {
    return "Network error reaching Notion.";
  }

  return "Check Railway logs for Notion error details.";
}

async function showSaveError(chatId, error) {
  clearReturnTimer(chatId);
  const reason = getUserFacingErrorMessage(error);
  await editPanel(chatId, {
    text: `❌ Failed to save.\n${reason}`,
    reply_markup: {
      inline_keyboard: [[{ text: "🔙 Back", callback_data: ACTIONS.BACK_ADD_EXPENSE }]]
    }
  });
}

async function handleAction(chatId, action) {
  switch (action) {
    case ACTIONS.START:
    case ACTIONS.BACK_HOME:
      await editPanel(chatId, homePanel());
      return;
    case ACTIONS.FINANCE:
      await editPanel(chatId, financePanel());
      return;
    case ACTIONS.ADD_EXPENSE:
      await editPanel(chatId, addExpensePanel());
      return;
    case ACTIONS.TRANSPORT:
      await editPanel(chatId, transportPanel());
      return;
    case ACTIONS.PET_FOOD:
      await editPanel(chatId, petFoodPanel());
      return;
    case ACTIONS.BACK_FINANCE:
      await editPanel(chatId, financePanel());
      return;
    case ACTIONS.BACK_ADD_EXPENSE:
      await editPanel(chatId, addExpensePanel());
      return;
    case ACTIONS.PET_FOOD_PLACEHOLDER:
      await editPanel(chatId, placeholderPanel());
      return;
    default:
      if (!ITEMS[action]) {
        await editPanel(chatId, homePanel());
        return;
      }

      try {
        await showSavingState(chatId, ITEMS[action]);
        await saveExpenseToNotion(ITEMS[action]);
        await showSavedState(chatId, ITEMS[action]);
      } catch (error) {
        console.error("Failed to save expense:", error);
        await showSaveError(chatId, error);
      }
  }
}

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    if (msg.message_id) {
      await bot.deleteMessage(chatId, String(msg.message_id)).catch(() => {});
    }
    await ensureStartPanel(chatId);
  } catch (error) {
    console.error("Failed to initialize start panel:", error);
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message && query.message.chat ? query.message.chat.id : null;
  const action = query.data;

  if (!chatId || !action) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  const state = getPanelState(chatId);
  if (!state.messageId && query.message && query.message.message_id) {
    state.messageId = query.message.message_id;
  }

  clearReturnTimer(chatId);

  try {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await handleAction(chatId, action);
  } catch (error) {
    console.error("Callback handling failed:", error);

    try {
      await showSaveError(chatId, error);
    } catch (panelError) {
      console.error("Failed to render error panel:", panelError);
    }
  }
});

bot.on("polling_error", (error) => {
  console.error("Polling error:", error);
});

console.log("Using Notion database:", notionDatabaseId);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    try {
      await bot.stopPolling();
    } catch (error) {
      console.error(`Failed to stop polling on ${signal}:`, error);
    } finally {
      process.exit(0);
    }
  });
}

console.log("Telegram bot is running in polling mode.");
