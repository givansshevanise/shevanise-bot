const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

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

const STEPS = {
  HOME: "home",
  FINANCE: "finance",
  SEARCH: "search",
  SEARCH_RESULTS: "search_results",
  ADDING_ITEM_NAME: "adding_item_name",
  ADDING_ITEM_AMOUNT: "adding_item_amount",
  ADDING_ITEM_CATEGORY: "adding_item_category",
  ITEM_SELECTED: "item_selected",
  AWAITING_AMOUNT: "awaiting_amount",
  CONFIRM: "confirm",
  RECEIPT_CHOICE: "receipt_choice",
  AWAITING_RECEIPT: "awaiting_receipt",
  REMINDER: "reminder"
};

const ACTIONS = {
  FINANCE: "finance",
  ADD_EXPENSE: "add_expense",
  GO_BACK: "go_back",
  SELECT_ITEM: "select_item",
  ADD_NEW_ITEM: "add_new_item",
  ADJUST_AMOUNT: "adjust_amount",
  KEEP_SAME: "keep_same",
  CONFIRM_EXPENSE: "confirm_expense",
  CANCEL_EXPENSE: "cancel_expense",
  RECEIPT_YES: "receipt_yes",
  RECEIPT_NO: "receipt_no",
  RECEIPT_SKIP: "receipt_skip"
};

const DEFAULT_ITEMS = [
  { name: "Travel to Papine", amount: 200, category: "Transport" },
  { name: "Travel from Papine", amount: 200, category: "Transport" },
  { name: "Cat Food", amount: 500, category: "Food" }
];
const ITEMS_FILE = path.join(__dirname, "items.json");
const REMINDER_TIME_ZONE = process.env.REMINDER_TIME_ZONE || "America/New_York";

function normalizeStoredItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const name = typeof item.name === "string" ? item.name.trim() : "";
  const amount = Number(item.amount);
  const category =
    typeof item.category === "string" && item.category.trim() ? item.category.trim() : "Other";

  if (!name || Number.isNaN(amount) || amount <= 0) {
    return null;
  }

  return { name, amount, category };
}

function loadItems() {
  try {
    if (!fs.existsSync(ITEMS_FILE)) {
      fs.writeFileSync(ITEMS_FILE, JSON.stringify(DEFAULT_ITEMS, null, 2));
      return DEFAULT_ITEMS.map((item) => ({ ...item }));
    }

    const fileContent = fs.readFileSync(ITEMS_FILE, "utf8");
    const parsed = JSON.parse(fileContent);

    if (!Array.isArray(parsed)) {
      throw new Error("items.json must contain an array.");
    }

    const normalized = parsed.map(normalizeStoredItem).filter(Boolean);
    if (!normalized.length) {
      fs.writeFileSync(ITEMS_FILE, JSON.stringify(DEFAULT_ITEMS, null, 2));
      return DEFAULT_ITEMS.map((item) => ({ ...item }));
    }

    return normalized;
  } catch (error) {
    console.error("Failed to load items.json, using defaults:", error);
    return DEFAULT_ITEMS.map((item) => ({ ...item }));
  }
}

const ITEMS = loadItems();
const INLINE_WIDTH_PAD = "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀";

function padPanelText(text) {
  return `${text}${INLINE_WIDTH_PAD}`;
}

function persistItems() {
  fs.writeFileSync(ITEMS_FILE, JSON.stringify(ITEMS, null, 2));
}

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
    returnTimer: null,
    currentStep: STEPS.HOME,
    selectedItem: null,
    customAmount: null,
    receiptFileId: null,
    pendingNewItem: null,
    lastSearchQuery: "",
    lastReminderKey: null
  };

  panelState.set(chatId, initial);
  return initial;
}

function resetExpenseState(chatId) {
  const state = getPanelState(chatId);
  state.selectedItem = null;
  state.customAmount = null;
  state.receiptFileId = null;
  state.pendingNewItem = null;
  state.lastSearchQuery = "";
}

function isKnownStep(step) {
  return Object.values(STEPS).includes(step);
}

