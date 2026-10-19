// Calidad gráfica. En móvil se baja para que la GPU no pierda el contexto WebGL.
// Se puede forzar con ?q=low o ?q=high en la URL.
export type Quality = 'high' | 'low';

function stored() {
  try {
    localStorage.removeItem('billar-quality'); // versiones anteriores la guardaban para siempre
    return sessionStorage.getItem('billar-quality');
  } catch {
    return null;
  }
}

const param = new URLSearchParams(location.search).get('q');

/**
 * El navegador dibuja sin tarjeta gráfica (aceleración por hardware desactivada o GPU bloqueada):
 * WebGL va por software (SwiftShader, llvmpipe, WARP...) y el juego iría muy lento en calidad alta.
 */
function detectNoGpu() {
  try {
    const c = document.createElement('canvas');
    // Con esta opción el navegador no da contexto si solo puede dibujar por software
    const strict = c.getContext('webgl', { failIfMajorPerformanceCaveat: true });
    const gl = strict ?? document.createElement('canvas').getContext('webgl');
    if (!gl) return true;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext(); // no ocupar un contexto de los pocos que hay
    // Manda el nombre de la GPU: la comprobación estricta da falsos positivos con algunos drivers
    if (name) return /swiftshader|llvmpipe|softpipe|software rast|basic render/i.test(name);
    return !strict;
  } catch {
    return false;
  }
}

export const noGpu = detectNoGpu();

export const quality: Quality =
  param === 'high' || param === 'low'
    ? param
    : stored() === 'low' || noGpu
      ? 'low'
      : matchMedia('(pointer: coarse)').matches
        ? 'low'
        : 'high';

export const low = quality === 'low';

/** Recuerda la calidad baja hasta cerrar la pestaña (se usa tras perder el contexto gráfico). */
export function rememberLowQuality() {
  try {
    sessionStorage.setItem('billar-quality', 'low');
  } catch {
    /* sin almacenamiento: solo vale para esta carga */
  }
}

/** Pantalla táctil como puntero principal (móvil o tableta): se juega solo en vista 2D. */
export const touch = matchMedia('(pointer: coarse)').matches;
