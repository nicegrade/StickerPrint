// ============================================================
// content.js - Content Script (изолированный мир)
// Перехватывает сообщения от page-hook и отправляет в background
// ============================================================

// Слушаем сообщения из MAIN мира страницы
window.addEventListener("message", (event) => {
  // Игнорируем сообщения не от нашего скрипта
  if (event.source !== window) return;
  if (event.data.source !== "StickerPrint") return;

  // Если это команда печати — отправляем в service worker
  if (event.data.type === "PRINT_CELL") {
    chrome.runtime.sendMessage({
      action: "printCell",
      cellNumber: event.data.cellNumber,
      allowDuplicate: !!event.data.allowDuplicate
    });
  }
});