// Calidad gráfica. En móvil se baja para que la GPU no pierda el contexto WebGL.
// Se puede forzar con ?q=low o ?q=high en la URL.
export type Quality = 'high' | 'low';

function stored() {
  try {
    return localStorage.getItem('billar-quality');
  } catch {
    return null;
  }
}

const param = new URLSearchParams(location.search).get('q');

export const quality: Quality =
  param === 'high' || param === 'low'
    ? param
    : stored() === 'low'
      ? 'low'
      : matchMedia('(pointer: coarse)').matches
        ? 'low'
        : 'high';

export const low = quality === 'low';

/** Recuerda la calidad baja para las próximas visitas (se usa tras perder el contexto gráfico). */
export function rememberLowQuality() {
  try {
    localStorage.setItem('billar-quality', 'low');
  } catch {
    /* sin almacenamiento: solo vale para esta carga */
  }
}
