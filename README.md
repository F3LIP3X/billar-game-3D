# Billar 3D

Juego de billar (bola 8) en el navegador. Vite + TypeScript + Three.js, con física propia.

## Arrancar

```bash
npm install
npm run dev
```

## Controles

**Escritorio**

- **Ratón**: apuntar
- **Mantener clic izquierdo**: cargar potencia; soltar para tirar
- **← / →**: ajuste fino del ángulo (con Shift, más fino)
- **Clic derecho + arrastrar**: girar la cámara · **Rueda**: zoom
- **V**: cámara detrás de la bola blanca

**Móvil**
- Toca o desliza un dedo sobre la mesa para apuntar o colocar la blanca
- Botón **Mantén para tirar**: cargar potencia y soltar para tirar
- **‹ ›** ajuste fino · **Vista** cámara tras la blanca · dos dedos: girar y zoom

## Reglas (bola 8, basadas en las de la WPA)

- Saque con bola en mano **detrás de la línea de cabecera**.
- Tras el saque la mesa queda abierta; el grupo (lisas/rayadas) se decide con la primera bola metida legalmente después.
- Meter la 8 en el saque no pierde: se recoloca en el punto de pie.
- Falta (blanca dentro, no tocar bola o tocar primero una que no toca): bola en mano para el rival en cualquier sitio (tras una falta en el saque, detrás de la línea).
- Meter la 8 con tu grupo terminado y sin falta gana; antes de tiempo o con falta, pierde.

## Estructura

- `src/physics.ts` — física 2D sobre el plano de la mesa (rodadura, choques, bandas, troneras)
- `src/rules.ts` — reglas simplificadas de bola 8 (grupos, faltas, bola en mano)
- `src/table.ts` — mesa, sala e iluminación
- `src/balls.ts` — bolas (texturas generadas en canvas) y taco
- `src/audio.ts` — sonidos sintetizados con WebAudio
- `src/main.ts` — escena, entrada y bucle de juego
