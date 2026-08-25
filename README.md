# Мои смены — PWA

Local-first PWA для личного рабочего графика из месячного PDF Delta. В приложении нет backend, аналитики или рекламы: PDF читается PDF.js в браузере, а результаты хранятся в IndexedDB данного браузера. Внешние запросы выполняются только после явного действия пользователя для optional-интеграции Google Calendar.

## Запуск и проверка

```bash
npm install
npm run dev
npm test
npm run build
```

`dist/` — готовая статическая публикация. Для GitHub Pages в репозитории `my-shifts` собрать с `VITE_BASE=/my-shifts/ npm run build`.

## Архитектура

- `src/parser.ts` — координатный парсер первой страницы: находит строку заголовков дней и все строки `D…`, включая нижние слои ячейки. Поэтому `12 + V4`, `8P + V8` и разбитое на две строки `V8,25` сохраняются как отдельные отметки одного дня. Неизвестные коды (`#…`, `Õ`, `P-et`, `TK4`) сохраняются дословно, а не превращаются в часы по догадке.
- `src/schedule.ts` — доменные правила. В частности, точная пара `16` последнего дня + обычный `8` первого дня следующего месяца отображается как одна суточная смена `24`; `8P` и `V8` самостоятельны.
- `src/roster.ts` — выбор текущего D-номера, нормализация его смен через месяцы и read-only представление смен других D-номеров. Все D-строки PDF остаются локально доступными после импорта.
- `src/calendar-sync.ts` — чистая модель Google-событий, idempotent diff, ownership markers, обнаружение ручных изменений/удалений и безопасный apply-план.
- `src/google-calendar.ts` — lazy-loaded Google Identity Services и минимальный Calendar REST gateway. Access token существует только в памяти вкладки.
- `src/db.ts` — versioned IndexedDB stores `months`, `pdfs`, `settings` и отдельный `syncs`; обновление схемы не очищает данные.
- `src/main.ts` — mobile-first UI и import/sync flows. Повторный импорт заменяет месяц, SHA-256 фиксирует версию файла; месяц никогда не дублируется.

Оригинальный PDF сохраняется только в локальном IndexedDB приложения вместе с именем, хэшем, временем импорта, выбранным Delta-номером, сменами и статусом calendar sync. Это позволяет открыть исходный файл offline на вкладке «Графики». Удаление месяца удаляет лишь эту внутреннюю копию и данные PWA; исходный файл пользователя в «Загрузках» или Files не затрагивается.

## Offline, PWA и privacy

Vite PWA генерирует manifest и Service Worker с precache приложения и локальной копией PDF.js worker. При обновлении SW запрашивает подтверждение; IndexedDB не находится в cache и не удаляется. После первого открытия приложение запускается и импортирует PDF без сети. CSP ограничивает скрипты, подключения и workers собственным origin. Для GitHub Pages нужен HTTPS (предоставляется Pages).

На iOS Safari установите через Share → Add to Home Screen. Проверка Safari/iOS из Linux не выполнялась; ручной чек-лист: standalone запуск без сети, safe-area на iPhone с notch, импорт из Files, dark/light theme, удаление данных и обновление PWA.

## Google Calendar

Интеграция использует Google Identity Services token model без backend и без client secret. Запрашивается только scope `https://www.googleapis.com/auth/calendar.events.owned`; события создаются в `primary`. PDF, остальные строки графика и access token в Google не передаются и долговременно не сохраняются.

Каждое событие получает `extendedProperties.private` с marker, месяцем, D-номером и стабильным sync key. Переходящая через полночь смена остаётся одной логической сменой, но записывается в Google двумя timed events до и после `00:00`; оба сегмента имеют общий `shiftId` и признаки `part=1/2`, `part=2/2`. Diff, обновление и удаление обрабатывают такую пару как одну смену. Перед patch/delete PWA заново читает событие и проверяет все marker-поля; событие без точного marker никогда не меняется. Локальный `syncs` store сохраняет event ID, последний подтверждённый draft и etag. Поэтому повторный импорт показывает add/change/remove diff, повторная синхронизация не создаёт дублей, а ручные правки или удаления в Google обнаруживаются до восстановления по PDF.

Для опубликованной Pages-версии в OAuth Web Client нужно добавить Authorized JavaScript Origin ровно `https://konduktor13.github.io` — без `/duty/`, завершающего `/`, query или fragment. Redirect URI для GIS token popup flow не требуется.

## GitHub Pages вручную

1. Создайте репозиторий и отправьте этот каталог в него.
2. Добавьте workflow, который запускает `npm ci`, `VITE_BASE=/${{ github.event.repository.name }}/ npm run build`, затем публикует `dist` через `actions/upload-pages-artifact` и `actions/deploy-pages`.
3. В Settings → Pages выберите GitHub Actions.
4. После публикации внесите origin хоста Pages (без пути репозитория) в OAuth Authorized JavaScript origins.

## Тесты и ограничения

`npm test` проверяет PDF parsing, многослойные V-коды, повёрнутую таблицу, границы месяцев, переключение D-номера, чужие смены, IndexedDB migration boundaries и Google sync add/change/remove/idempotency/ownership. Реальные персональные PDF читаются только локальными regression-тестами вне публичного репозитория. Safari требует проверки на физическом Apple-устройстве.
