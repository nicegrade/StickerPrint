// ============================================================
// page-hook.js - Content Script (MAIN мир)
// Перехватывает ответы страницы и извлекает номер ячейки:
//   1) XHR  /api2/address-storage/Movement/put/v2  -> address
//   2) XHR  .../MicroFFTransferApi/TransferByBarcodeArticle
//      -> transferSuccess.cell ("Ozon Полка-88" -> "П88")
// ============================================================

(function() {
  // ---- Отправка номера ячейки в content.js ----
  function sendCell(cellNumber) {
    window.postMessage({
      source: "StickerPrint",
      type: "PRINT_CELL",
      cellNumber: cellNumber
    }, "*");
  }

  // ---- "Ozon Полка-88" -> "П88" (если это не полка — null) ----
  function shelfToCell(raw) {
    if (typeof raw !== "string") return null;
    const m = raw.match(/Полка\s*[-\u2010-\u2015\u2212]?\s*(\d+)/i);
    return m ? "П" + m[1] : null;
  }

  // ============================================================
  // 1) XHR: перехват ответов
  //    - Movement/put/v2               -> address
  //    - TransferByBarcodeArticle      -> transferSuccess.cell (Полка-N -> ПN)
  // ============================================================
  const originalSend = XMLHttpRequest.prototype.send;

  // Достаём тело ответа как объект (учитываем responseType "json")
  function readJson(xhr) {
    if (xhr.responseType === "json") return xhr.response;
    if (xhr.responseType === "" || xhr.responseType === "text") {
      return xhr.responseText ? JSON.parse(xhr.responseText) : null;
    }
    return null;
  }

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener("load", function() {
      try {
        const url = this.responseURL || "";

        // Размещение: адрес ячейки
        if (url.includes("/api2/address-storage/Movement/put/v2")) {
          const data = readJson(this);
          if (!data || !data.articlePositions || !data.articlePositions.length) return;
          sendCell(data.articlePositions[0].address);
          return;
        }

        // Выдача на полку: "Ozon Полка-88" -> "П88"
        if (url.includes("/MicroFFTransferApi/TransferByBarcodeArticle")) {
          const data = readJson(this);
          const cell = shelfToCell(data && data.transferSuccess && data.transferSuccess.cell);
          if (cell) sendCell(cell);
        }
      } catch (e) {
        // Игнорируем ошибки парсинга
      }
    });

    return originalSend.apply(this, args);
  };
})();
