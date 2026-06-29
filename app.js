/**
 * app.js — Sorteo de Rifa SPA (v3)
 * ============================================================
 * Módulos:
 *   0. Utilidades globales   — esc(), toggle()
 *   1. ParticleBackground    — fondo animado
 *   2. FileLoader            — carga .xlsx / .json
 *   3. RandomPicker          — rejection sampling (sin sesgo)
 *   4. Roulette              — slot-machine cancellable
 *   5. WinnerDisplay         — ganador + historial + confetti
 *   6. App                   — controlador principal
 *
 * Fixes:
 *   - Rejection sampling: distribución uniforme con 500 participantes
 *   - dragleave: verifica relatedTarget para evitar parpadeo
 *   - Drop global: valida extensión antes de procesar
 *   - esc() unificada en un solo lugar (sin duplicados)
 *
 * Features:
 *   - Cancelar sorteo (botón + tecla Escape)
 *   - Excluir ganadores anteriores (checkbox)
 *   - Historial de ganadores acumulable
 *   - "Cambiar lista" sin recargar la página
 *   - Vista previa de participantes colapsable (ganadores tachados)
 * ============================================================
 */

'use strict';

/* ================================================================
   0. UTILIDADES GLOBALES
   Funciones compartidas por todos los módulos.
   ================================================================ */

/**
 * Escapa caracteres HTML para prevenir XSS.
 * Función ÚNICA en toda la app — no duplicar en módulos.
 * @param {*} val  Cualquier valor (se convierte a string)
 * @returns {string}
 */
function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Muestra u oculta un elemento via el atributo [hidden].
 * @param {HTMLElement} el
 * @param {boolean} visible
 */
function toggle(el, visible) {
  el.hidden = !visible;
}

/* ================================================================
   1. SOUND SYSTEM
   Efectos de audio simples con Web Audio API.
   ================================================================ */
const SoundSystem = (() => {
  let audioCtx = null;
  let unlocked = false;

  function ensureContext() {
    if (!audioCtx) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      audioCtx = new AudioCtor();
    }
    return audioCtx;
  }

  function unlock() {
    if (unlocked) return;
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    unlocked = true;
  }

  function playTone(freq, duration, type = 'sine', volume = 0.04, slide = 0, delay = 0) {
    const ctx = ensureContext();
    if (!ctx) return;
    unlock();

    const startTime = ctx.currentTime + delay;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, startTime + duration);

    osc.connect(gain).connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  function play(kind) {
    unlock();
    switch (kind) {
      case 'upload':
        playTone(880, 0.08, 'triangle', 0.03);
        playTone(1320, 0.12, 'sine', 0.02, 1.18, 0.05);
        break;
      case 'draw':
        playTone(440, 0.14, 'sawtooth', 0.025);
        playTone(660, 0.18, 'triangle', 0.02, 1.35, 0.08);
        break;
      case 'cancel':
        playTone(220, 0.12, 'square', 0.025);
        playTone(180, 0.14, 'sine', 0.02, 0.82, 0.06);
        break;
      case 'winner':
        playTone(523.25, 0.16, 'triangle', 0.035);
        playTone(659.25, 0.16, 'sine', 0.03, 1.26, 0.08);
        playTone(783.99, 0.2, 'sine', 0.025, 1.5, 0.16);
        break;
      case 'copy':
        playTone(860, 0.08, 'square', 0.02);
        break;
      case 'reset':
        playTone(500, 0.08, 'sine', 0.02);
        playTone(400, 0.10, 'sine', 0.015, 0.8, 0.06);
        break;
      default:
        break;
    }
  }

  document.addEventListener('pointerdown', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });

  return { play };
})();


/* ================================================================
   2. PARTICLE BACKGROUND
   Partículas decorativas flotantes en el fondo.
   ================================================================ */
