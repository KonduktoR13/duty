import { registerSW } from 'virtual:pwa-register'
import { parsePdf } from './parser'
import { storage } from './db'
import { humanMonth, normalizeCrossMonth, timeLabel } from './schedule'
import type { Candidate, MonthRecord, ParsedSchedule, Shift } from './types'
import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')!
let months: MonthRecord[]=[]; let selected=''; let pending: {file:File; parsed:ParsedSchedule}|null=null
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | undefined
const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!))
const today=new Date().toISOString().slice(0,10)
async function refresh(){months=await storage.months();selected=selected&&months.some(m=>m.id===selected)?selected:(months[0]?.id||'');render()}
function shifts(){return normalizeCrossMonth(months.flatMap(x=>x.shifts))}
function nextShift(){return shifts().find(x=>x.date>=today)}
function render(){ const active=months.find(x=>x.id===selected); const next=nextShift(); app.innerHTML=`<main>
 <header><div class="brand"><span>▣</span><div><h1>Мои смены</h1><small>Только на этом устройстве</small></div></div><button class="icon" id="settings" aria-label="Настройки">⚙</button></header>
 ${!months.length?welcome():`<section class="hero"><p>Ближайшая смена</p>${next?`<h2>${date(next.date)}</h2><strong>${next.hours} ч</strong><span>${timeLabel(next)} · ${esc(next.code)}</span>`:'<h2>График не загружен</h2><span>Добавьте следующий месячный PDF</span>'}</section>${monthView(active!)}`}
 </main><input id="file" type="file" accept="application/pdf,.pdf" hidden><dialog id="dialog"></dialog>`; bind() }
