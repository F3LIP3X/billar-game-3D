import { sounds, unlockAudio } from './audio';

/**
 * Hojas del menú: todas se abren y se cierran igual (X, Esc o tocando fuera) y el foco vuelve
 * al botón que las abrió. Devuelve la función para abrirla o cerrarla desde el código.
 */
export function bindSheet(id: string, openerId: string, hooks: { open?: () => void; close?: () => void } = {}) {
  const el = document.querySelector<HTMLDivElement>(id)!;
  const opener = document.querySelector<HTMLButtonElement>(openerId)!;
  const closeBtn = el.querySelector<HTMLButtonElement>('.sheet-head .icon-btn')!;
  const set = (open: boolean) => {
    if (open === !el.hidden) return;
    el.hidden = !open;
    if (open) {
      hooks.open?.();
      closeBtn.focus();
    } else {
      hooks.close?.();
      opener.focus();
    }
  };
  opener.addEventListener('click', () => {
    unlockAudio();
    sounds.ui();
    set(true);
  });
  closeBtn.addEventListener('click', () => set(false));
  el.addEventListener('click', (e) => e.target === el && set(false));
  window.addEventListener('keydown', (e) => e.key === 'Escape' && set(false));
  return set;
}