const ParticleBackground = (() => {
  const container = document.getElementById('bgParticles');

  function createParticle() {
    const el   = document.createElement('div');
    el.className = 'particle';
    const colors = [
      'rgba(124,58,237,0.7)', 'rgba(236,72,153,0.6)',
      'rgba(251,191,36,0.5)', 'rgba(16,185,129,0.4)',
    ];
    const size     = Math.random() * 5 + 2;
    const left     = Math.random() * 100;
    const delay    = Math.random() * 15;
    const duration = Math.random() * 12 + 10;
    const color    = colors[Math.floor(Math.random() * colors.length)];
    Object.assign(el.style, {
      width: `${size}px`, height: `${size}px`, left: `${left}%`, bottom: '0',
      background: color, boxShadow: `0 0 ${size * 2}px ${color}`,
      animationDuration: `${duration}s`, animationDelay: `${delay}s`,
    });
    container.appendChild(el);
  }

  function init(count = 35) {
    for (let i = 0; i < count; i++) createParticle();
  }

  return { init };
})();


/* ================================================================
   2. FILE LOADER
   Carga y parsea .xlsx y .json.
   ================================================================ */
const FileLoader = (() => {

  /** Normaliza un valor: trim si es string, o lo deja como está. */
  function clean(v) { return typeof v === 'string' ? v.trim() : v; }

  /**
   * Detecta la clave de nombre en un objeto.
   * Prioridad: comprador > nombre > name > participante > ...
   * Evita usar '_id' como fallback.
   */
  function detectNameKey(keys) {
    const priority = ['comprador', 'nombre', 'name', 'participante',
                      'participantes', 'ganador', 'persona', 'full_name'];
    return (
      keys.find(k => priority.includes(k.toLowerCase().trim())) ||
      keys.find(k => k !== '_id') ||
      keys[0]
    );
  }

  /** Construye un objeto participante normalizado. */
  function buildParticipant(raw, nameKey) {
    const cleaned = {};
    for (const [k, v] of Object.entries(raw)) cleaned[k] = clean(v);
    const raw_name = cleaned[nameKey];
    return {
      nombre: typeof raw_name === 'string' ? raw_name : String(raw_name ?? ''),
      ...cleaned,
    };
  }

  /**
   * Parsea Excel con SheetJS.
   * @param {File} file
   * @returns {Promise<Array>}
   */
  function parseExcel(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb    = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const rows  = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
          if (!rows.length) return reject(new Error('El archivo Excel está vacío.'));
          const nameKey = detectNameKey(Object.keys(rows[0]));
          const list    = rows.map(r => buildParticipant(r, nameKey))
                             .filter(p => p.nombre !== '' && p.nombre !== 'undefined');
          if (!list.length) return reject(new Error(`No se encontraron nombres en "${nameKey}".`));
          resolve(list);
        } catch (err) { reject(new Error(`Error al leer Excel: ${err.message}`)); }
      };
      reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Parsea JSON.
   * Acepta: array de strings, array de objetos.
   * @param {File} file
   * @returns {Promise<Array>}
   */
  function parseJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const raw = JSON.parse(e.target.result);
          if (!Array.isArray(raw) || !raw.length)
            return reject(new Error('El JSON debe ser un array no vacío.'));

          let list;
          if (typeof raw[0] === 'string') {
            // Formato: ["Ana", "Luis", ...]
            list = raw.map(s => ({ nombre: String(s).trim() }))
                      .filter(p => p.nombre !== '');
          } else if (typeof raw[0] === 'object' && raw[0] !== null) {
            const nameKey = detectNameKey(Object.keys(raw[0]));
            list = raw.map(obj => buildParticipant(obj, nameKey))
                      .filter(p => p.nombre !== '' && p.nombre !== 'undefined');
          } else {
            return reject(new Error('Formato JSON no reconocido.'));
          }

          if (!list.length) return reject(new Error('No se encontraron participantes válidos.'));
          resolve(list);
        } catch (err) { reject(new Error(`Error en JSON: ${err.message}`)); }
      };
      reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
      reader.readAsText(file, 'UTF-8');
    });
  }

  /**
   * Valida la extensión del archivo.
   * @param {File} file
   * @returns {boolean}
   */
  function isValidExtension(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    return ['xlsx', 'xls', 'json'].includes(ext);
  }

  /**
   * Punto de entrada público.
   * @param {File} file
   * @returns {Promise<Array>}
   */
  async function load(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'json') return parseJSON(file);
    if (['xlsx', 'xls'].includes(ext)) return parseExcel(file);
    throw new Error('Tipo de archivo no soportado. Usá .xlsx o .json');
  }

  return { load, isValidExtension };
})();