function welcome(){return `<section class="welcome"><div class="shield">⌂</div><h2>Ваш график остаётся вашим</h2><p>PDF обрабатывается прямо в браузере и сохраняется только на этом устройстве. Мы не отправляем файл, смены или Delta-номер на сервер.</p><button class="primary" id="import">Выбрать PDF-график</button><small>Поддерживаются месячные PDF Delta. Интернет для импорта не нужен после установки.</small></section>`}
function monthView(m:MonthRecord){const d=new Date(`${m.id}-01T12:00:00`);const first=(d.getDay()+6)%7;const days=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();const byDay=new Map(m.shifts.map(s=>[Number(s.date.slice(8)),s]));const cells=Array.from({length:first},()=>'<i></i>').concat(Array.from({length:days},(_,i)=>{const s=byDay.get(i+1);return `<button class="day ${s?'work':''} ${s?.date===today?'today':''}" ${s?`data-shift="${i+1}"`:''}><b>${i+1}</b>${s?`<small>${esc(s.code)}</small>`:''}</button>`})).join('');return `<nav class="months"><button id="prev" ${!adjacent(-1)?'disabled':''}>‹</button><button id="picker">${humanMonth(m.id)}</button><button id="next" ${!adjacent(1)?'disabled':''}>›</button></nav><section class="calendar"><div class="week">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(x=>`<span>${x}</span>`).join('')}</div><div class="grid">${cells}</div></section><section class="agenda"><div><h2>Смены за месяц</h2><span>${m.shifts.length} шт. · ${m.status==='changed'?'есть изменения':'локально сохранён'}</span></div>${m.shifts.length?m.shifts.map(s=>`<article><time>${date(s.date)}</time><b>${s.hours} ч</b><span>${timeLabel(s)} · ${esc(s.code)}</span></article>`).join(''):'<p>В выбранной строке нет смен.</p>'}</section><button class="add" id="import">＋ <span>Импортировать PDF</span></button>`}
function date(v:string){return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',weekday:'short'}).format(new Date(`${v}T12:00:00`))}
function adjacent(n:number){const i=months.findIndex(x=>x.id===selected);return months[i+n]}
function bind(){document.querySelector('#import')?.addEventListener('click',()=>document.querySelector<HTMLInputElement>('#file')!.click());document.querySelector('#file')?.addEventListener('change',onFile);document.querySelector('#prev')?.addEventListener('click',()=>{selected=adjacent(-1)!.id;render()});document.querySelector('#next')?.addEventListener('click',()=>{selected=adjacent(1)!.id;render()});document.querySelector('#picker')?.addEventListener('click',showMonths);document.querySelector('#settings')?.addEventListener('click',showSettings)}
async function onFile(e:Event){const file=(e.target as HTMLInputElement).files?.[0];if(!file)return; try{open(`<div class="busy"><div class="spinner"></div><h2>Анализируем PDF</h2><p>Файл не покидает ваше устройство.</p></div>`);const parsed=await parsePdf(file);pending={file,parsed};chooseDelta(parsed)}catch(error){open(`<h2>Не удалось прочитать график</h2><p>${esc(error instanceof Error?error.message:'Неизвестная ошибка')}</p><button class="primary" autofocus>Закрыть</button>`);(document.querySelector('dialog button') as HTMLButtonElement).onclick=close}finally{(e.target as HTMLInputElement).value=''}}
function chooseDelta(p:ParsedSchedule){const preferred=months[0]?.deltaNumber;open(`<h2>Чей это график?</h2><p>${humanMonth(p.month)} · найдены номера из PDF. ${p.warnings.join(' ')}</p><div class="choices">${p.candidates.map(c=>`<button data-delta="${c.number}" class="choice ${c.number===preferred?'recommended':''}"><b>${c.number}</b><span>${c.shifts.length} смен${c.number===preferred?' · использовали раньше':''}</span></button>`).join('')}</div><button id="cancel">Отмена</button>`);document.querySelectorAll<HTMLButtonElement>('[data-delta]').forEach(b=>b.onclick=()=>savePick(p.candidates.find(x=>x.number===b.dataset.delta)!));document.querySelector('#cancel')!.addEventListener('click',close)}
async function savePick(c:Candidate){if(!pending)return;const old=months.find(m=>m.id===pending!.parsed.month);const hash=await digest(pending.file);const record:MonthRecord={id:pending.parsed.month,fileName:pending.file.name,importedAt:Date.now(),hash,shifts:c.shifts,deltaNumber:c.number,status:old&&old.hash!==hash?'changed':'local',calendar:{dirty:true}};await storage.put(record);await storage.set('deltaNumber',c.number);close();pending=null;selected=record.id;await refresh();if(!old)calendarOffer()}
async function digest(file:File){const a=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return [...new Uint8Array(a)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function showMonths(){open(`<h2>Загруженные месяцы</h2><div class="choices">${months.map(m=>`<button class="choice" data-month="${m.id}"><b>${humanMonth(m.id)}</b><span>${esc(m.fileName)} · ${m.shifts.length} смен</span></button>`).join('')}</div><button id="close">Закрыть</button>`);document.querySelectorAll('[data-month]').forEach(b=>b.addEventListener('click',()=>{selected=(b as HTMLElement).dataset.month!;close();render()}));document.querySelector('#close')!.addEventListener('click',close)}
function calendarOffer(){setTimeout(()=>open(`<h2>Синхронизировать с Google Calendar?</h2><p>В будущем вы сможете по явному действию создать отдельный календарь смен. Сейчас интеграция ожидает настройки безопасного OAuth Client ID — приложение полностью работает и без неё.</p><button class="primary" id="ok">Понятно</button>`),60);setTimeout(()=>document.querySelector('#ok')?.addEventListener('click',close),70)}
function showSettings(){open(`<h2>Настройки</h2><p>Данные хранятся в IndexedDB браузера. Удаление нельзя отменить.</p><button class="danger" id="wipe">Удалить все локальные данные</button><button id="close">Закрыть</button>`);document.querySelector('#close')!.addEventListener('click',close);document.querySelector('#wipe')!.addEventListener('click',async()=>{if(confirm('Удалить все PDF-метаданные, смены и настройки с этого устройства?')){await storage.clear();close();await refresh()}})}
function open(html:string){const d=document.querySelector<HTMLDialogElement>('#dialog')!;d.innerHTML=html;d.showModal()}function close(){document.querySelector<HTMLDialogElement>('#dialog')?.close()}
function offerUpdate() {
  if (document.querySelector('#update-notice')) return
  const notice = document.createElement('aside')
  notice.id = 'update-notice'; notice.setAttribute('role', 'status')
  notice.innerHTML = `<div><b>Доступна новая версия</b><span>Ваши сохранённые графики останутся на устройстве.</span></div><button class="primary">Перезапустить</button>`
  notice.querySelector('button')!.addEventListener('click', async () => {
    const button = notice.querySelector('button') as HTMLButtonElement
    button.disabled = true; button.textContent = 'Обновляем…'
    // Sends SKIP_WAITING and reloads only after the new worker controls this page.
    await applyUpdate?.(true)
  })
  document.body.append(notice)
}
applyUpdate = registerSW({ onNeedRefresh: offerUpdate })
refresh()
