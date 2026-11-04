// ============================================================
// popup.js - Логика интерфейса
//
// Сама печать (в том числе серийная) выполняется в background.js,
// а popup лишь отправляет команды и отображает текущее состояние.
// Благодаря этому печать не прерывается при закрытии popup.
// ============================================================

document.addEventListener("DOMContentLoaded", () => {

  // ---- DOM элементы ----
  const input        = document.getElementById("cellInput");
  const printButton  = document.getElementById("printButton");
  const cancelButton = document.getElementById("cancelButton");
  const serverStatus = document.getElementById("serverStatus");
  const serverDot    = document.getElementById("serverDot");
  const lastCell     = document.getElementById("lastCell");
  const statusMsg    = document.getElementById("statusMessage");
  const progressBar  = document.getElementById("progressBar");
  const progressFill = document.getElementById("progressBarFill");

  let statusTimeout = null;

  // ---- Утилиты сообщений ----
  function showStatus(message, type = "info", duration = 5000) {
    statusMsg.textContent = message;
    statusMsg.className = "status-message " + type;

    if (statusTimeout) clearTimeout(statusTimeout);
    if (duration > 0) {
      statusTimeout = setTimeout(() => {
        statusMsg.className = "status-message";
        statusMsg.textContent = "";
      }, duration);
    }
  }

  function hideStatus() {
    statusMsg.className = "status-message";
    statusMsg.textContent = "";
    if (statusTimeout) clearTimeout(statusTimeout);
  }

  // ---- Проверка сервера ----
  async function checkServer() {
    try {
      await fetch("http://127.0.0.1:3000/", { method: "GET", cache: "no-store" });
      serverStatus.textContent = "online";
      serverDot.className = "dot online";
    } catch {
      serverStatus.textContent = "offline";
      serverDot.className = "dot offline";
    }
  }

  // ---- Загрузка последней печати ----
  function loadLastPrint() {
    chrome.storage.local.get(["lastPrintedCell"], (result) => {
      if (result.lastPrintedCell) {
        lastCell.textContent = result.lastPrintedCell;
      }
    });
  }

  // ============================================================
  // Разбор диапазонов/списка ячеек
  // Примеры: "105"              -> ["105"]
  //          "100-105, 110-115" -> 100..105, 110..115
  //          "П15-П20"          -> П15, П16, ..., П20
  //          "А50-60"           -> А50, А51, ..., А60 (литера берётся из начала)
  //          "П1-П3, А5, 200"   -> П1, П2, П3, А5, 200
  // Возвращает { cells, error } — при ошибке cells пустой.
  // ============================================================
  const MAX_CELLS = 1000; // защита от случайного "1-999999"

  function parseCellRange(text) {
    const cells = [];

    // Разные виды тире (– —  −) приводим к обычному дефису
    const normalized = text.replace(/[\u2010-\u2015\u2212]/g, "-");
    const parts = normalized.split(",").map(p => p.trim()).filter(Boolean);

    for (const part of parts) {
      // литера(ы) + число - [литера(ы)] + число
      const m = part.match(/^(\p{L}*)(\d+)\s*-\s*(\p{L}*)(\d+)$/u);

      if (m) {
        const prefixA = m[1];
        const prefixB = m[3];

        // Если литера указана с обеих сторон — они должны совпадать
        if (prefixB && prefixA.toLowerCase() !== prefixB.toLowerCase()) {
          return { cells: [], error: `Разные литеры в диапазоне «${part}»` };
        }

        const prefix = prefixA; // "А50-60" -> литера берётся из начала
        const start = parseInt(m[2], 10);
        const end = parseInt(m[4], 10);

        // Сохраняем ведущие нули, если они были указаны (например "П008-П012")
        const width = m[2].length;
        const useLeadingZeros = m[2].startsWith("0") && width > 1;

        const step = start <= end ? 1 : -1;
        for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
          const num = useLeadingZeros ? String(i).padStart(width, "0") : String(i);
          cells.push(prefix + num);
          if (cells.length > MAX_CELLS) {
            return { cells: [], error: `Слишком много ячеек (максимум ${MAX_CELLS})` };
          }
        }
      } else {
        // Одиночное значение (число, литера+число или любая строка) — как есть
        cells.push(part);
      }
    }

    return { cells, error: null };
  }

  // ============================================================
  // Отображение состояния очереди печати (приходит из background.js)
  // ============================================================
  function renderRangeState(state) {
    if (!state || !state.running) {
      // Печать не идёт — обычный режим
      printButton.disabled = false;
      printButton.textContent = "Напечатать";
      cancelButton.style.display = "none";
      input.disabled = false;
      progressBar.className = "progress-bar";
      progressFill.style.width = "0%";
      return;
    }

    // Печать выполняется — блокируем ввод, показываем прогресс
    printButton.disabled = true;
    printButton.textContent = `⏳ ${state.processedCount}/${state.total}`;
    cancelButton.style.display = "block";
    input.disabled = true;

    progressBar.className = "progress-bar active";
    const percent = state.total ? Math.round((state.processedCount / state.total) * 100) : 0;
    progressFill.style.width = percent + "%";

    if (state.currentCell) {
      showStatus(
        `Печать ячейки ${state.currentCell} (${state.processedCount + 1} из ${state.total})`,
        "info",
        0
      );
    }

    if (state.lastPrintedCell !== undefined && state.currentCell) {
      lastCell.textContent = state.currentCell;
    }
  }

  function renderCompletion(state, cancelled) {
    printButton.disabled = false;
    printButton.textContent = "Напечатать";
    cancelButton.style.display = "none";
    input.disabled = false;

    progressFill.style.width = "100%";
    setTimeout(() => {
      progressBar.className = "progress-bar";
      progressFill.style.width = "0%";
    }, 800);

    if (cancelled) {
      showStatus(
        `⏹️ Отменено. Напечатано ${state.successCount} из ${state.total}`,
        "warning",
        6000
      );
    } else if (state.failCount === 0) {
      showStatus(`✅ Напечатано ${state.successCount} из ${state.total} ячеек`, "success", 6000);
    } else {
      showStatus(
        `⚠️ Успешно: ${state.successCount}, ошибок: ${state.failCount} (${state.failedCells.join(", ")})`,
        "warning",
        8000
      );
    }

    loadLastPrint();
  }

  // ---- Команды в background.js ----
  function startPrint(text) {
    const { cells, error } = parseCellRange(text.trim());
    if (error) {
      showStatus("⚠️ " + error, "warning", 5000);
      return;
    }
    if (!cells.length) {
      showStatus("⚠️ Введите номер ячейки или диапазон!", "warning", 3000);
      return;
    }

    chrome.runtime.sendMessage({ action: "startRangePrint", cells }, () => {
      void chrome.runtime.lastError;
    });
  }

  function cancelPrint() {
    chrome.runtime.sendMessage({ action: "cancelRangePrint" }, () => {
      void chrome.runtime.lastError;
    });
    showStatus("⏹️ Останавливаем после текущей ячейки...", "warning", 0);
  }

  // ---- Сообщения от background.js (обновление прогресса в реальном времени) ----
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "rangePrintUpdate") {
      renderRangeState(message.state);
    } else if (message.action === "rangePrintComplete") {
      renderCompletion(message.state, message.cancelled);
    }
  });

  // ---- События ----
  printButton.addEventListener("click", () => startPrint(input.value));

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") startPrint(input.value);
  });

  input.addEventListener("focus", hideStatus);

  cancelButton.addEventListener("click", cancelPrint);

  // ---- Инициализация ----
  checkServer();
  loadLastPrint();
  setInterval(checkServer, 10000);

  // Узнаём у background.js, не идёт ли уже печать (если popup был
  // переоткрыт во время выполнения серийной печати)
  chrome.runtime.sendMessage({ action: "getRangePrintState" }, (state) => {
    void chrome.runtime.lastError;
    if (state) renderRangeState(state);
  });

});