/* ================================================================
   3. RANDOM PICKER
   Selección con crypto.getRandomValues() + rejection sampling.

   Por qué rejection sampling:
     Math.floor(2³² / 500) * 500 = 4294967000 ≠ 2³²
     → 296 valores de 4294967000 a 2³²-1 caen en [0,295] extra
     → sesgo de ≈ 0.007% por participante
   Con rejection sampling: distribución matemáticamente uniforme.
   ================================================================ */
const RandomPicker = (() => {

  /**
   * Entero aleatorio en [0, max) SIN sesgo.
   * Descarta valores en la zona de sesgo y vuelve a intentar.
   * Con max=500 la probabilidad de reintentar es ≈0.007%, prácticamente gratis.
   * @param {number} max
   * @returns {number}
   */
  function secureRandomInt(max) {
    // Límite superior del rango "seguro": mayor múltiplo de max que cabe en Uint32
    const limit = Math.floor(0x100000000 / max) * max;
    const buf   = new Uint32Array(1);
    let n;
    do {
      crypto.getRandomValues(buf);
      n = buf[0];
    } while (n >= limit);  // rechazar valores sesgados
    return n % max;
  }

  /**
   * Elige un participante al azar del pool.
   * @param {Array} pool  Puede ser un subconjunto filtrado
   * @returns {{ winner: object, index: number }}  index dentro del pool
   */
  function pick(pool) {
    const index  = secureRandomInt(pool.length);
    const winner = pool[index];
    return { winner, index };
  }

  return { pick, secureRandomInt };
})();


/* ================================================================
   4. ROULETTE
   Slot-machine CSS cancellable.
   Acepta una señal { cancelled: boolean } para interrumpir el sorteo.
   ================================================================ */
