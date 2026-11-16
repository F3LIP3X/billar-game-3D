// Tienda de skins (mesas, bolas, palos y paños): se desbloquean con victorias, la elegida se guarda
// en localStorage y cualquiera, también las bloqueadas, se puede probar en la mesa real.
import type * as THREE from 'three';
import { sounds } from './audio';
import { ballThumb, setBallStyle, setCueColors, type BallStyle, type CueArt } from './balls';
import { bindSheet } from './sheets';
import { setFeltColor, setWoodSkin, woodArt, type FeltArt, type WoodSkin } from './textures';

const WINS_KEY = 'billar-wins';

function readStore(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sin almacenamiento: en esta sesión se mantiene, pero no se recuerda */
  }
}

let wins = Math.max(0, parseInt(readStore(WINS_KEY) ?? '0', 10) || 0);

interface Skin {
  id: string;
  name: string;
  wins: number; // victorias necesarias para desbloquearla
}
type TableSkin = Skin & WoodSkin;
type CueSkin = Skin & { c1: string; c2: string; art?: CueArt };
type FeltSkin = Skin & { color: string | null; art?: FeltArt };
type BallSkin = Skin & { id: BallStyle };

// Para añadir o renombrar skins, edita estas listas. La primera de cada una es la de serie.
// Mesas: `file` es una imagen de /public/textures; `dark` y `light` recolorean la veta del cerezo;
// `art` pinta un dibujo (pixel, dots, stripes, carbon o galaxy) con `colors`.
const TABLE_SKINS: TableSkin[] = [
  { id: 'cherry', name: 'Cerezo', wins: 0 },
  { id: 'nogal', name: 'Nogal', wins: 2, dark: '#24130a', light: '#7c5231' },
  { id: 'pixel', name: 'Píxel', wins: 4, art: 'pixel', colors: ['#3f8f3a', '#57a84a', '#2f6e2c', '#6b4a2b', '#7d5a36'] },
  { id: 'toon', name: 'Cartoon', wins: 6, art: 'dots', colors: ['#ffcf33', '#ff5a4d', '#1b1b1b'] },
  { id: 'cherry2', name: 'Ébano', wins: 7, dark: '#09090b', light: '#3d3d46' },
  { id: 'candy', name: 'Caramelo', wins: 10, art: 'stripes', colors: ['#fff4f6', '#ff4f8b'] },
  { id: 'arcade', name: 'Arcade', wins: 13, art: 'pixel', colors: ['#0b0b1a', '#0b0b1a', '#15153a', '#ff2bd6', '#22e6ff'] },
  { id: 'cherry3', name: 'Cómic', wins: 15, art: 'dots', colors: ['#6b3fa3', '#ffe14d', '#1b1b1b'] },
  { id: 'galaxia', name: 'Galaxia', wins: 18, art: 'galaxy', colors: ['#140c33', '#ffffff', '#b9a4ff', '#7fd6ff'] },
  { id: 'carbono', name: 'Carbono', wins: 20, art: 'carbon' },
  { id: 'cherry4', name: 'Vaca', wins: 30, file: 'cherry4.webp' },
];
// Bolas: mismos colores y números, otro trazo
const BALL_SKINS: BallSkin[] = [
  { id: 'classic', name: 'Clásicas', wins: 0 },
  { id: 'toon', name: 'Cartoon', wins: 3 },
  { id: 'pixel', name: 'Píxel', wins: 9 },
  { id: 'neon', name: 'Neón', wins: 16 },
];
// Palos: c1 = madera clara (eje y antebrazo), c2 = madera oscura (picos, anillos y culata).
// Con `art` el palo lleva un dibujo en vez de veta y c1/c2 son sus colores.
const CUE_SKINS: CueSkin[] = [
  { id: 'cerezo', name: 'Cerezo', c1: '#e4cc98', c2: '#17100c', wins: 0 },
  { id: 'nogal', name: 'Nogal', c1: '#c9a06c', c2: '#3a2212', wins: 1 },
  { id: 'ebano', name: 'Ébano', c1: '#5a5a64', c2: '#141418', wins: 3 },
  { id: 'pixel', name: 'Píxel', c1: '#57a84a', c2: '#6b4a2b', art: 'pixel', wins: 4 },
  { id: 'toon', name: 'Cartoon', c1: '#ffcf33', c2: '#ff5a4d', art: 'toon', wins: 8 },
  { id: 'dorado', name: 'Dorado', c1: '#f6e3a1', c2: '#b8923f', wins: 10 },
  { id: 'galaxia', name: 'Galaxia', c1: '#b9a4ff', c2: '#140c33', art: 'galaxy', wins: 14 },
  { id: 'carbono', name: 'Carbono', c1: '#30343c', c2: '#d23a2b', art: 'carbon', wins: 20 },
];
// Paños: color null = el azul original; `art` cambia la fibra lisa por un dibujo
const FELT_SKINS: FeltSkin[] = [
  { id: 'azul', name: 'Azul', color: null, wins: 0 },
  { id: 'arena', name: 'Arena', color: '#a9844e', wins: 3 },
  { id: 'pixel', name: 'Píxel', color: '#3f9a3a', art: 'pixel', wins: 4 },
  { id: 'verde', name: 'Verde', color: '#085c1d', wins: 5 },
  { id: 'burdeos', name: 'Burdeos', color: '#6b1220', wins: 8 },
  { id: 'blanco', name: 'Lila', color: '#cc80f0', wins: 12 },
  { id: 'galaxia', name: 'Galaxia', color: '#3b2a8a', art: 'galaxy', wins: 14 },
  { id: 'turquesa', name: 'Turquesa', color: '#0a6a70', wins: 18 },
  { id: 'carbono', name: 'Carbono', color: '#4a4e57', art: 'carbon', wins: 20 },
  { id: 'negro', name: 'Negro', color: '#2b2b2e', wins: 25 },
];