function clearReturnTimer(chatId) {
  const state = getPanelState(chatId);
  if (state.returnTimer) {
    clearTimeout(state.returnTimer);
    state.returnTimer = null;
  }
}

function currentAmount(state) {
  if (state.customAmount !== null) {
    return state.customAmount;
  }

  return state.selectedItem ? state.selectedItem.amount : null;
}

function homePanel() {
  return {
    text: padPanelText("Hey Shevanise\nWhat would you like to do?"),
    reply_markup: {
      inline_keyboard: [[{ text: "Finance Tracker", callback_data: ACTIONS.FINANCE }]]
    }
  };
}

function backRow() {
  return [{ text: "Back", callback_data: ACTIONS.GO_BACK }];
}

function financePanel() {
  return {
    text: padPanelText("Finance Tracker\nWhat would you like to do?"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "Add Expense", callback_data: ACTIONS.ADD_EXPENSE }],
        backRow()
      ]
    }
  };
}

function searchPromptPanel(extraText = "") {
  const lines = ["Search Expense", "", "Type to search", "(e.g. Papine, cat food)"];

  if (extraText) {
    lines.push("", extraText);
  }

  return {
    text: padPanelText(lines.join("\n")),
    reply_markup: {
      inline_keyboard: [backRow()]
    }
  };
}

function resultsPanel(query, matches) {
  if (!matches.length) {
    return {
      text: padPanelText("No results found\n\nAdd new item?"),
      reply_markup: {
        inline_keyboard: [
          [{ text: "Add New", callback_data: ACTIONS.ADD_NEW_ITEM }],
          [{ text: "Cancel", callback_data: ACTIONS.CANCEL_EXPENSE }],
          backRow()
        ]
      }
    };
  }

  const keyboard = matches.map((item) => [
    {
      text: `${item.name} ($${item.amount})`,
      callback_data: `${ACTIONS.SELECT_ITEM}:${item.name}`
    }
  ]);

  keyboard.push(backRow());

  return {
    text: padPanelText("Results"),
    reply_markup: {
      inline_keyboard: keyboard
    }
  };
}

function addNewNamePanel(extraText = "") {
  const lines = ["Enter item name"];

  if (extraText) {
    lines.push("", extraText);
  }

  return {
    text: padPanelText(lines.join("\n")),
    reply_markup: {
      inline_keyboard: [
        [{ text: "Cancel", callback_data: ACTIONS.CANCEL_EXPENSE }],
        backRow()
      ]
    }
  };
}

function addNewAmountPanel(extraText = "") {
  const lines = ["Enter amount"];

  if (extraText) {
    lines.push("", extraText);
  }

  return {
    text: padPanelText(lines.join("\n")),
    reply_markup: {
      inline_keyboard: [
        [{ text: "Cancel", callback_data: ACTIONS.CANCEL_EXPENSE }],
        backRow()
      ]
    }
  };
}

function addNewCategoryPanel(extraText = "") {
  const lines = ["Enter category"];

  if (extraText) {
    lines.push("", extraText);
  }

  return {
    text: padPanelText(lines.join("\n")),
    reply_markup: {
      inline_keyboard: [
        [{ text: "Cancel", callback_data: ACTIONS.CANCEL_EXPENSE }],
        backRow()
      ]
    }
  };
}

function selectedItemPanel(state) {
  return {
    text: padPanelText(`${state.selectedItem.name}\nAmount: $${state.selectedItem.amount}\n\nAdjust amount?`),
    reply_markup: {
      inline_keyboard: [
        [{ text: "Adjust", callback_data: ACTIONS.ADJUST_AMOUNT }],
        [{ text: "Keep", callback_data: ACTIONS.KEEP_SAME }],
        [{ text: "Cancel", callback_data: ACTIONS.CANCEL_EXPENSE }],
        backRow()
      ]
    }
  };
}

function adjustAmountPanel() {
  return {
    text: padPanelText("Enter a new amount\n(Type numbers only, e.g. 250)"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "Cancel", callback_data: ACTIONS.CANCEL_EXPENSE }],
        backRow()
      ]
    }
  };
}