const Roulette = (() => {

  const DURATION_MS = 5000;  // duración total de la animación
  const SPEED_MIN   = 55;    // ms entre cambios al inicio (muy rápido)
  const SPEED_MAX   = 520;   // ms entre cambios al final (lento)

  const track = document.getElementById('rouletteTrack');

  /**
   * Texto durante la ANIMACIÓN: solo el número (sin nombre).
   * Esto crea el efecto de slot-machine con números grandes y dramáticos.
   * Si no hay número, muestra el nombre completo como fallback.
   * @param {object} p
   * @returns {string}
   */
  function previewText(p) {
    const num = p.numero ?? p.ticket ?? p.boleto ?? p.number ?? null;
    return num !== null ? String(num) : (p.comprador ?? p.nombre ?? p.name ?? '');
  }

  /**
   * Texto FINAL del ganador: número + nombre completo.
   * Solo se muestra al detenerse la ruleta.
   * @param {object} p
   * @returns {string}
   */
  function finalText(p) {
    const num  = p.numero ?? p.ticket ?? p.boleto ?? p.number ?? null;
    const name = p.comprador ?? p.nombre ?? p.name ?? '';
    return num !== null ? `#${num}  —  ${name}` : name;
  }

  /**
   * Renderiza un item en el track con animación CSS slide+blur.
   * @param {string} text
   * @param {number} duration  Duración CSS en ms
   */
  function renderItem(text, duration) {
    const old = track.querySelector('.slot-item');
    if (old) {
      old.style.setProperty('--dur', `${Math.min(duration * 0.55, 180)}ms`);
      old.classList.add('slot-exit');
      old.addEventListener('animationend', () => old.remove(), { once: true });
    }
    const el = document.createElement('div');
    el.className = 'slot-item slot-enter';
    el.style.setProperty('--dur', `${Math.min(duration * 0.65, 220)}ms`);
    el.innerHTML = esc(text);
    track.appendChild(el);
  }

  /** Limpia el track (usado al cancelar). */
  function clearTrack() {
    track.innerHTML = '';
  }

  /** Easing cúbico ease-out. */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  /**
   * Ejecuta la animación de slot-machine.
   * @param {Array}   pool         Pool de participantes (puede ser filtrado)
   * @param {object}  winner       Ganador pre-seleccionado
   * @param {object}  signal       { cancelled: boolean } — para cancelación externa
   * @returns {Promise<object|null>}  Ganador, o null si fue cancelado
   */
  function spin(pool, winner, signal) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let   timerId;

      function tick() {
        // ── Verificar cancelación ─────────────────────────
        if (signal.cancelled) {
          clearTimeout(timerId);
          clearTrack();
          resolve(null);  // null = sorteo cancelado
          return;
        }

        const elapsed  = Date.now() - startTime;
        const progress = Math.min(elapsed / DURATION_MS, 1);
        const eased    = easeOutCubic(progress);
        const interval = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * eased;

        if (progress < 1) {
          const idx = RandomPicker.secureRandomInt(pool.length);
          renderItem(previewText(pool[idx]), interval);
          timerId = setTimeout(tick, interval);
        } else {
          // Mostrar ganador final
          renderItem(finalText(winner), SPEED_MAX);
          setTimeout(() => resolve(winner), 300);
        }
      }

      tick();
    });
  }

  return { spin };
})();


/* ================================================================
   5. WINNER DISPLAY
   Muestra el ganador, acumula historial y lanza confetti.
   ================================================================ */
const WinnerDisplay = (() => {

  const winnerNameEl = document.getElementById('winnerName');
  const winnerMetaEl = document.getElementById('winnerMeta');
  const historySection = document.getElementById('historySection');
  const historyList    = document.getElementById('historyList');

  /**
   * Muestra el ganador en la tarjeta principal.
   * @param {object} winner
   * @param {number} totalParticipants  Total cargados
   * @param {number} poolSize           Pool disponible (puede ser menor si se excluyen)
   */
  function show(winner, totalParticipants, poolSize) {
    const ticketNum = winner.numero ?? winner.ticket ?? winner.boleto ?? winner.number ?? null;
    const buyerName = winner.comprador ?? winner.nombre ?? winner.name ?? '—';

    if (ticketNum !== null) {
      winnerNameEl.innerHTML =
        `<span class="winner-ticket"># ${esc(String(ticketNum))}</span>` +
        `<span class="winner-buyer">${esc(buyerName)}</span>`;
    } else {
      winnerNameEl.innerHTML = `<span class="winner-buyer">${esc(buyerName)}</span>`;
    }

    const poolInfo = poolSize < totalParticipants
      ? `Pool de ${poolSize} disponibles · ${totalParticipants} en total`
      : `Seleccionado de ${totalParticipants} participantes`;
    winnerMetaEl.textContent = poolInfo;
  }

  /**
   * Agrega una entrada al historial y lo muestra.
   * @param {Array} history  Array de { winner, round } en orden DESC
   */
  function renderHistory(history) {
    if (!history.length) {
      toggle(historySection, false);
      return;
    }
    toggle(historySection, true);

    // Reconstruir lista completa
    historyList.innerHTML = '';
    history.forEach(({ winner, round }) => {
      const ticketNum = winner.numero ?? winner.ticket ?? winner.boleto ?? winner.number ?? null;
      const buyerName = winner.comprador ?? winner.nombre ?? winner.name ?? '—';

      const item = document.createElement('div');
      item.className = 'history-item';
      item.setAttribute('role', 'listitem');
      item.innerHTML =
        `<span class="history-round">Ronda ${round}</span>` +
        (ticketNum !== null ? `<span class="history-ticket">#${esc(String(ticketNum))}</span>` : '') +
        `<span class="history-name">${esc(buyerName)}</span>`;
      historyList.appendChild(item);
    });
  }

  /**
   * Lanza varios bursts de confetti.
   */
  function celebrate() {
    const d = { zIndex: 9999, disableForReducedMotion: true };
    confetti({ ...d, particleCount: 120, spread: 80, origin: { x: .5, y: .55 },
               colors: ['#7c3aed', '#ec4899', '#fbbf24', '#10b981', '#f59e0b'] });
    setTimeout(() => confetti({ ...d, particleCount: 60, spread: 55, angle: 60,  origin: { x: .1, y: .6 } }), 300);
    setTimeout(() => confetti({ ...d, particleCount: 60, spread: 55, angle: 120, origin: { x: .9, y: .6 } }), 500);
    setTimeout(() => confetti({ ...d, particleCount: 80, spread: 100, origin: { x: .5, y: .3 },
                                scalar: 1.3, shapes: ['star'], colors: ['#fbbf24', '#fde68a', '#f59e0b'] }), 800);
  }

  return { show, renderHistory, celebrate };
})();


