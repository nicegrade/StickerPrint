// ============================================================
// background.js - Service Worker
// Обрабатывает автопечать со страницы (сканирование) и очередь
// ручной/серийной печати, запущенную из popup.
//
// Очередь печати выполняется здесь, а не в popup.js, потому что
// popup закрывается при потере фокуса — а service worker
// продолжает жить и работать в фоне.
// ============================================================

const PRINT_SERVER = "http://127.0.0.1:3000/print";
const RANGE_STATE_KEY = "rangePrintState";
const RANGE_DELAY_MS = 400;
const WATCHDOG_ALARM = "rangePrintWatchdog";

// ---- Входящие сообщения ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return;

  switch (message.action) {
    case "printCell":
      // Автопечать при сканировании ячейки на странице.
      // allowDuplicate=true  -> печатаем всегда (полки: TransferByBarcodeArticle,
      //                         TransferPackingArticle)
      // allowDuplicate=false -> подавляем повтор подряд (Movement/put/v2)
      handleAutoPrint(message.cellNumber, !!message.allowDuplicate);
      return; // ответ не требуется

    case "startRangePrint":
      startRangePrint(message.cells);
      sendResponse({ ok: true });
      return;

    case "cancelRangePrint":
      cancelRangePrint();
      sendResponse({ ok: true });
      return;

    case "getRangePrintState":
      getRangeState().then(sendResponse);
      return true; // ответ придёт асинхронно

    default:
      return;
  }
});

// Если service worker перезапустился (например, был выгружен браузером),
// а печать всё ещё числится "выполняется" — продолжаем с того места,
// на котором остановились.
resumeRangePrintIfNeeded();

// Будильник-подстраховка: если по какой-то причине основной цикл
// прервался вместе с worker'ом, будильник разбудит нас снова.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) {
    resumeRangePrintIfNeeded();
  }
});

// ============================================================
// Автопечать по сигналу со страницы (сканирование ячейки)
//
// allowDuplicate=false -> подавляем повтор подряд (lastPrintedCell)
// allowDuplicate=true  -> печатаем всегда, даже если номер совпадает
// ============================================================
function handleAutoPrint(cell, allowDuplicate) {
  if (!cell) return;

  if (allowDuplicate) {
    // Без дедупликации: печатаем всё подряд
    fetch(PRINT_SERVER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cellNumber: cell })
    })
      .then(response => response.json())
      .then(() => {
        chrome.storage.local.set({
          lastPrintedCell: cell,
          lastPrintTime: new Date().toLocaleTimeString()
        });
      })
      .catch(() => {}); // Игнорируем ошибки, они обрабатываются в popup
    return;
  }

  // С дедупликацией: не печатаем одну ячейку дважды подряд
  chrome.storage.local.get(["lastPrintedCell"], (result) => {
    if (result.lastPrintedCell === cell) return;

    fetch(PRINT_SERVER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cellNumber: cell })
    })
      .then(response => response.json())
      .then(() => {
        chrome.storage.local.set({
          lastPrintedCell: cell,
          lastPrintTime: new Date().toLocaleTimeString()
        });
      })
      .catch(() => {}); // Игнорируем ошибки, они обрабатываются в popup
  });
}

// ============================================================
// Серийная/ручная печать из popup — выполняется в фоне
// ============================================================

async function getRangeState() {
  const result = await chrome.storage.local.get([RANGE_STATE_KEY]);
  return result[RANGE_STATE_KEY] || null;
}

async function setRangeState(state) {
  await chrome.storage.local.set({ [RANGE_STATE_KEY]: state });
  // Сообщаем popup'у, если он сейчас открыт. Если получателя нет —
  // Chrome вернёт ошибку в chrome.runtime.lastError, которую нужно
  // "потрогать", иначе она попадёт в консоль как необработанная.
  chrome.runtime.sendMessage({ action: "rangePrintUpdate", state }, () => {
    void chrome.runtime.lastError;
  });
}

async function startRangePrint(cells) {
  const existing = await getRangeState();
  if (existing && existing.running) return; // уже что-то печатается

  const state = {
    running: true,
    cancelRequested: false,
    cells,
    total: cells.length,
    processedCount: 0,
    successCount: 0,
    failCount: 0,
    failedCells: [],
    currentCell: null
  };

  await setRangeState(state);
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  runRangeQueue();
}

async function cancelRangePrint() {
  const state = await getRangeState();
  if (!state || !state.running) return;
  state.cancelRequested = true;
  await setRangeState(state);
}

async function runRangeQueue() {
  let state = await getRangeState();
  if (!state || !state.running) return;

  for (let i = state.processedCount; i < state.cells.length; i++) {
    // Перечитываем состояние на каждом шаге — вдруг пришла отмена
    // или worker перезапускался и кто-то другой уже занят этим же шагом
    state = await getRangeState();
    if (!state || !state.running) return;
    if (state.cancelRequested) break;
    if (i < state.processedCount) continue; // шаг уже выполнен ранее

    const cell = state.cells[i];
    state.currentCell = cell;
    await setRangeState(state);

    try {
      const response = await fetch(PRINT_SERVER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cellNumber: cell })
      });

      let data = {};
      try { data = await response.json(); } catch {}

      if (response.ok && data.status === "success") {
        state.successCount++;
        await chrome.storage.local.set({
          lastPrintedCell: cell,
          lastPrintTime: new Date().toLocaleTimeString()
        });
      } else {
        state.failCount++;
        state.failedCells.push(cell);
      }
    } catch {
      // Сервер печати недоступен — считаем шаг неудачным и идём дальше
      state.failCount++;
      state.failedCells.push(cell);
    }

    state.processedCount = i + 1;
    await setRangeState(state);

    if (i < state.cells.length - 1) {
      await new Promise(resolve => setTimeout(resolve, RANGE_DELAY_MS));
    }
  }

  state = await getRangeState();
  if (!state) return;

  const wasCancelled = state.cancelRequested;
  state.running = false;
  state.cancelRequested = false;
  state.currentCell = null;
  await setRangeState(state);
  chrome.alarms.clear(WATCHDOG_ALARM);

  chrome.runtime.sendMessage(
    { action: "rangePrintComplete", state, cancelled: wasCancelled },
    () => { void chrome.runtime.lastError; }
  );
}

async function resumeRangePrintIfNeeded() {
  const state = await getRangeState();
  if (state && state.running) {
    runRangeQueue();
  } else {
    chrome.alarms.clear(WATCHDOG_ALARM);
  }
}