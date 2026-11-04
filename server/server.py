# ================================================================
# server.py - Сервер печати для StickerPrint
# Обеспечивает API для печати этикеток и веб-интерфейс настроек
# ================================================================

import os
import json
import threading
import webbrowser
import socket
import re
from flask import Flask, request, jsonify, render_template_string
import win32print
import win32ui
import win32con
import pystray
from PIL import Image, ImageDraw

# ================================================================
# КОНСТАНТЫ
# ================================================================

DEFAULT_CONFIG = {
    "label_width_mm": 30,    # Ширина этикетки в мм
    "label_height_mm": 20,   # Высота этикетки в мм
    "dpi": 203,              # DPI принтера (203 - стандарт)
    "max_font_size": 100,    # Максимальный размер шрифта
    "min_font_size": 4,      # Минимальный размер шрифта
    "printer_name": ""       # Имя принтера (пусто = системный по умолчанию)
}

CONFIG_FILE = "config.json"   # Файл для сохранения настроек
PORT = 3000                   # Порт сервера
HOST = "0.0.0.0"              # Слушаем все интерфейсы


# ================================================================
# КЛАСС УПРАВЛЕНИЯ КОНФИГУРАЦИЕЙ
# ================================================================

class PrinterConfig:
    """Управление настройками принтера: загрузка/сохранение/доступ."""

    def __init__(self):
        self.load_config()

    def load_config(self):
        """Загружает настройки из файла или устанавливает значения по умолчанию."""
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                    config = json.load(f)
                    for key, value in DEFAULT_CONFIG.items():
                        setattr(self, key, config.get(key, value))
                return
            except:
                pass
        self.set_defaults()

    def set_defaults(self):
        """Устанавливает настройки по умолчанию."""
        for key, value in DEFAULT_CONFIG.items():
            setattr(self, key, value)

    def save_config(self):
        """Сохраняет текущие настройки в файл."""
        config = {key: getattr(self, key) for key in DEFAULT_CONFIG.keys()}
        try:
            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(config, f, indent=4, ensure_ascii=False)
            return True
        except:
            return False

    def get_printer_name(self):
        """Возвращает имя принтера: выбранное пользователем или системное по умолчанию."""
        if self.printer_name and self.printer_name in self.get_available_printers():
            return self.printer_name
        default = win32print.GetDefaultPrinter()
        return default if default else None

    def get_available_printers(self):
        """Возвращает список доступных принтеров в системе."""
        printers = []
        try:
            for printer in win32print.EnumPrinters(
                win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
            ):
                printers.append(printer[2])
        except:
            pass
        return printers


# ================================================================
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ================================================================

def get_local_ips():
    """Возвращает список локальных IP-адресов компьютера."""
    ips = []
    try:
        hostname = socket.gethostname()
        ip_list = socket.gethostbyname_ex(hostname)[2]
        ips.extend(ip_list)
        ips.append('127.0.0.1')
        ips = list(set(ips))
    except:
        ips = ['127.0.0.1']
    return ips


def format_cell_number(cell_number):
    """
    Форматирует номер ячейки:
    - Удаляет всё после дефиса ('-')
    - Добавляет точку в конце
    Пример: "A1-123" -> "A1."
    """
    formatted = re.sub(r'-.*', '', cell_number).strip() + "."
    return formatted


# ================================================================
# ФУНКЦИЯ ПЕЧАТИ
# ================================================================