/* ================================================================
   6. APP — CONTROLADOR PRINCIPAL
   ================================================================ */
const App = (() => {

  // ── Estado ───────────────────────────────────────────────────────
  let participants   = [];        // Lista completa de participantes
  let isDrawing      = false;     // Previene doble-click
  let drawSignal     = null;      // Señal de cancelación para Roulette
  let excludedSet    = new Set(); // Índices de ganadores anteriores (en participants[])
  let winnerHistory  = [];        // [{ winner, round }, ...] — más reciente primero

  // ── DOM ──────────────────────────────────────────────────────────
  const fileInput      = document.getElementById('fileInput');
  const uploadDropZone = document.getElementById('uploadDropZone');
  const uploadProgress = document.getElementById('uploadProgress');
  const progressBar    = document.getElementById('progressBar');
  const uploadStatus   = document.getElementById('uploadStatus');
  const uploadSection  = document.getElementById('uploadSection');
  const counterSection = document.getElementById('counterSection');
  const counterNumber  = document.getElementById('counterNumber');
  const previewSection = document.getElementById('previewSection');
  const previewDetails = document.getElementById('previewDetails');
  const previewGrid    = document.getElementById('previewGrid');
  const previewPoolBadge = document.getElementById('previewPoolBadge');
  const drawSection    = document.getElementById('drawSection');
  const drawBtn        = document.getElementById('drawBtn');
  const drawHint       = document.getElementById('drawHint');
  const excludeCheck   = document.getElementById('excludeCheck');
  const excludeCount   = document.getElementById('excludeCount');
  const changeListBtn  = document.getElementById('changeListBtn');
  const rouletteSection = document.getElementById('rouletteSection');
  const cancelBtn      = document.getElementById('cancelBtn');
  const winnerSection  = document.getElementById('winnerSection');
  const copyBtn        = document.getElementById('copyBtn');
  const drawAgainBtn   = document.getElementById('drawAgainBtn');
  const resetBtn       = document.getElementById('resetBtn');

  // ── Helpers ──────────────────────────────────────────────────────

  function setStatus(msg, type = '') {
    uploadStatus.textContent = msg;
    uploadStatus.className   = `upload-status ${type}`;
  }

  function animateCounter(target) {
    const dur   = 800;
    const start = performance.now();
    const from  = parseInt(counterNumber.textContent, 10) || 0;
    function step(now) {
      const p = Math.min((now - start) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3);
      counterNumber.textContent = Math.round(from + (target - from) * e);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /**
   * Devuelve el pool de participantes disponibles.
   * Si "excluir ganadores" está activo, filtra los ya sorteados.
   */
  function getPool() {
    if (excludeCheck.checked && excludedSet.size > 0) {
      return participants.filter((_, i) => !excludedSet.has(i));
    }
    return participants;
  }

  /** Actualiza el badge del pool en el panel preview. */
  function updatePoolBadge() {
    const pool = getPool();
    const excluded = excludedSet.size;
    previewPoolBadge.textContent = excluded > 0
      ? `${pool.length} disponibles · ${excluded} excluidos`
      : `${participants.length} participantes`;
    toggle(previewPoolBadge, true);
  }

  /** Actualiza el contador de excluidos visible junto al checkbox. */
  function updateExcludeCount() {
    if (excludedSet.size > 0) {
      excludeCount.textContent = `${excludedSet.size} excluidos`;
      toggle(excludeCount, true);
    } else {
      toggle(excludeCount, false);
    }
    updatePoolBadge();
  }

  /** Actualiza el hint bajo el botón sortear. */
  function updateDrawHint() {
    const pool = getPool();
    if (pool.length === 0) {
      drawHint.textContent = '⚠️ No quedan participantes disponibles. Desactivá la exclusión o cambiá la lista.';
      drawBtn.disabled = true;
    } else {
      drawHint.textContent = `La ruleta girará 5 segundos · Pool: ${pool.length} participante${pool.length !== 1 ? 's' : ''}`;
      drawBtn.disabled = isDrawing;
    }
  }

  // ── Preview Panel ────────────────────────────────────────────────

  /**
   * Construye la grilla de participantes.
   * Llama a esto cuando se carga un archivo o se reinicia el historial.
   */
  function buildPreviewGrid() {
    previewGrid.innerHTML = '';
    participants.forEach((p, i) => {
      const num  = p.numero ?? p.ticket ?? p.boleto ?? p.number ?? null;
      const name = p.comprador ?? p.nombre ?? p.name ?? '';
      const item = document.createElement('div');
      item.className = 'preview-item';
      item.setAttribute('role', 'listitem');
      item.dataset.index = i;
      if (num !== null) {
        item.innerHTML =
          `<span class="preview-num">#${esc(String(num))}</span>` +
          `<span class="preview-name">${esc(name)}</span>`;
      } else {
        item.innerHTML = `<span class="preview-name">${esc(name)}</span>`;
      }
      if (excludedSet.has(i)) item.classList.add('drawn');
      previewGrid.appendChild(item);
    });
    updatePoolBadge();
  }

  /**
   * Marca como "sorteados" los items del grid que ya están en excludedSet.
   * Más eficiente que reconstruir todo el grid.
   */
  function markDrawnInGrid() {
    previewGrid.querySelectorAll('.preview-item').forEach(item => {
      const idx = parseInt(item.dataset.index, 10);
      if (excludedSet.has(idx)) item.classList.add('drawn');
    });
    updatePoolBadge();
  }

  // ── Carga de archivo ─────────────────────────────────────────────

  async function handleFile(file) {
    // FIX: validar extensión antes de arrancar la UI
    if (!FileLoader.isValidExtension(file)) {
      setStatus('❌ Formato no soportado. Usá .xlsx o .json', 'error');
      return;
    }

    uploadProgress.classList.add('visible');
    progressBar.style.width = '0%';
    setStatus('Leyendo archivo...', '');

    try {
      let fakeProgress = 0;
      const ticker = setInterval(() => {
        fakeProgress = Math.min(fakeProgress + 8, 85);
        progressBar.style.width = `${fakeProgress}%`;
      }, 80);

      const loaded = await FileLoader.load(file);

      clearInterval(ticker);
      progressBar.style.width = '100%';

      // Resetear estado
      participants  = loaded;
      excludedSet   = new Set();
      winnerHistory = [];
      isDrawing     = false;

      setStatus(`✅ "${file.name}" cargado — ${participants.length} participantes.`, 'success');
      SoundSystem.play('upload');

      // Mostrar secciones
      toggle(counterSection, true);
      animateCounter(participants.length);
      toggle(previewSection, true);
      buildPreviewGrid();
      toggle(drawSection, true);
      updateDrawHint();

      // Ocultar secciones de sorteo previas
      toggle(rouletteSection, false);
      toggle(winnerSection, false);

    } catch (err) {
      progressBar.style.width = '0%';
      setStatus(`❌ ${err.message}`, 'error');
      console.error('[FileLoader]', err);
    } finally {
      setTimeout(() => uploadProgress.classList.remove('visible'), 600);
      fileInput.value = '';
    }
  }

  // ── Sorteo ───────────────────────────────────────────────────────

  async function runDraw() {
    if (isDrawing) return;

    const pool = getPool();
    if (pool.length === 0) {
      updateDrawHint();
      return;
    }

    isDrawing = true;
    drawBtn.disabled = true;
    SoundSystem.play('draw');

    // ── 1. Seleccionar ganador ANTES de la animación ───────────────
    const { winner } = RandomPicker.pick(pool);

    // Encontrar índice en el array ORIGINAL de participants
    const originalIndex = participants.indexOf(winner);

    // ── Plan B: consola ANTES de la animación ─────────────────────
    const _num  = winner.numero ?? winner.ticket ?? winner.boleto ?? winner.number ?? '—';
    const _name = winner.comprador ?? winner.nombre ?? winner.name ?? '—';
    console.log('%c🏆 GANADOR DEL SORTEO:', 'font-size:16px;color:#fbbf24;font-weight:bold;');
    console.log('%cNúmero: ' + _num,  'font-size:26px;color:#fbbf24;font-weight:900;');
    console.log('%c'         + _name, 'font-size:22px;color:#10b981;font-weight:900;');
    console.log('Datos completos:', winner);
    console.log('Seleccionado de ' + pool.length + ' disponibles (' + participants.length + ' total).');

    // ── 2. Mostrar ruleta ──────────────────────────────────────────
    toggle(drawSection, false);
    toggle(winnerSection, false);
    toggle(rouletteSection, true);
    rouletteSection.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // ── 3. Animar ruleta (cancellable) ────────────────────────────
    drawSignal = { cancelled: false };
    const result = await Roulette.spin(pool, winner, drawSignal);

    // ── 4a. Cancelado ─────────────────────────────────────────────
    if (result === null) {
      toggle(rouletteSection, false);
      toggle(drawSection, true);
      isDrawing    = false;
      drawSignal   = null;
      drawBtn.disabled = false;
      updateDrawHint();
      drawSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // ── 4b. Ganador revelado ───────────────────────────────────────
    // Registrar en excluidos e historial
    excludedSet.add(originalIndex);
    winnerHistory.unshift({ winner, round: winnerHistory.length + 1 });

    await new Promise(r => setTimeout(r, 400));  // pausa dramática

    toggle(rouletteSection, false);

    WinnerDisplay.show(winner, participants.length, pool.length);
    WinnerDisplay.renderHistory(winnerHistory);
    SoundSystem.play('winner');
    toggle(winnerSection, true);
    winnerSection.scrollIntoView({ behavior: 'smooth', block: 'center' });

    WinnerDisplay.celebrate();

    // Actualizar preview (tachar ganador)
    markDrawnInGrid();
    updateExcludeCount();
    updateDrawHint();

    isDrawing  = false;
    drawSignal = null;
  }

  /** Cancela el sorteo en curso. */
  function cancelDraw() {
    if (drawSignal) {
      drawSignal.cancelled = true;
      SoundSystem.play('cancel');
    }
  }

  /**
   * "Sortear de nuevo" — vuelve al botón sortear sin perder la lista ni el historial.
   */
  function drawAgain() {
    toggle(winnerSection, false);
    toggle(drawSection, true);
    updateDrawHint();
    drawSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /**
   * Reset completo — vuelve a la pantalla de carga.
   * Equivalente a recargar pero sin perder el CDN ya descargado.
   */
  function fullReset() {
    SoundSystem.play('reset');
    participants  = [];
    excludedSet   = new Set();
    winnerHistory = [];
    isDrawing     = false;
    drawSignal    = null;

    toggle(counterSection, false);
    toggle(previewSection, false);
    toggle(drawSection, false);
    toggle(rouletteSection, false);
    toggle(winnerSection, false);

    counterNumber.textContent = '0';
    previewGrid.innerHTML     = '';
    setStatus('', '');
    drawBtn.disabled = false;

    uploadSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ── Eventos ──────────────────────────────────────────────────────

  function bindEvents() {
    // Input de archivo
    fileInput.addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) handleFile(f);
    });

    // ── Drag & Drop sobre la zona de carga ────────────────────────
    uploadDropZone.addEventListener('dragover', e => {
      e.preventDefault();
      uploadDropZone.classList.add('dragover');
    });

    // FIX: dragleave con hijos — verificar relatedTarget para evitar parpadeo
    uploadDropZone.addEventListener('dragleave', e => {
      // Si el cursor se mueve a un hijo del drop-zone, NO quitar la clase
      if (uploadDropZone.contains(e.relatedTarget)) return;
      uploadDropZone.classList.remove('dragover');
    });

    uploadDropZone.addEventListener('drop', e => {
      e.preventDefault();
      uploadDropZone.classList.remove('dragover');
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    // ── Drop global (sobre cualquier parte de la ventana) ─────────
    // FIX: validar extensión antes de arrancar la UI
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      // Solo procesar si tiene extensión válida
      if (f && FileLoader.isValidExtension(f)) handleFile(f);
    });

    // Botón sortear
    drawBtn.addEventListener('click', runDraw);

    // Cancelar sorteo (botón)
    cancelBtn.addEventListener('click', cancelDraw);

    // Sortear de nuevo (misma lista)
    drawAgainBtn.addEventListener('click', drawAgain);

    // Cambiar lista (reset completo) — botón en draw-section
    changeListBtn.addEventListener('click', fullReset);

    // Cambiar lista — botón en winner-section
    resetBtn.addEventListener('click', fullReset);

    // Checkbox excluir ganadores
    excludeCheck.addEventListener('change', () => {
      updateExcludeCount();
      updateDrawHint();
    });

    // Copiar nombre del ganador
    copyBtn.addEventListener('click', () => {
      const nameEl = document.getElementById('winnerName');
      const text   = nameEl.textContent;
      navigator.clipboard.writeText(text).then(() => {
        SoundSystem.play('copy');
        copyBtn.textContent = '✅ ¡Copiado!';
        setTimeout(() => { copyBtn.textContent = '📋 Copiar nombre'; }, 2000);
      }).catch(() => {
        SoundSystem.play('cancel');
        copyBtn.textContent = '❌ Error';
        setTimeout(() => { copyBtn.textContent = '📋 Copiar nombre'; }, 2000);
      });
    });

    // ── Teclado ───────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
      // Enter → sortear (si el botón está visible y habilitado)
      if (e.key === 'Enter' && !drawSection.hidden && !drawBtn.disabled && !isDrawing) {
        runDraw();
      }
      // Escape → cancelar sorteo en curso
      if (e.key === 'Escape' && isDrawing) {
        cancelDraw();
      }
    });
  }

  // ── Init ─────────────────────────────────────────────────────────

  function init() {
    ParticleBackground.init(35);
    bindEvents();
    console.log('%c🎰 Sorteo de Rifa v3 — App iniciada', 'font-size:14px;color:#7c3aed;font-weight:bold;');
    console.log('Rejection sampling activo. Distribución matemáticamente uniforme.');
  }

  return { init };
})();

// ── Bootstrap ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', App.init);