function confirmPanel(state) {
  return {
    text: padPanelText(`Confirm Expense\n\nItem: ${state.selectedItem.name}\nAmount: $${currentAmount(state)}`),
    reply_markup: {
      inline_keyboard: [
        [{ text: "Confirm", callback_data: ACTIONS.CONFIRM_EXPENSE }],
        [{ text: "Cancel", callback_data: ACTIONS.CANCEL_EXPENSE }],
        backRow()
      ]
    }
  };
}

function receiptChoicePanel() {
  return {
    text: padPanelText("Add receipt?\n\nChoose an option"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "Yes", callback_data: ACTIONS.RECEIPT_YES }],
        [{ text: "No", callback_data: ACTIONS.RECEIPT_NO }],
        backRow()
      ]
    }
  };
}

function receiptUploadPanel() {
  return {
    text: padPanelText("Upload a receipt image now.\n\nWaiting for image"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "Skip", callback_data: ACTIONS.RECEIPT_SKIP }],
        [{ text: "Cancel", callback_data: ACTIONS.CANCEL_EXPENSE }],
        backRow()
      ]
    }
  };
}

function reminderPanel() {
  return {
    text: padPanelText("Reminder\nAny expenses to add?"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "Add Expense", callback_data: ACTIONS.ADD_EXPENSE }],
        backRow()
      ]
    }
  };
}

async function editPanel(chatId, panel) {
  const state = getPanelState(chatId);
  if (!state.messageId) {
    return sendPanel(chatId, panel);
  }

  try {
    await bot.editMessageText(panel.text, {
      chat_id: chatId,
      message_id: state.messageId,
      reply_markup: panel.reply_markup
    });
  } catch (error) {
    if (
      error.response &&
      error.response.body &&
      error.response.body.description === "Bad Request: message is not modified"
    ) {
      return;
    }

    console.error(`Falling back to a new panel for chat ${chatId}:`, error.message || error);
    await sendPanel(chatId, panel);
  }
}

async function sendPanel(chatId, panel) {
  const state = getPanelState(chatId);
  const sent = await bot.sendMessage(chatId, panel.text, {
    reply_markup: panel.reply_markup
  });

  state.messageId = sent.message_id;
  return sent;
}

async function deleteIncomingMessage(chatId, messageId) {
  if (!messageId) {
    return;
  }

  await bot.deleteMessage(chatId, String(messageId)).catch(() => {});
}

async function ensureStartPanel(chatId) {
  await showMainMenu(chatId);
}

async function showMainMenu(chatId, messageId) {
  const state = getPanelState(chatId);
  clearReturnTimer(chatId);
  resetExpenseState(chatId);
  state.currentStep = STEPS.HOME;

  if (messageId) {
    state.messageId = messageId;
  }

  await editPanel(chatId, homePanel());
}

async function renderCurrentStep(chatId) {
  const state = getPanelState(chatId);

  switch (state.currentStep) {
    case STEPS.HOME:
      await editPanel(chatId, homePanel());
      return;
    case STEPS.FINANCE:
      await editPanel(chatId, financePanel());
      return;
    case STEPS.SEARCH:
      await editPanel(chatId, searchPromptPanel());
      return;
    case STEPS.SEARCH_RESULTS:
      await editPanel(chatId, resultsPanel(state.lastSearchQuery, filterItems(state.lastSearchQuery)));
      return;
    case STEPS.ADDING_ITEM_NAME:
      await editPanel(chatId, addNewNamePanel());
      return;
    case STEPS.ADDING_ITEM_AMOUNT:
      await editPanel(chatId, addNewAmountPanel());
      return;
    case STEPS.ADDING_ITEM_CATEGORY:
      await editPanel(chatId, addNewCategoryPanel("Leave blank to use Other."));
      return;
    case STEPS.ITEM_SELECTED:
      if (!state.selectedItem) {
        await showMainMenu(chatId);
        return;
      }
      await editPanel(chatId, selectedItemPanel(state));
      return;
    case STEPS.AWAITING_AMOUNT:
      await editPanel(chatId, adjustAmountPanel());
      return;
    case STEPS.CONFIRM:
      if (!state.selectedItem) {
        await showMainMenu(chatId);
        return;
      }
      await editPanel(chatId, confirmPanel(state));
      return;
    case STEPS.RECEIPT_CHOICE:
      await editPanel(chatId, receiptChoicePanel());
      return;
    case STEPS.AWAITING_RECEIPT:
      await editPanel(chatId, receiptUploadPanel());
      return;
    case STEPS.REMINDER:
      await editPanel(chatId, reminderPanel());
      return;
    default:
      await showMainMenu(chatId);
  }
}

