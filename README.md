# Мои смены — PWA

Local-first PWA для личного рабочего графика из месячного PDF Delta. В приложении нет backend, аналитики, рекламы или внешних runtime-запросов: PDF читается PDF.js в браузере, а результаты хранятся в IndexedDB данного браузера.

## Запуск и проверка

```bash
npm install
npm run dev
npm test
npm run build
```

`dist/` — готовая статическая публикация. Для GitHub Pages в репозитории `my-shifts` собрать с `VITE_BASE=/my-shifts/ npm run build`.

## Архитектура

- `src/parser.ts` — координатный парсер первой страницы: находит строку заголовков дней, все строки `D…`, затем собирает ячейки по их горизонтальным центрам. Месяц определяется из текста PDF (et/en/ru). При отсутствии всех дней, Delta-строк или месяца импорт прекращается, а не угадывает данные.
- `src/schedule.ts` — доменные правила. В частности, `16` последнего дня + обычный `8` первого дня следующего месяца образуют `24` часа; `8P` самостоятельная смена.
- `src/db.ts` — IndexedDB stores `months` и `settings`; schema versioned, поэтому будущие миграции добавляются в `onupgradeneeded` без очистки данных.
- `src/main.ts` — mobile-first UI и import flow. Повторный импорт заменяет месяц, SHA-256 фиксирует версию файла; месяц никогда не дублируется.

Исходные PDF сознательно не сохраняются: это сокращает чувствительные локальные данные, при этом импорт, просмотр смен и обновление месяца доступны offline. В `MonthRecord` хранятся имя, хэш, время импорта, выбранный Delta-номер, смены и подготовленный статус calendar sync.

## Offline, PWA и privacy

Vite PWA генерирует manifest и Service Worker с precache приложения и локальной копией PDF.js worker. При обновлении SW запрашивает подтверждение; IndexedDB не находится в cache и не удаляется. После первого открытия приложение запускается и импортирует PDF без сети. CSP ограничивает скрипты, подключения и workers собственным origin. Для GitHub Pages нужен HTTPS (предоставляется Pages).

На iOS Safari установите через Share → Add to Home Screen. Проверка Safari/iOS из Linux не выполнялась; ручной чек-лист: standalone запуск без сети, safe-area на iPhone с notch, импорт из Files, dark/light theme, удаление данных и обновление PWA.

## Google Calendar: будущая интеграция

UI намеренно не включает фальшивую авторизацию. Для подключения нужно: создать Google Cloud project, включить Calendar API, настроить OAuth consent screen, создать **Web application** OAuth Client ID, добавить production origin и redirect URI GitHub Pages, и передать только публичный Client ID через build-time environment variable. Никогда не добавляйте client secret во frontend.

Реализация должна использовать Google Identity Services с минимальным scope `https://www.googleapis.com/auth/calendar.app.created`, создать отдельный календарь приложения и сохранять локально `calendarId`, event IDs и fingerprint каждой смены. По ручной команде sync сравнивает fingerprints: создаёт новые события, patch-ит изменённые, удаляет только ранее созданные приложением; `syncedAt` и `dirty` уже предусмотрены в модели. OAuth access tokens держать только в памяти/стандартной browser session, не в IndexedDB.

## GitHub Pages вручную

1. Создайте репозиторий и отправьте этот каталог в него.
2. Добавьте workflow, который запускает `npm ci`, `VITE_BASE=/${{ github.event.repository.name }}/ npm run build`, затем публикует `dist` через `actions/upload-pages-artifact` и `actions/deploy-pages`.
3. В Settings → Pages выберите GitHub Actions.
4. После публикации внесите точный Pages URL в OAuth allowed origins/redirects при подключении Calendar.

## Тесты и ограничения

`npm test` проверяет month parsing, координатное сопоставление ячеек и правило границы месяцев. Перед релизом расширяйте fixtures реальными обезличенными PDF/ожидаемыми сменами из `../verification/PARSER_AUDIT.md`; тестировать на настоящих персональных PDF в публичном репозитории нельзя. Проверку Android Chrome и desktop Chromium можно выполнить через browser automation после `npm run dev`; Safari требует физического Apple-устройства.