def print_direct_to_printer(text):
    """
    Отправляет текст напрямую на принтер с центрированием.
    Возвращает (успех, сообщение).
    """
    try:
        printer_name = config.get_printer_name()
        if not printer_name:
            return False, "Не удалось определить принтер."

        # Открываем принтер
        hprinter = win32print.OpenPrinter(printer_name)
        if not hprinter:
            return False, f"Не удалось открыть принтер: {printer_name}"

        # Создаём контекст устройства для принтера
        hdc = win32ui.CreateDC()
        hdc.CreatePrinterDC(printer_name)
        hdc.StartDoc(text)
        hdc.StartPage()

        # Размеры этикетки в пикселях (с учётом DPI)
        label_width = int(config.label_width_mm * config.dpi / 25.4)
        label_height = int(config.label_height_mm * config.dpi / 25.4)

        # Настройка координатной системы
        hdc.SetMapMode(win32con.MM_TEXT)
        hdc.SetWindowExt((label_width, label_height))
        hdc.SetViewportExt((label_width, label_height))
        hdc.SetViewportOrg((0, 0))

        # Подбор оптимального размера шрифта (уменьшаем, пока текст не влезет)
        font_size = config.max_font_size
        text_width = 0
        text_height = 0

        while font_size > config.min_font_size:
            font = win32ui.CreateFont({
                "name": "Arial",
                "height": -font_size,
                "weight": win32con.FW_BOLD,
                "italic": False,
                "underline": False,
            })
            hdc.SelectObject(font)
            text_width, text_height = hdc.GetTextExtent(text)

            if text_width <= label_width and text_height <= label_height:
                break
            font_size -= 2

        # Центрирование текста
        x = (label_width - text_width) // 2
        y = (label_height - text_height) // 2

        # Вывод текста
        hdc.TextOut(x, y, text)

        # Завершение печати
        hdc.EndPage()
        hdc.EndDoc()
        win32print.ClosePrinter(hprinter)

        return True, f"Успешно отправлено на печать: {printer_name}"

    except Exception as e:
        return False, f"Ошибка печати: {str(e)}"


# ================================================================
# СОЗДАНИЕ ПРИЛОЖЕНИЯ FLASK
# ================================================================

config = PrinterConfig()
app = Flask(__name__)


# ================================================================
# HTML-ШАБЛОН ДЛЯ НАСТРОЕК
# ================================================================

