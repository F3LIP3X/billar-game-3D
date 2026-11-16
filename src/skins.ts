// Tienda de skins (mesas, palos y paños): se desbloquean con victorias, la elegida se guarda
// en localStorage y cualquiera, también las bloqueadas, se puede probar en la mesa real.
import type * as THREE from 'three';
import { sounds } from './audio';
import { setCueColors } from './balls';
import { bindSheet } from './sheets';
import { setFeltColor, setWoodSkin, type WoodSkin } from './textures';

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
type CueSkin = Skin & { c1: string; c2: string };
type FeltSkin = Skin & { color: string | null };

// Para añadir o renombrar skins, edita estas listas. La primera de cada una es la de serie.
// Mesas: `file` es una imagen de /public/textures; `dark` y `light` recolorean la veta del cerezo.
const TABLE_SKINS: TableSkin[] = [
  { id: 'cherry', name: 'Cerezo', wins: 0 },
  { id: 'nogal', name: 'Nogal', wins: 2, dark: '#24130a', light: '#7c5231' },
  { id: 'arce', name: 'Arce', wins: 5, dark: '#a67a42', light: '#ecd3a2' },
  { id: 'cherry2', name: 'Ébano', wins: 7, dark: '#09090b', light: '#3d3d46' },
  { id: 'cherry3', name: 'Amatista', wins: 15, dark: '#1d0b33', light: '#6b3fa3' },
  { id: 'lacada', name: 'Lacada', wins: 22, dark: '#b7b2a8', light: '#f5f2ea' },
  { id: 'cherry4', name: 'Vaca', wins: 30, file: 'cherry4.webp' },
];
// Palos: c1 = madera clara (eje y antebrazo), c2 = madera oscura (picos, anillos y culata)
const CUE_SKINS: CueSkin[] = [
  { id: 'cerezo', name: 'Cerezo', c1: '#e4cc98', c2: '#17100c', wins: 0 },
  { id: 'nogal', name: 'Nogal', c1: '#c9a06c', c2: '#3a2212', wins: 1 },
  { id: 'ebano', name: 'Ébano', c1: '#5a5a64', c2: '#141418', wins: 3 },
  { id: 'rubi', name: 'Rubí', c1: '#ead9b5', c2: '#7a1422', wins: 6 },
  { id: 'dorado', name: 'Dorado', c1: '#f6e3a1', c2: '#b8923f', wins: 10 },
  { id: 'zafiro', name: 'Zafiro', c1: '#dfe3ea', c2: '#143a7a', wins: 14 },
  { id: 'carbono', name: 'Carbono', c1: '#8fa3b8', c2: '#1b2733', wins: 20 },
];
// Paños: color null = el azul original
const FELT_SKINS: FeltSkin[] = [
  { id: 'azul', name: 'Azul', color: null, wins: 0 },
  { id: 'arena', name: 'Arena', color: '#a9844e', wins: 3 },
  { id: 'verde', name: 'Verde', color: '#085c1d', wins: 5 },
  { id: 'burdeos', name: 'Burdeos', color: '#6b1220', wins: 8 },
  { id: 'blanco', name: 'Lila', color: '#cc80f0', wins: 12 },
  { id: 'turquesa', name: 'Turquesa', color: '#0a6a70', wins: 18 },
  { id: 'negro', name: 'Negro', color: '#2b2b2e', wins: 25 },
];

const customSheet = document.querySelector<HTMLDivElement>('#custom')!;

export function initSkins(scene: THREE.Object3D, cue: THREE.Group) {
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
  const woodCss = (t: TableSkin) =>
    t.dark && t.light
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
  const cueShelf: Shelf<CueSkin> = makeShelf(
    'cues',
    'billar-cue-skin',
    CUE_SKINS,
    'cue-prev',
    (el, s) => {
      el.style.setProperty('--c1', s.c1);
      el.style.setProperty('--c2', s.c2);
    },
    (s) => setCueColors(cue, s.c1, s.c2),
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
    (s) => setFeltColor(scene, s.color),
  );
  const shelves: Shelf[] = [tableShelf, cueShelf, feltShelf];

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
      renderCustom();
    },
    close() {
      document.body.classList.remove('customizing');
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
    /** En la pestaña de palos el taco se enseña sobre la mesa. */
    showingCue: () => !customSheet.hidden && customTab === 'cues',
  };
}