const customSheet = document.querySelector<HTMLDivElement>('#custom')!;

export function initSkins(scene: THREE.Object3D, cue: THREE.Group, onToggle: (open: boolean) => void) {
  const customNote = customSheet.querySelector<HTMLParagraphElement>('#custom-note')!;
  let customTab = 'tables';

  /** Una pestaña de la tienda: su lista, lo equipado y lo que se está probando sin tenerlo. */
  interface Shelf<S extends Skin = Skin> {
    key: string;
    skins: S[];
    grid: HTMLElement;
    thumb: string;
    equipped: S;
    trying: S | null;
    paint(el: HTMLElement, s: S): void; // variables CSS de la miniatura
    apply(s: S): void; // la pone en la mesa real
  }

  function makeShelf<S extends Skin>(
    tab: string,
    key: string,
    skins: S[],
    thumb: string,
    paint: (el: HTMLElement, s: S) => void,
    apply: (s: S) => void,
  ): Shelf<S> {
    // Si la guardada ya no existe o sigue bloqueada, se vuelve a la de serie
    const saved = skins.find((s) => s.id === readStore(key));
    const equipped = saved && saved.wins <= wins ? saved : skins[0];
    if (equipped !== skins[0]) apply(equipped);
    return { key, skins, grid: customSheet.querySelector<HTMLElement>(`#tab-${tab}`)!, thumb, equipped, trying: null, paint, apply };
  }

  const texUrl = (file: string) => `${import.meta.env.BASE_URL}textures/${file}`;
  const thumbs = new Map<string, string>(); // las miniaturas dibujadas se guardan: se piden en cada repintado
  const cached = (key: string, make: () => string) => thumbs.get(key) ?? thumbs.set(key, make()).get(key)!;
  const woodCss = (t: TableSkin) =>
    t.art
      ? `url(${cached(t.id, () => woodArt(t)!.toDataURL())}) 0 0 / 96px 48px`
      : t.dark && t.light
      ? `repeating-linear-gradient(94deg, ${t.dark}, ${t.light} 9px, ${t.dark} 19px)`
      : `url(${texUrl(t.file ?? 'cherry.webp')}) center / cover`;
  const feltCss = (f: FeltSkin) => f.color ?? '#1d3f7a';
  // Las miniaturas de mesa y paño enseñan la combinación con lo que ya se ve en la otra pestaña
  const shown = <S extends Skin>(sh: Shelf<S>) => sh.trying ?? sh.equipped;

  const tableShelf: Shelf<TableSkin> = makeShelf(
    'tables',
    'billar-table-skin',
    TABLE_SKINS,
    'table-prev',
    (el, s) => {
      el.style.setProperty('--wood', woodCss(s));
      el.style.setProperty('--felt', feltCss(shown(feltShelf)));
    },
    setWoodSkin,
  );
  const ballShelf: Shelf<BallSkin> = makeShelf(
    'balls',
    'billar-ball-skin',
    BALL_SKINS,
    'ball-prev',
    (el, s) => [1, 8, 11].forEach((n, i) => el.style.setProperty(`--b${i}`, `url(${cached(`ball${n}${s.id}`, () => ballThumb(n, s.id))})`)),
    (s) => setBallStyle(s.id, scene),
  );
  const cueShelf: Shelf<CueSkin> = makeShelf(
    'cues',
    'billar-cue-skin',
    CUE_SKINS,
    'cue-prev',
    (el, s) => {
      el.style.setProperty('--c1', s.c1);
      el.style.setProperty('--c2', s.c2);
    },
    (s) => setCueColors(cue, s.c1, s.c2, s.art),
  );
  const feltShelf: Shelf<FeltSkin> = makeShelf(
    'felt',
    'billar-felt-skin',
    FELT_SKINS,
    'table-prev',
    (el, s) => {
      el.style.setProperty('--wood', woodCss(shown(tableShelf)));
      el.style.setProperty('--felt', feltCss(s));
    },
    (s) => setFeltColor(scene, s.color, s.art),
  );
  const shelves: Shelf[] = [tableShelf, ballShelf, cueShelf, feltShelf];

  const lockIcon =
    '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  function renderShelf(sh: Shelf) {
    sh.grid.replaceChildren();
    for (const s of sh.skins) {
      const locked = wins < s.wins;
      const equipped = s === sh.equipped;
      const trying = s === sh.trying;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'item' + (locked ? ' locked' : '') + (equipped ? ' equipped' : '') + (trying ? ' trying' : '');
      el.setAttribute('aria-pressed', String(equipped));
      sh.paint(el, s);
      const req = locked ? `${wins} de ${s.wins} victorias` : s.wins === 0 ? 'De serie' : `Desbloqueado con ${s.wins} victorias`;
      const badge = equipped ? 'Equipado' : trying ? 'Probando' : locked ? `${lockIcon}Probar` : 'Equipar';
      el.innerHTML =
        `<div class="preview ${sh.thumb}"><i></i></div><h3>${s.name}</h3><p class="req">${req}</p>` +
        (locked ? `<span class="progress" style="--p:${wins / s.wins}"></span>` : '') +
        `<span class="badge">${badge}</span>`;
      el.addEventListener('click', () => pickSkin(sh, s));
      sh.grid.append(el);
    }
  }

  function renderCustom() {
    customSheet.querySelector('.custom-wins b')!.textContent = String(wins);
    const all = shelves.flatMap((sh) => sh.skins);
    document.querySelector('#start-skins')!.textContent = `${all.filter((s) => s.wins <= wins).length}/${all.length}`;
    shelves.forEach(renderShelf);
    const trying = shelves.flatMap((sh) => sh.trying ?? []);
    customNote.hidden = !trying.length;
    customNote.textContent = `Probando ${trying.map((s) => s.name).join(', ')}: al cerrar vuelve lo que tienes equipado.`;
  }
  /** Una skin desbloqueada se equipa; una bloqueada solo se prueba en la mesa hasta cerrar la hoja. */
  function pickSkin(sh: Shelf, s: Skin) {
    sounds.ui();
    if (wins < s.wins) sh.trying = s;
    else {
      sh.equipped = s;
      sh.trying = null;
      writeStore(sh.key, s.id);
    }
    sh.apply(s);
    renderCustom();
    (sh.grid.children[sh.skins.indexOf(s)] as HTMLElement).focus(); // el repintado se llevó el foco
  }

  bindSheet('#custom', '#custom-btn', {
    open() {
      document.body.classList.add('customizing');
      onToggle(true);
      renderCustom();
    },
    close() {
      document.body.classList.remove('customizing');
      onToggle(false);
      // Lo que se estaba probando sin tenerlo se devuelve
      for (const sh of shelves) {
        if (!sh.trying) continue;
        sh.trying = null;
        sh.apply(sh.equipped);
      }
    },
  });
  const tabs = [...customSheet.querySelectorAll<HTMLButtonElement>('.custom-tab')];
  function selectTab(tab: HTMLButtonElement) {
    customTab = tab.dataset.tab!;
    for (const t of tabs) {
      const on = t === tab;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1; // con Tab se entra a la pestaña activa; entre ellas, flechas
    }
    customSheet.querySelectorAll<HTMLElement>('.custom-grid').forEach((g) => (g.hidden = g.id !== `tab-${customTab}`));
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      sounds.ui();
      selectTab(tab);
    });
    tab.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      const next = tabs[(i + dir + tabs.length) % tabs.length];
      selectTab(next);
      next.focus();
    });
  });
  selectTab(tabs[0]);
  renderCustom();

  return {
    /** Suma una victoria y devuelve el aviso de lo que desbloquea (vacío si nada). */
    addWin() {
      wins++;
      writeStore(WINS_KEY, String(wins));
      renderCustom();
      const fresh = shelves.flatMap((sh) => sh.skins).filter((s) => s.wins === wins);
      return fresh.length ? ` · ¡Desbloqueado: ${fresh.map((s) => s.name).join(', ')}!` : '';
    },
    /** Con la hoja abierta el taco se enseña sobre la mesa y la cámara se puede mover. */
    open: () => !customSheet.hidden,
  };
}