SETTINGS_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>Настройки сервера</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: Arial, sans-serif;
            max-width: 700px;
            margin: 50px auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            border-bottom: 2px solid #4CAF50;
            padding-bottom: 10px;
        }
        .form-group { margin-bottom: 20px; }
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
            color: #555;
        }
        input, select {
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
        }
        input:focus, select:focus {
            outline: none;
            border-color: #4CAF50;
        }
        button {
            background: #4CAF50;
            color: white;
            border: none;
            padding: 12px 30px;
            font-size: 16px;
            border-radius: 4px;
            cursor: pointer;
            width: 100%;
            margin-top: 10px;
        }
        button:hover { background: #45a049; }
        .info {
            margin-top: 20px;
            padding: 15px;
            border-radius: 4px;
            font-size: 14px;
            display: none;
        }
        .info.success {
            display: block;
            background: #dff0d8;
            border-left: 4px solid #4CAF50;
        }
        .info.error {
            display: block;
            background: #f2dede;
            border-left: 4px solid #f44336;
        }
        .status-bar {
            margin-top: 20px;
            padding: 15px;
            background: #f9f9f9;
            border-radius: 4px;
            font-size: 13px;
            border: 1px solid #e0e0e0;
        }
        .status-bar td { padding: 4px 8px; }
        .status-bar tr:nth-child(even) { background: #f5f5f5; }
        .status-label { font-weight: bold; color: #555; }
        .ip-tag {
            display: inline-block;
            background: #e8f5e9;
            padding: 2px 8px;
            margin: 2px;
            border-radius: 3px;
            font-size: 12px;
            font-family: monospace;
        }
        small { color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🖨️ Настройки печати</h1>
        <form id="settingsForm">
            <div class="form-group">
                <label>Принтер:</label>
                <select id="printer" name="printer">
                    {% for printer in printers %}
                        <option value="{{ printer }}" {% if printer == config.printer_name %}selected{% endif %}>
                            {{ printer }}
                        </option>
                    {% endfor %}
                </select>
            </div>
            <div class="form-group">
                <label>Ширина наклейки (мм):</label>
                <input type="number" id="label_width" name="label_width"
                       value="{{ config.label_width_mm }}" min="10" max="100" step="1">
            </div>
            <div class="form-group">
                <label>Высота наклейки (мм):</label>
                <input type="number" id="label_height" name="label_height"
                       value="{{ config.label_height_mm }}" min="10" max="100" step="1">
            </div>
            <div class="form-group">
                <label>DPI (точек на дюйм):</label>
                <input type="number" id="dpi" name="dpi"
                       value="{{ config.dpi }}" min="100" max="600" step="1">
                <small>203 - стандарт для термотрансферных принтеров</small>
            </div>
            <div class="form-group">
                <label>Максимальный размер шрифта:</label>
                <input type="number" id="max_font_size" name="max_font_size"
                       value="{{ config.max_font_size }}" min="10" max="200" step="1">
            </div>
            <div class="form-group">
                <label>Минимальный размер шрифта:</label>
                <input type="number" id="min_font_size" name="min_font_size"
                       value="{{ config.min_font_size }}" min="4" max="50" step="1">
            </div>
            <button type="submit">💾 Сохранить настройки</button>
        </form>

        <div id="message" class="info"></div>

        <div class="status-bar">
            <strong>📌 Информация о сервере:</strong><br>
            <table style="width:100%; margin-top:10px; border-collapse:collapse;">
                <tr><td class="status-label">Статус сервера:</td><td>✅ Запущен</td></tr>
                <tr><td class="status-label">IP-адреса:</td><td>
                    {% for ip in ips %}<span class="ip-tag">{{ ip }}:3000</span>{% endfor %}
                </td></tr>
                <tr><td class="status-label">Порт:</td><td>3000</td></tr>
                <tr><td class="status-label">Принтер:</td><td>{{ config.get_printer_name() or 'Не выбран' }}</td></tr>
                <tr><td class="status-label">Ширина наклейки:</td><td>{{ config.label_width_mm }} мм</td></tr>
                <tr><td class="status-label">Высота наклейки:</td><td>{{ config.label_height_mm }} мм</td></tr>
                <tr><td class="status-label">DPI:</td><td>{{ config.dpi }}</td></tr>
                <tr><td class="status-label">Макс. размер шрифта:</td><td>{{ config.max_font_size }}</td></tr>
                <tr><td class="status-label">Мин. размер шрифта:</td><td>{{ config.min_font_size }}</td></tr>
                <tr><td class="status-label">Файл конфигурации:</td><td>{{ config_file }}</td></tr>
            </table>
        </div>
    </div>

    <script>
        document.getElementById('settingsForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            const formData = new FormData(this);
            const data = {};
            formData.forEach((value, key) => { data[key] = value; });

            try {
                const response = await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await response.json();
                const msg = document.getElementById('message');
                if (result.status === 'success') {
                    msg.className = 'info success';
                    msg.textContent = '✅ ' + result.message;
                    setTimeout(() => location.reload(), 1500);
                } else {
                    msg.className = 'info error';
                    msg.textContent = '❌ ' + result.message;
                }
            } catch (error) {
                const msg = document.getElementById('message');
                msg.className = 'info error';
                msg.textContent = '❌ Ошибка: ' + error.message;
            }
        });
    </script>
</body>
</html>
"""


# ================================================================
# МАРШРУТЫ FLASK
# ================================================================

@app.route('/')
def index():
    """Главный маршрут — информация о сервере."""
    return jsonify({
        "status": "running",
        "server": "StickerPrint server",
        "version": "1.0",
        "host": "0.0.0.0 (все интерфейсы)",
        "port": PORT,
        "ip_addresses": get_local_ips(),
        "endpoints": {
            "settings": "/settings",
            "print": "/print (POST)",
            "api_settings": "/api/settings (POST)",
            "api_printers": "/api/printers (GET)"
        },
        "config": {
            "printer": config.get_printer_name() or "Не выбран",
            "label_width_mm": config.label_width_mm,
            "label_height_mm": config.label_height_mm,
            "dpi": config.dpi,
            "max_font_size": config.max_font_size,
            "min_font_size": config.min_font_size
        }
    })


@app.route('/settings')
def settings_page():
    """Страница веб-интерфейса для настройки принтера."""
    return render_template_string(
        SETTINGS_HTML,
        config=config,
        printers=config.get_available_printers(),
        config_file=CONFIG_FILE,
        ips=get_local_ips()
    )


@app.route('/api/settings', methods=['POST'])
def save_settings():
    """API: сохранение настроек принтера."""
    try:
        data = request.json

        # Обновляем настройки из запроса
        config.label_width_mm = float(data.get('label_width', DEFAULT_CONFIG['label_width_mm']))
        config.label_height_mm = float(data.get('label_height', DEFAULT_CONFIG['label_height_mm']))
        config.dpi = int(data.get('dpi', DEFAULT_CONFIG['dpi']))
        config.max_font_size = int(data.get('max_font_size', DEFAULT_CONFIG['max_font_size']))
        config.min_font_size = int(data.get('min_font_size', DEFAULT_CONFIG['min_font_size']))
        config.printer_name = data.get('printer', '')

        if config.save_config():
            return jsonify({"status": "success", "message": "Настройки сохранены"})
        else:
            return jsonify({"status": "error", "message": "Ошибка сохранения настроек"}), 500

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 400


@app.route('/api/printers')
def get_printers():
    """API: получение списка доступных принтеров."""
    return jsonify({"printers": config.get_available_printers()})


@app.route('/print', methods=['POST'])
def print_cell_number():
    """
    API: отправка номера ячейки на печать.
    Ожидает JSON: { "cellNumber": "A1-123" }
    """
    data = request.json
    if not data:
        return jsonify({"status": "error", "message": "Некорректный JSON."}), 400

    cell_number = data.get('cellNumber')
    if not cell_number:
        return jsonify({"status": "error", "message": "Номер ячейки не указан."}), 400

    # Форматируем номер и отправляем на печать
    formatted = format_cell_number(cell_number)
    success, message = print_direct_to_printer(formatted)

    if not success:
        return jsonify({
            "status": "error",
            "error_type": "printer_error",
            "message": message
        }), 500

    return jsonify({
        "status": "success",
        "message": f"Ячейка '{formatted}' отправлена на печать",
        "printer": config.get_printer_name()
    })


# ================================================================
# СИСТЕМНЫЙ ТРЕЙ (TRAY ICON)
# ================================================================

def create_tray_icon():
    """Создаёт иконку в системном трее с меню."""
    # Ищем файл иконки
    icon_path = None
    for ext in ['.ico', '.png']:
        for name in ['icon', 'printer', 'label']:
            test_path = name + ext
            if os.path.exists(test_path):
                icon_path = os.path.abspath(test_path)
                break
        if icon_path:
            break

    # Загружаем иконку или создаём простую
    if icon_path:
        image = Image.open(icon_path)
    else:
        image = Image.new('RGB', (64, 64), color='#4CAF50')
        draw = ImageDraw.Draw(image)
        draw.text((16, 16), "P", fill='white')

    # Меню трея
    def on_settings(icon, item):
        webbrowser.open(f'http://localhost:{PORT}/settings')

    def on_exit(icon, item):
        icon.stop()
        os._exit(0)

    return pystray.Icon(
        "printer_server",
        image,
        "StickerPrint server",
        menu=pystray.Menu(
            pystray.MenuItem("🖨️ Настройки", on_settings),
            pystray.MenuItem("🚪 Выход", on_exit)
        )
    )


# ================================================================
# ЗАПУСК СЕРВЕРА
# ================================================================

def run_server():
    """Запускает Flask-сервер."""
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False)


def main():
    """Главная функция: запускает сервер в отдельном потоке и открывает трей."""
    # Сервер в отдельном потоке (daemon, чтобы завершался с основным)
    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()

    # Иконка в трее (блокирует основной поток)
    icon = create_tray_icon()
    icon.run()


if __name__ == '__main__':
    main()