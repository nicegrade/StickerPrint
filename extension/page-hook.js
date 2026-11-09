// ============================================================
// page-hook.js - Content Script (MAIN мир)
// Перехватывает ответы страницы и извлекает номер ячейки:
//   1) XHR  /api2/address-storage/Movement/put/v2  -> address
//      (с дедупликацией: одна и та же ячейка подряд не печатается)
//   2) XHR  .../MicroFFTransferApi/TransferByBarcodeArticle
//      -> transferSuccess.cell ("Ozon Полка-88" -> "П88")
//   3) XHR  .../MicroFFTransferApi/TransferPackingArticle
//      -> success.cell ("Ozon Полка-57" -> "П57")
//      (для переупакованных позиций: cell приходит только здесь)
//
// Для полочных эндпоинтов дубли НЕ подавляются — печатаем всё.
// ============================================================

(function() {
  // ---- Отправка номера ячейки в content.js ----
  // allowDuplicate=false -> background может пропустить повтор подряд
  // allowDuplicate=true  -> печатаем всегда
  function sendCell(cellNumber, allowDuplicate) {
    window.postMessage({
      source: "StickerPrint",
      type: "PRINT_CELL",
      cellNumber: cellNumber,
      allowDuplicate: !!allowDuplicate
    }, "*");
  }

  // ---- "Ozon Полка-88" -> "П88" (если это не полка — null) ----
  function shelfToCell(raw) {
    if (typeof raw !== "string") return null;
    const m = raw.match(/Полка\s*[-\u2010-\u2015\u2212]?\s*(\d+)/i);
    return m ? "П" + m[1] : null;
  }

  // ============================================================
  // XHR: перехват ответов
  //    - Movement/put/v2               -> address
  //    - TransferByBarcodeArticle      -> transferSuccess.cell (Полка-N -> ПN)
  //    - TransferPackingArticle        -> success.cell         (Полка-N -> ПN)
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

        // Размещение: адрес ячейки (с дедупликацией)
        if (url.includes("/api2/address-storage/Movement/put/v2")) {
          const data = readJson(this);
          if (!data || !data.articlePositions || !data.articlePositions.length) return;
          sendCell(data.articlePositions[0].address, false);
          return;
        }

        // Размещение на Озон-полку (как есть): "Ozon Полка-88" -> "П88"
        // Печатаем всегда, без подавления дублей.
        if (url.includes("/MicroFFTransferApi/TransferByBarcodeArticle")) {
          const data = readJson(this);
          const cell = shelfToCell(data && data.transferSuccess && data.transferSuccess.cell);
          if (cell) sendCell(cell, true);
          return;
        }

        // Размещение на Озон-полку (переупакованные): тоже "Ozon Полка-57" -> "П57"
        // Печатаем всегда, без подавления дублей.
        if (url.includes("/p-api/wms-selector/MicroFFTransferApi/TransferPackingArticle")) {
          const data = readJson(this);
          const cell = shelfToCell(data && data.success && data.success.cell);
          if (cell) sendCell(cell, true);
        }
      } catch (e) {
        // Игнорируем ошибки парсинга
      }
    });

    return originalSend.apply(this, args);
  };
})();