async function navigateTo(chatId, nextStep) {
  const state = getPanelState(chatId);
  state.currentStep = nextStep;
  await renderCurrentStep(chatId);
}

async function navigateBack(chatId) {
  const state = getPanelState(chatId);

  switch (state.currentStep) {
    case STEPS.FINANCE:
    case STEPS.REMINDER:
      await showMainMenu(chatId);
      return;
    case STEPS.SEARCH:
      await moveToFinance(chatId);
      return;
    case STEPS.SEARCH_RESULTS:
      await navigateTo(chatId, STEPS.SEARCH);
      return;
    case STEPS.ADDING_ITEM_NAME:
      if (state.lastSearchQuery) {
        await navigateTo(chatId, STEPS.SEARCH_RESULTS);
        return;
      }
      await navigateTo(chatId, STEPS.SEARCH);
      return;
    case STEPS.ADDING_ITEM_AMOUNT:
      await navigateTo(chatId, STEPS.ADDING_ITEM_NAME);
      return;
    case STEPS.ADDING_ITEM_CATEGORY:
      await navigateTo(chatId, STEPS.ADDING_ITEM_AMOUNT);
      return;
    case STEPS.ITEM_SELECTED:
      if (state.lastSearchQuery) {
        await navigateTo(chatId, STEPS.SEARCH_RESULTS);
        return;
      }
      await navigateTo(chatId, STEPS.SEARCH);
      return;
    case STEPS.AWAITING_AMOUNT:
      await navigateTo(chatId, STEPS.ITEM_SELECTED);
      return;
    case STEPS.CONFIRM:
      if (state.lastSearchQuery) {
        await navigateTo(chatId, STEPS.SEARCH_RESULTS);
        return;
      }
      await navigateTo(chatId, STEPS.SEARCH);
      return;
    case STEPS.RECEIPT_CHOICE:
    case STEPS.AWAITING_RECEIPT:
      await navigateTo(chatId, STEPS.CONFIRM);
      return;
    default:
      await showMainMenu(chatId);
  }
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

  if (!properties.Notes) {
    await notionRequest(`/databases/${notionDatabaseId}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: database.title,
        properties: {
          Notes: {
            rich_text: {}
          }
        }
      })
    });
  }
}

async function saveExpenseToNotion(item, receiptFileId) {
  await ensureDatabaseSchema(item);

  const properties = {
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
  };

  if (receiptFileId) {
    properties.Notes = {
      rich_text: [
        {
          text: {
            content: "Receipt attached"
          }
        }
      ]
    };
  }

  return notionRequest("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: {
        database_id: notionDatabaseId
      },
      properties
    })
  });
}

async function showSavedState(chatId, item) {
  const state = getPanelState(chatId);
  clearReturnTimer(chatId);
  const previousMessageId = state.messageId;

  if (previousMessageId) {
    await bot.deleteMessage(chatId, String(previousMessageId)).catch(() => {});
    state.messageId = null;
  }

  await bot.sendMessage(chatId, padPanelText(`Saved\n\n${item.name} - $${item.amount}`)).catch((error) => {
    console.error("Failed to send saved confirmation message:", error);
  });

  await showMainMenu(chatId);
}

async function showSavingState(chatId, item) {
  await editPanel(chatId, {
    text: padPanelText(`Saving\n\n${item.name} - $${item.amount}`),
    reply_markup: {
      inline_keyboard: []
    }
  });
}

function getUserFacingErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.replace(/^Notion API error \d+:\s*/i, "").trim();
  return normalized.slice(0, 180) || "Unknown error.";
}

async function showSaveError(chatId, error) {
  clearReturnTimer(chatId);
  await editPanel(chatId, {
    text: padPanelText("Error\nTry again"),
    reply_markup: {
      inline_keyboard: [backRow()]
    }
  });
}

function findItemByName(name) {
  return ITEMS.find((item) => item.name === name) || null;
}

function filterItems(query) {
  const normalized = query.trim().toLowerCase();
  return ITEMS.filter((item) => item.name.toLowerCase().includes(normalized));
}

async function startSearchFlow(chatId) {
  const state = getPanelState(chatId);
  clearReturnTimer(chatId);
  resetExpenseState(chatId);
  await navigateTo(chatId, STEPS.SEARCH);
}

async function showSearchResults(chatId, query) {
  const state = getPanelState(chatId);
  state.lastSearchQuery = query;
  await navigateTo(chatId, STEPS.SEARCH_RESULTS);
}

async function moveToAddNewName(chatId) {
  const state = getPanelState(chatId);
  state.pendingNewItem = { name: "", amount: null, category: "Other" };
  await navigateTo(chatId, STEPS.ADDING_ITEM_NAME);
}

async function moveToAddNewAmount(chatId) {
  await navigateTo(chatId, STEPS.ADDING_ITEM_AMOUNT);
}

async function moveToAddNewCategory(chatId) {
  await navigateTo(chatId, STEPS.ADDING_ITEM_CATEGORY);
}

async function moveToFinance(chatId) {
  const state = getPanelState(chatId);
  clearReturnTimer(chatId);
  resetExpenseState(chatId);
  await navigateTo(chatId, STEPS.FINANCE);
}

async function moveToHome(chatId) {
  await showMainMenu(chatId);
}

async function moveToSelectedItem(chatId, item) {
  const state = getPanelState(chatId);
  state.selectedItem = { ...item };
  state.customAmount = null;
  state.receiptFileId = null;
  await navigateTo(chatId, STEPS.ITEM_SELECTED);
}

async function showNewItemCreated(chatId, item) {
  await editPanel(chatId, {
    text: padPanelText(`New item created\n\n${item.name} - $${item.amount}`),
    reply_markup: {
      inline_keyboard: []
    }
  });

  const state = getPanelState(chatId);
  clearReturnTimer(chatId);

  state.returnTimer = setTimeout(() => {
    moveToConfirm(chatId).catch((error) => {
      console.error("Failed to move to confirm after new item creation:", error);
    });
    state.returnTimer = null;
  }, 1500);
}

async function moveToAdjustAmount(chatId) {
  await navigateTo(chatId, STEPS.AWAITING_AMOUNT);
}

async function moveToConfirm(chatId) {
  const state = getPanelState(chatId);
  if (!state.selectedItem) {
    await startSearchFlow(chatId);
    return;
  }

  await navigateTo(chatId, STEPS.CONFIRM);
}

async function moveToReceiptChoice(chatId) {
  await navigateTo(chatId, STEPS.RECEIPT_CHOICE);
}

async function moveToReceiptUpload(chatId) {
  await navigateTo(chatId, STEPS.AWAITING_RECEIPT);
}

async function saveSelectedExpense(chatId) {
  const state = getPanelState(chatId);
  if (!state.selectedItem) {
    await startSearchFlow(chatId);
    return;
  }

  const itemToSave = {
    ...state.selectedItem,
    amount: currentAmount(state)
  };

  try {
    await showSavingState(chatId, itemToSave);
    const notionPage = await saveExpenseToNotion(itemToSave, state.receiptFileId);
    console.log("Created Notion page:", notionPage && notionPage.url ? notionPage.url : notionPage && notionPage.id);
    await showSavedState(chatId, itemToSave);
  } catch (error) {
    console.error("Failed to save expense:", error);
    await showSaveError(chatId, error);
  }
}

async function handleSearchInput(chatId, text) {
  const query = text.trim();
  if (!query) {
    await editPanel(chatId, searchPromptPanel("Please type a search term."));
    return;
  }

  await showSearchResults(chatId, query);
}

async function handleNewItemNameInput(chatId, text) {
  const name = text.trim();
  if (!name) {
    await editPanel(chatId, addNewNamePanel("Name cannot be empty."));
    return;
  }

  const state = getPanelState(chatId);
  state.pendingNewItem = state.pendingNewItem || { name: "", amount: null, category: "Other" };
  state.pendingNewItem.name = name;
  await moveToAddNewAmount(chatId);
}

async function handleNewItemAmountInput(chatId, text) {
  const normalized = text.replace(/[^0-9.]/g, "");
  const amount = Number(normalized);

  if (!normalized || Number.isNaN(amount) || amount <= 0) {
    await editPanel(chatId, addNewAmountPanel("Invalid amount. Try again."));
    return;
  }

  const state = getPanelState(chatId);
  state.pendingNewItem = state.pendingNewItem || { name: "", amount: null, category: "Other" };
  state.pendingNewItem.amount = amount;
  await moveToAddNewCategory(chatId);
}

async function handleNewItemCategoryInput(chatId, text) {
  const state = getPanelState(chatId);
  const draft = state.pendingNewItem;

  if (!draft || !draft.name || draft.amount === null) {
    await moveToAddNewName(chatId);
    return;
  }

  const category = text.trim() || "Other";
  const newItem = {
    name: draft.name,
    amount: draft.amount,
    category
  };

  ITEMS.push(newItem);
  persistItems();
  state.selectedItem = { ...newItem };
  state.customAmount = newItem.amount;
  state.receiptFileId = null;
  state.pendingNewItem = null;
  await showNewItemCreated(chatId, newItem);
}

async function handleAmountInput(chatId, text) {
  const normalized = text.replace(/[^0-9.]/g, "");
  const amount = Number(normalized);

  if (!normalized || Number.isNaN(amount) || amount <= 0) {
    const state = getPanelState(chatId);
    state.currentStep = STEPS.AWAITING_AMOUNT;
    await editPanel(chatId, {
      text: padPanelText("Enter a new amount\n(Type numbers only, e.g. 250)\n\nInvalid amount. Try again."),
      reply_markup: {
        inline_keyboard: [
          [{ text: "Cancel", callback_data: ACTIONS.CANCEL_EXPENSE }],
          backRow()
        ]
      }
    });
    return;
  }

  const state = getPanelState(chatId);
  state.customAmount = amount;
  await moveToConfirm(chatId);
}

async function handleTextMessage(msg) {
  const chatId = msg.chat.id;
  const state = getPanelState(chatId);
  const text = (msg.text || "").trim();

  await deleteIncomingMessage(chatId, msg.message_id);

  if (text === "/start") {
    return;
  }

  if (!state.messageId || !isKnownStep(state.currentStep)) {
    await showMainMenu(chatId);
    return;
  }

  if (state.currentStep === STEPS.SEARCH || state.currentStep === STEPS.SEARCH_RESULTS) {
    await handleSearchInput(chatId, text);
    return;
  }

  if (state.currentStep === STEPS.ADDING_ITEM_NAME) {
    await handleNewItemNameInput(chatId, text);
    return;
  }

  if (state.currentStep === STEPS.ADDING_ITEM_AMOUNT) {
    await handleNewItemAmountInput(chatId, text);
    return;
  }

  if (state.currentStep === STEPS.ADDING_ITEM_CATEGORY) {
    await handleNewItemCategoryInput(chatId, text);
    return;
  }

  if (state.currentStep === STEPS.AWAITING_AMOUNT) {
    await handleAmountInput(chatId, text);
    return;
  }

  await showMainMenu(chatId);
}

async function handleReceiptPhoto(msg) {
  const chatId = msg.chat.id;
  const state = getPanelState(chatId);

  await deleteIncomingMessage(chatId, msg.message_id);

  if (state.currentStep !== STEPS.AWAITING_RECEIPT || !msg.photo || !msg.photo.length) {
    if (!state.messageId || !isKnownStep(state.currentStep)) {
      await showMainMenu(chatId);
      return;
    }

    await showMainMenu(chatId);
    return;
  }

  const largestPhoto = msg.photo[msg.photo.length - 1];
  state.receiptFileId = largestPhoto.file_id;
  await saveSelectedExpense(chatId);
}

async function handleAction(chatId, action) {
  const state = getPanelState(chatId);

  if (action === ACTIONS.FINANCE) {
    await moveToFinance(chatId);
    return;
  }

  if (action === ACTIONS.GO_BACK) {
    await navigateBack(chatId);
    return;
  }

  if (action === ACTIONS.CANCEL_EXPENSE) {
    await showMainMenu(chatId);
    return;
  }

  if (action === ACTIONS.ADD_EXPENSE) {
    await startSearchFlow(chatId);
    return;
  }

  if (action === ACTIONS.ADD_NEW_ITEM) {
    await moveToAddNewName(chatId);
    return;
  }

  if (action === ACTIONS.ADJUST_AMOUNT) {
    await moveToAdjustAmount(chatId);
    return;
  }

  if (action === ACTIONS.KEEP_SAME) {
    state.customAmount = state.selectedItem ? state.selectedItem.amount : null;
    await moveToConfirm(chatId);
    return;
  }

  if (action === ACTIONS.CONFIRM_EXPENSE) {
    await moveToReceiptChoice(chatId);
    return;
  }

  if (action === ACTIONS.RECEIPT_YES) {
    await moveToReceiptUpload(chatId);
    return;
  }

  if (action === ACTIONS.RECEIPT_NO || action === ACTIONS.RECEIPT_SKIP) {
    state.receiptFileId = null;
    await saveSelectedExpense(chatId);
    return;
  }

  if (action.startsWith(`${ACTIONS.SELECT_ITEM}:`)) {
    const itemName = action.slice(`${ACTIONS.SELECT_ITEM}:`.length);
    const item = findItemByName(itemName);

    if (!item) {
      await startSearchFlow(chatId);
      return;
    }

    await moveToSelectedItem(chatId, item);
    return;
  }

  await showMainMenu(chatId);
}

function reminderKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function getReminderClockParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: REMINDER_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

async function runReminderTick() {
  const now = new Date();
  const clock = getReminderClockParts(now);
  if (clock.hour !== 17 || clock.minute !== 0) {
    return;
  }

  const todayKey = reminderKey(new Date(clock.year, clock.month - 1, clock.day));

  for (const [chatId, state] of panelState.entries()) {
    if (!state.messageId || state.lastReminderKey === todayKey) {
      continue;
    }

    state.lastReminderKey = todayKey;
    state.currentStep = STEPS.REMINDER;
    resetExpenseState(chatId);

    try {
      await editPanel(chatId, reminderPanel());
    } catch (error) {
      console.error(`Failed to send reminder panel for chat ${chatId}:`, error);
    }
  }
}

setInterval(() => {
  runReminderTick().catch((error) => {
    console.error("Reminder tick failed:", error);
  });
}, 30000);

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await deleteIncomingMessage(chatId, msg.message_id);
    await ensureStartPanel(chatId);
  } catch (error) {
    console.error("Failed to initialize start panel:", error);
  }
});

bot.on("message", async (msg) => {
  try {
    const state = getPanelState(msg.chat.id);
    if (!isKnownStep(state.currentStep)) {
      await showMainMenu(msg.chat.id);
      return;
    }

    if (msg.text) {
      await handleTextMessage(msg);
      return;
    }

    if (msg.photo) {
      await handleReceiptPhoto(msg);
      return;
    }

    await showMainMenu(msg.chat.id);
  } catch (error) {
    console.error("Message handling failed:", error);
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

  if (!isKnownStep(state.currentStep)) {
    state.currentStep = STEPS.HOME;
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
console.log("Reminder timezone:", REMINDER_TIME_ZONE);

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
